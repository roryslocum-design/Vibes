const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const webpush = require('web-push');

// Minimal .env loader (avoids adding a dotenv dependency) — only fills in vars
// that aren't already set in the real environment.
(() => {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
})();

// VAPID setup — generate keys once if not set, persist to .env
(() => {
  const envPath = path.join(__dirname, ".env");
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    // Persist so they survive restarts
    const line1 = `VAPID_PUBLIC_KEY=${keys.publicKey}`;
    const line2 = `VAPID_PRIVATE_KEY=${keys.privateKey}`;
    try {
      let existing = '';
      if (fs.existsSync(envPath)) existing = fs.readFileSync(envPath, 'utf8');
      if (!existing.includes('VAPID_PUBLIC_KEY')) {
        fs.writeFileSync(envPath, existing + (existing.endsWith('\n') ? '' : '\n') + line1 + '\n' + line2 + '\n');
      }
    } catch (e) {}
  }
  webpush.setVapidDetails(
    'mailto:rory.slocum@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
})();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const defaultDbDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : (process.env.VERCEL ? os.tmpdir() : __dirname);
const DB_PATH = process.env.DB_PATH || path.join(defaultDbDir, "vibes.db");
const HTML_PATH = path.join(__dirname, "index.html");
// --- Express Middleware ---
// Enable CORS for all routes (you might want to restrict this in production)
app.use(cors({
  origin: '*',
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  allowedHeaders: ['Content-Type', 'x-username', 'x-password'],
}));
// Middleware to parse JSON request bodies
app.use(express.json());
// --- Database Initialization ---
// Ensure the directory for the DB exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db;
let dbInitialized = false;
let dbPromise;

// Initialize DB promise immediately
async function initializeDb() {
  if (!dbInitialized) {
    db = await setupDb();
    dbInitialized = true;
  }
  return db;
}

dbPromise = initializeDb();

// Middleware to ensure DB is ready before handling requests
app.use((req, res, next) => {
  if (dbInitialized) {
    next();
  } else {
    dbPromise.then(() => next()).catch((err) => {
      console.error('DB initialization error:', err);
      res.status(500).json({ error: 'Database initialization failed' });
    });
  }
});


function initDb(dbPath) {
  return new Database(dbPath);
}

async function setupDb() {
  db = initDb(DB_PATH);
  db.exec(`PRAGMA journal_mode = WAL;`);

  // Create tables
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  photo_data_url TEXT,
  streaks_enabled INTEGER DEFAULT 0,
  hidden_scales TEXT DEFAULT '[]',
  avatar_color TEXT,
  plan TEXT DEFAULT 'best',
  trial_active INTEGER DEFAULT 1,
  pending_paywall INTEGER DEFAULT 0,
  ad_age TEXT,
  ad_birthdate TEXT,
  ad_gender TEXT,
  ad_hobbies TEXT,
  ad_lat TEXT,
  ad_lon TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  source_username TEXT,
  friend_index INTEGER,
  romantic_index INTEGER,
  show_romantic INTEGER DEFAULT 1,
  photo_data_url TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (owner) REFERENCES users(username)
);
CREATE INDEX IF NOT EXISTS idx_people_owner ON people(owner);
CREATE INDEX IF NOT EXISTS idx_people_source ON people(owner, source_username);

CREATE TABLE IF NOT EXISTS requests (
  from_user TEXT NOT NULL,
  to_user TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_user, to_user)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user TEXT NOT NULL,
  to_user TEXT NOT NULL,
  body TEXT NOT NULL,
  ts INTEGER NOT NULL,
  read INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(from_user, to_user, ts);
CREATE INDEX IF NOT EXISTS idx_msg_pair2 ON messages(to_user, from_user, ts);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_user TEXT NOT NULL,
  from_user TEXT NOT NULL,
  from_name TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_to ON notifications(to_user);

CREATE TABLE IF NOT EXISTS presence (
  username TEXT PRIMARY KEY,
  status TEXT DEFAULT 'away',
  last_seen INTEGER NOT NULL,
  last_active INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS typing_indicators (
  username TEXT NOT NULL,
  peer TEXT NOT NULL,
  typing_at INTEGER NOT NULL,
  PRIMARY KEY (username, peer)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  username TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  subscription TEXT NOT NULL,
  PRIMARY KEY (username, endpoint)
);
`);
try { db.exec(`ALTER TABLE people ADD COLUMN chat_expiry INTEGER DEFAULT NULL`); } catch (e) {}
try { db.exec(`ALTER TABLE presence ADD COLUMN chat_with TEXT DEFAULT NULL`); } catch (e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS reactions (msg_id INTEGER NOT NULL, username TEXT NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY (msg_id, username))`); } catch (e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS reactions2 (id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id INTEGER NOT NULL, username TEXT NOT NULL, emoji TEXT NOT NULL, UNIQUE(msg_id, username, emoji))`); } catch (e) {}
try { db.exec(`INSERT OR IGNORE INTO reactions2 (msg_id, username, emoji) SELECT msg_id, username, emoji FROM reactions`); } catch (e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS page_views (date TEXT PRIMARY KEY, count INTEGER DEFAULT 0)`); } catch (e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS pwa_installs (ts INTEGER NOT NULL)`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN avatar_color TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'best'`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN trial_active INTEGER DEFAULT 1`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN pending_paywall INTEGER DEFAULT 0`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN ad_age TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN ad_birthdate TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN ad_gender TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN ad_hobbies TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN ad_lat TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN ad_lon TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`); } catch (e) {}
// Seed is_admin for the original admin account if it exists and isn't already set
try { db.exec(`UPDATE users SET is_admin = 1 WHERE username = 'roryslocum' AND is_admin = 0`); } catch (e) {}
  return db;
}
// --- Utility Functions ---

const now = () => Math.floor(Date.now() / 1000);

// Helper for preparing statements
function prepare(query) {
    return db.prepare(query);

}

function isBcryptHash(s) {
  return typeof s === "string" && /^\$2[aby]?\$/.test(s);
}

function verifyPassword(plain, stored, username) {
  if (isBcryptHash(stored)) return bcrypt.compareSync(plain, stored);
  // Legacy plaintext password: verify directly, then transparently upgrade to bcrypt.
  if (stored !== plain) return false;
  if (username) {
    const hashed = bcrypt.hashSync(plain, 10);
    prepare("UPDATE users SET password = ? WHERE username = ?").run(hashed, username);
  }
  return true;
}

function authenticate(req) {
  // Bun used req.headers.get, Express uses req.headers['header-name']
  const u = req.headers['x-username'];
  const p = req.headers['x-password'];
  if (!u || !p) return null;
  const row = prepare("SELECT password, banned FROM users WHERE username = ?").get(u);
  if (!row || !verifyPassword(p, row.password, u)) return null;
  if (row.banned) return null;
  return u;
}

function userPublic(u) {
  return {
    username: u.username,
    displayName: u.display_name || "",
    photoDataUrl: u.photo_data_url || null,
    bio: u.bio || "",
    avatarColor: u.avatar_color || null,
  };
}

function getEffective(me, otherUsername) {
  const mine = prepare("SELECT * FROM people WHERE owner = ? AND source_username = ?").get(me, otherUsername);
  const theirs = prepare("SELECT * FROM people WHERE owner = ? AND source_username = ?").get(otherUsername, me);
  return { mine, theirs };
}

function loadPeopleForUser(username) {
  const rows = prepare("SELECT * FROM people WHERE owner = ? ORDER BY created_at ASC").all(username);
  return rows.map((p) => {
    let effectiveFriendIndex = p.friend_index;
    let effectiveRomanticIndex = (p.show_romantic && p.romantic_index != null) ? p.romantic_index : null;
    let theyRemovedRomantic = false;
    let theyHaveCommittedRomantic = false;
    if (p.source_username) {
      const theirs = prepare("SELECT * FROM people WHERE owner = ? AND source_username = ?").get(p.source_username, username);
      if (theirs) {
        if (p.friend_index != null && theirs.friend_index != null) {
          effectiveFriendIndex = Math.min(p.friend_index, theirs.friend_index);
        } else {
          effectiveFriendIndex = null;
        }
        if (theirs.show_romantic && p.show_romantic) {
          if (p.romantic_index != null && theirs.romantic_index != null) {
            effectiveRomanticIndex = Math.min(p.romantic_index, theirs.romantic_index);
          } else {
            effectiveRomanticIndex = null;
          }
        } else if (!theirs.show_romantic) {
          theyRemovedRomantic = true;
          effectiveRomanticIndex = null;
        }
        const committed = prepare("SELECT 1 FROM people WHERE owner = ? AND source_username != ? AND romantic_index >= 3 AND show_romantic = 1 LIMIT 1").get(p.source_username, username);
        if (committed) theyHaveCommittedRomantic = true;
      }
    }
    return {
      id: p.id,
      name: p.name,
      sourceUsername: p.source_username || null,
      friendIndex: p.friend_index,
      romanticIndex: p.romantic_index,
      showRomantic: !!p.show_romantic,
      photoDataUrl: p.photo_data_url || null,
      effectiveFriendIndex,
      effectiveRomanticIndex,
      theyRemovedRomantic,
      theyHaveCommittedRomantic,
    };
  });
}

function loadMeState(username) {
  const u = prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!u) return null;
  const people = loadPeopleForUser(username);
  const pendingRequests = prepare("SELECT r.from_user, r.created_at, u.username, u.display_name, u.photo_data_url FROM requests r JOIN users u ON u.username = r.from_user WHERE r.to_user = ? ORDER BY r.created_at DESC").all(username).map((r) => ({
    fromUsername: r.from_user,
    fromName: r.display_name || r.from_user,
    photoDataUrl: r.photo_data_url || null,
    createdAt: r.created_at,
  }));
  const sentRequests = prepare("SELECT r.to_user, r.created_at, u.display_name, u.photo_data_url FROM requests r JOIN users u ON u.username = r.to_user WHERE r.from_user = ? ORDER BY r.created_at DESC").all(username).map((r) => ({
    toUsername: r.to_user,
    toName: r.display_name || r.to_user,
    photoDataUrl: r.photo_data_url || null,
    createdAt: r.created_at,
  }));
  const notifs = prepare("SELECT * FROM notifications WHERE to_user = ?").all(username);
  if (notifs.length) prepare("DELETE FROM notifications WHERE to_user = ?").run(username);

  return {
    isAdmin: !!u.is_admin,
    username: u.username,
    displayName: u.display_name || "",
    photoDataUrl: u.photo_data_url || null,
    bio: u.bio || "",
    avatarColor: u.avatar_color || null,
    streaksEnabled: !!u.streaks_enabled,
    hiddenScales: JSON.parse(u.hidden_scales || "[]"),
    plan: u.plan || "best",
    trialActive: !!u.trial_active,
    pendingPaywall: !!u.pending_paywall,
    adProfile: { age: u.ad_age || null, birthdate: u.ad_birthdate || null, gender: u.ad_gender || null, hobbies: u.ad_hobbies || null, lat: u.ad_lat || null, lon: u.ad_lon || null },
    people,
    pendingRequests,
    sentRequests,
    pendingNotifications: notifs.map((n) => ({
      fromUsername: n.from_user,
      fromName: n.from_name,
      type: n.type,
      label: n.label,
    })),
  };
}

// Free-trial-of-Best ends (display-wise) once the user sends their first message or
// reaches 5 contacts, whichever comes first. We just flag it here — the plan stays
// "best" (full access continues) until the user actually sees the pricing screen on
// their next app open and either picks a plan or dismisses (which defaults to Free).
function maybeFlagTrialEnd(username) {
  // Paywall disabled
}

// Creates mutual "people" rows connecting two users as friends, if not already connected.
// Vibe scores start unrated (NULL) until the user explicitly rates them.
// Must be called from within an existing db.transaction (better-sqlite3 doesn't support nesting).
function connectUsersRaw(me, other) {
  const themUser = prepare("SELECT * FROM users WHERE username = ?").get(other);
  const myUser = prepare("SELECT * FROM users WHERE username = ?").get(me);
  if (!themUser || !myUser) throw new Error("User missing");

  const ts = now();
  const mine = prepare("SELECT * FROM people WHERE owner = ? AND source_username = ?").get(me, other);
  if (!mine) {
    prepare("INSERT INTO people (id, owner, name, source_username, friend_index, romantic_index, show_romantic, photo_data_url, created_at) VALUES (?, ?, ?, ?, NULL, NULL, 1, ?, ?)")
      .run(randomUUID(), me, themUser.display_name || themUser.username, other, themUser.photo_data_url || null, ts);
  }
  const theirs = prepare("SELECT * FROM people WHERE owner = ? AND source_username = ?").get(other, me);
  if (!theirs) {
    prepare("INSERT INTO people (id, owner, name, source_username, friend_index, romantic_index, show_romantic, photo_data_url, created_at) VALUES (?, ?, ?, ?, NULL, NULL, 1, ?, ?)")
      .run(randomUUID(), other, myUser.display_name || myUser.username, me, myUser.photo_data_url || null, ts);
  }
  maybeFlagTrialEnd(me);
  maybeFlagTrialEnd(other);
}

function connectUsers(me, other) {
  db.transaction(() => connectUsersRaw(me, other))();
  return { ok: true };
}

// Transaction-wrapped helper for acceptRequest to ensure atomicity
function acceptRequestTransaction(me, fromUser) {
  const exists = prepare("SELECT 1 FROM requests WHERE from_user = ? AND to_user = ?").get(fromUser, me);
  if (!exists) throw new Error("No such request");
  db.transaction(() => {
    prepare("DELETE FROM requests WHERE from_user = ? AND to_user = ?").run(fromUser, me);
    prepare("DELETE FROM requests WHERE from_user = ? AND to_user = ?").run(me, fromUser);
    connectUsersRaw(me, fromUser);
  })();
  return { ok: true };
}


function computeStreak(a, b) {
  const rows = prepare("SELECT ts, from_user FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY ts DESC").all(a, b, b, a);
  if (!rows.length) return 0;
  const days = new Map();
  for (const r of rows) {
    const d = new Date(r.ts * 1000);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (!days.has(key)) days.set(key, new Set());
    days.get(key).add(r.from_user);
  }
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    const s = days.get(key);
    if (s && s.has(a) && s.has(b)) streak++;
    else if (i > 0) break;
    // if today is missing, streak can still start from yesterday — allow first skip
    else continue;
  }
  return streak;
}
// --- Static Routes (for index.html, manifest, icons, etc.) ---

// Serve index.html for root, /vibes, and legacy /relations paths
app.get(['/', '/vibes', '/vibes/', '/vibes/index.html'], (req, res) => {
    try {
        const html = fs.readFileSync(HTML_PATH, "utf8");
        res.set('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(html);
    } catch (error) {
        console.error("Error reading index.html:", error);
        res.status(500).send("Error loading application.");
    }
});

// Redirect legacy /relations to /vibes
app.get(['/relations', '/relations/', '/relations/index.html'], (req, res) => {
    res.redirect(302, '/vibes/');
});

// Manifest / icon stubs
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><defs><linearGradient id="g" x1="0" y1="0" x2="192" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#ff2d55"/><stop offset="50%" stop-color="#af52de"/><stop offset="100%" stop-color="#0066ff"/></linearGradient></defs><rect width="192" height="192" rx="42" fill="#000"/><text x="96" y="96" font-family="Helvetica Neue,Helvetica,-apple-system,sans-serif" font-weight="800" font-size="130" text-anchor="middle" dominant-baseline="central" fill="url(#g)">V</text></svg>`;
const ICON_SVG_MASKABLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><defs><linearGradient id="g" x1="0" y1="0" x2="192" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#ff2d55"/><stop offset="50%" stop-color="#af52de"/><stop offset="100%" stop-color="#0066ff"/></linearGradient></defs><rect width="192" height="192" fill="#000"/><text x="96" y="96" font-family="Helvetica Neue,Helvetica,-apple-system,sans-serif" font-weight="800" font-size="130" text-anchor="middle" dominant-baseline="central" fill="url(#g)">V</text></svg>`;

// Pre-built PNGs (generated on macOS with Helvetica — font-independent on Railway)
const ICON_PNG_192 = fs.readFileSync(path.join(__dirname, 'icon-192.png'));
const ICON_PNG_512 = fs.readFileSync(path.join(__dirname, 'icon-512.png'));
const ICON_PNG_512M = fs.readFileSync(path.join(__dirname, 'icon-512-maskable.png'));
const ICON_PNG_180 = fs.readFileSync(path.join(__dirname, 'apple-touch-icon.png'));

app.get('/google14d8cddfc9a76948.html', (req, res) => res.type('text/html').send('google-site-verification: google14d8cddfc9a76948.html'));

app.get('/vibes/manifest.json', (req, res) => {
  res.json({
    name: "Vibes", short_name: "Vibes", start_url: "/vibes/", scope: "/vibes/", display: "standalone",
    background_color: "#000", theme_color: "#000",
    icons: [
      { src: "/vibes/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/vibes/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/vibes/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  });
});
// Icon routes — served at both / and /vibes/ for compatibility
for (const prefix of ['', '/vibes']) {
  app.get(prefix + '/icon.svg', (req, res) => res.type('image/svg+xml').send(ICON_SVG));
  app.get(prefix + '/icon-192.png', (req, res) => res.type('image/png').send(ICON_PNG_192));
  app.get(prefix + '/icon-512.png', (req, res) => res.type('image/png').send(ICON_PNG_512));
  app.get(prefix + '/icon-512-maskable.png', (req, res) => res.type('image/png').send(ICON_PNG_512M));
}
// iOS uses apple-touch-icon.png specifically
app.get(['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png'], (req, res) => {
  res.type('image/png').send(ICON_PNG_180);
});

// Minimal service worker — required for PWA installability (Chrome/Edge won't fire
// beforeinstallprompt without an active SW with a fetch handler), so without this the
// browser silently never offers the real one-click install and we always fell back
// to manual instructions.
app.get('/vibes/sw.js', (req, res) => {
  res.type('application/javascript').send(`
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => self.clients.claim());
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', (e) => {}); // passthrough — presence alone satisfies installability checks
`.trim());
});

// Serve other static files (CSS, client-side JS, images, etc.) from the project root
// This should be after specific routes for index.html, manifest, etc.
app.use(express.static(path.join(__dirname)));
// --- API Routes (prefixed with /vibes-api) ---

// AUTH
app.post("/vibes-api/auth/signup", (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    const uname = String(username).toLowerCase().trim();
    if (uname.length < 2) return res.status(400).json({ error: "Username too short" });
    if (String(password).length < 4) return res.status(400).json({ error: "Password too short" });
    const existing = prepare("SELECT 1 FROM users WHERE username = ?").get(uname);
    if (existing) return res.status(400).json({ error: "Username taken" });
    const hashed = bcrypt.hashSync(String(password), 10);
    prepare("INSERT INTO users (username, password, display_name, created_at) VALUES (?, ?, ?, ?)").run(uname, hashed, uname, now());
    res.json({ username: uname });
  } catch (e) {
    console.error("Error in /vibes-api/auth/signup:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

app.post("/vibes-api/auth/login", (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    const uname = String(username).toLowerCase().trim();
    const row = prepare("SELECT password FROM users WHERE username = ?").get(uname);
    if (!row || !verifyPassword(String(password), row.password, uname)) return res.status(401).json({ error: "Invalid username or password" });
    res.json({ username: uname });
  } catch (e) {
    console.error("Error in /vibes-api/auth/login:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

// Middleware for authentication (applies to all /vibes-api/* routes after this point)
app.use("/vibes-api", (req, res, next) => {
  if (req.method === 'OPTIONS') { // Handle pre-flight OPTIONS requests
      return next();
  }
  const me = authenticate(req);
  if (!me) return res.status(401).json({ error: "Unauthorized" });
  req.me = me; // Attach authenticated user (me) to the request object for later routes
  next(); // Continue to the next matching route handler
});

app.delete("/vibes-api/auth/delete", (req, res) => {
  try {
    const me = req.me; // 'me' is now available from the authentication middleware
    db.transaction(() => {
      prepare("DELETE FROM users WHERE username = ?").run(me);
      prepare("DELETE FROM people WHERE owner = ?").run(me);
      prepare("DELETE FROM people WHERE source_username = ?").run(me);
      prepare("DELETE FROM requests WHERE from_user = ? OR to_user = ?").run(me, me);
      prepare("DELETE FROM messages WHERE from_user = ? OR to_user = ?").run(me, me);
      prepare("DELETE FROM notifications WHERE to_user = ? OR from_user = ?").run(me, me);
    })();
    res.json({ ok: true });
  } catch (e) {
    console.error("Error in /vibes-api/auth/delete:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

// ME
app.get("/vibes-api/me", (req, res) => {
  try {
    const state = loadMeState(req.me);
    res.json(state);
  } catch (e) {
    console.error("Error in /vibes-api/me GET:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

app.post("/vibes-api/me/credentials", (req, res) => {
  try {
    const me = req.me;
    const { newUsername, newPassword, currentPassword } = req.body;
    const row = prepare("SELECT password FROM users WHERE username = ?").get(me);
    if (!row || !verifyPassword(currentPassword, row.password, null)) return res.status(403).json({ error: "Current password is incorrect" });
    if (newUsername && newUsername !== me) {
      const taken = prepare("SELECT 1 FROM users WHERE username = ?").get(newUsername);
      if (taken) return res.status(409).json({ error: "Username already taken" });
      if (!/^[a-z0-9_]{3,20}$/.test(newUsername)) return res.status(400).json({ error: "Username must be 3-20 characters: letters, numbers, underscores" });
      prepare("UPDATE people SET owner = ? WHERE owner = ?").run(newUsername, me);
      prepare("UPDATE people SET source_username = ? WHERE source_username = ?").run(newUsername, me);
      prepare("UPDATE messages SET from_user = ? WHERE from_user = ?").run(newUsername, me);
      prepare("UPDATE messages SET to_user = ? WHERE to_user = ?").run(newUsername, me);
      prepare("UPDATE requests SET from_user = ? WHERE from_user = ?").run(newUsername, me);
      prepare("UPDATE requests SET to_user = ? WHERE to_user = ?").run(newUsername, me);
      prepare("UPDATE presence SET username = ? WHERE username = ?").run(newUsername, me);
      prepare("UPDATE users SET username = ? WHERE username = ?").run(newUsername, me);
    }
    const targetUser = newUsername && newUsername !== me ? newUsername : me;
    if (newPassword) {
      const hashed = bcrypt.hashSync(newPassword, 10);
      prepare("UPDATE users SET password = ? WHERE username = ?").run(hashed, targetUser);
    }
    res.json({ ok: true, username: targetUser });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/vibes-api/me", (req, res) => {
  try {
    const me = req.me;
    const body = req.body;
    const updates = [];
    const params = [];
    if ("displayName" in body) { updates.push("display_name = ?"); params.push(String(body.displayName || "")); }
    if ("photoDataUrl" in body) { updates.push("photo_data_url = ?"); params.push(body.photoDataUrl || null); }
    if ("streaksEnabled" in body) { updates.push("streaks_enabled = ?"); params.push(body.streaksEnabled ? 1 : 0); }
    if ("avatarColor" in body) { updates.push("avatar_color = ?"); params.push(body.avatarColor || null); }
    if ("hiddenScales" in body) { updates.push("hidden_scales = ?"); params.push(JSON.stringify(body.hiddenScales || [])); }
    if (updates.length) {
      params.push(me); // Add 'me' to the end of params for the WHERE clause
      prepare(`UPDATE users SET ${updates.join(", ")} WHERE username = ?`).run(params);
    }
    res.json(loadMeState(me));
  } catch (e) {
    console.error("Error in /vibes-api/me PATCH:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

// PLANS — choosing a plan (or dismissing the paywall, which defaults to Free) always
// ends the trial. Upgrading is also reachable any time from the Profile page, not just
// at the paywall.
const VALID_PLANS = ["free", "plus", "better", "best"];
app.post("/vibes-api/plan", (req, res) => {
  try {
    const me = req.me;
    const { plan } = req.body;
    if (!VALID_PLANS.includes(plan)) return res.status(400).json({ error: "Invalid plan" });
    prepare("UPDATE users SET plan = ?, trial_active = 0, pending_paywall = 0 WHERE username = ?").run(plan, me);
    res.json(loadMeState(me));
  } catch (e) {
    console.error("Error in /vibes-api/plan POST:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

app.post("/vibes-api/plan/ad-profile", (req, res) => {
  try {
    const me = req.me;
    const body = req.body;
    const fieldMap = { age: "ad_age", birthdate: "ad_birthdate", gender: "ad_gender", hobbies: "ad_hobbies", lat: "ad_lat", lon: "ad_lon" };
    const updates = [];
    const params = [];
    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in body) { updates.push(`${col} = ?`); params.push(body[key] ? String(body[key]) : null); }
    }
    if (updates.length) {
      params.push(me);
      prepare(`UPDATE users SET ${updates.join(", ")} WHERE username = ?`).run(params);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Error in /vibes-api/plan/ad-profile POST:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

// USER SEARCH
app.get("/vibes-api/users/search", (req, res) => {
  try {
    const me = req.me;
    const q = (req.query.q || "").toLowerCase().trim();
    if (!q) return res.json([]);
    const rows = prepare("SELECT * FROM users WHERE username != ? AND (username LIKE ? OR LOWER(display_name) LIKE ?) LIMIT 20").all(me, `%${q}%`, `%${q}%`);
    const results = rows.map((u) => {
      const connected = prepare("SELECT 1 FROM people WHERE owner = ? AND source_username = ?").get(me, u.username) ? true : false;
      const pending = prepare("SELECT 1 FROM requests WHERE from_user = ? AND to_user = ?").get(me, u.username) ? true : false;
      const theyRequested = prepare("SELECT 1 FROM requests WHERE from_user = ? AND to_user = ?").get(u.username, me) ? true : false;
      return {
        username: u.username,
        displayName: u.display_name || u.username,
        photoDataUrl: u.photo_data_url || null,
        connected, pending, theyRequested,
      };
    });
    res.json(results);
  } catch (e) {
    console.error("Error in /vibes-api/users/search:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

app.get("/vibes-api/users/suggestions", (req, res) => {
  try {
    const me = req.me;
    const rows = prepare(`
      SELECT p2.source_username AS username, u.display_name, u.photo_data_url, COUNT(*) AS mutual_count
      FROM people p1
      JOIN people p2 ON p2.owner = p1.source_username
      JOIN users u ON u.username = p2.source_username
      WHERE p1.owner = ?
        AND p2.source_username != ?
        AND p2.source_username NOT IN (SELECT source_username FROM people WHERE owner = ?)
        AND p2.source_username NOT IN (SELECT to_user FROM requests WHERE from_user = ?)
      GROUP BY p2.source_username
      ORDER BY mutual_count DESC
      LIMIT 20
    `).all(me, me, me, me);
    const results = rows.map(r => {
      const theyRequested = prepare("SELECT 1 FROM requests WHERE from_user = ? AND to_user = ?").get(r.username, me) ? true : false;
      return { username: r.username, displayName: r.display_name || r.username, photoDataUrl: r.photo_data_url || null, mutualCount: r.mutual_count, connected: false, pending: false, theyRequested };
    });
    res.json(results);
  } catch (e) {
    console.error("Error in /vibes-api/users/suggestions:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

app.get("/vibes-api/users/:username", (req, res) => {
  try {
    const username = decodeURIComponent(req.params.username);
    const u = prepare("SELECT * FROM users WHERE username = ?").get(username);
    if (!u) return res.status(404).json({ error: "User not found" });
    res.json(userPublic(u));
  } catch (e) {
    console.error(`Error in /vibes-api/users/${req.params.username}:`, e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});
// REQUESTS
app.post("/vibes-api/requests/send", async (req, res) => {
  try {
    const me = req.me;
    const { toUsername } = req.body;
    if (!toUsername) return res.status(400).json({ error: "toUsername required" });
    const to = String(toUsername).toLowerCase();
    if (to === me) return res.status(400).json({ error: "Cannot add yourself" });
    const target = prepare("SELECT 1 FROM users WHERE username = ?").get(to);
    if (!target) return res.status(404).json({ error: "User not found" });
    // If they already requested me, auto-accept
    const theirReq = prepare("SELECT 1 FROM requests WHERE from_user = ? AND to_user = ?").get(to, me);
    if (theirReq) {
      return res.json(acceptRequestTransaction(me, to));
    }
    const exists = prepare("SELECT 1 FROM requests WHERE from_user = ? AND to_user = ?").get(me, to);
    if (!exists) {
      prepare("INSERT INTO requests (from_user, to_user, created_at) VALUES (?, ?, ?)").run(me, to, now());
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Error in /vibes-api/requests/send:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

app.post("/vibes-api/requests/accept", async (req, res) => {
  try {
    const me = req.me;
    const { fromUsername } = req.body;
    if (!fromUsername) return res.status(400).json({ error: "fromUsername required" });
    res.json(acceptRequestTransaction(me, String(fromUsername).toLowerCase()));
  } catch (e) {
    console.error("Error in /vibes-api/requests/accept:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

app.post("/vibes-api/requests/decline", async (req, res) => {
  try {
    const me = req.me;
    const { fromUsername } = req.body;
    const from = String(fromUsername || "").toLowerCase();
    prepare("DELETE FROM requests WHERE from_user = ? AND to_user = ?").run(from, me);
    res.json({ ok: true });
  } catch (e) {
    console.error("Error in /vibes-api/requests/decline:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

app.post("/vibes-api/requests/cancel", async (req, res) => {
  try {
    const me = req.me;
    const { toUsername } = req.body;
    const to = String(toUsername || "").toLowerCase();
    prepare("DELETE FROM requests WHERE from_user = ? AND to_user = ?").run(me, to);
    res.json({ ok: true });
  } catch (e) {
    console.error("Error in /vibes-api/requests/cancel:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

// INVITE LINK — opening someone's invite link instantly connects you as friends.
app.post("/vibes-api/invite/accept", async (req, res) => {
  try {
    const me = req.me;
    const { fromUsername } = req.body;
    if (!fromUsername) return res.status(400).json({ error: "fromUsername required" });
    const from = String(fromUsername).toLowerCase();
    if (from === me) return res.status(400).json({ error: "Cannot add yourself" });
    const target = prepare("SELECT 1 FROM users WHERE username = ?").get(from);
    if (!target) return res.status(404).json({ error: "User not found" });
    db.transaction(() => {
      prepare("DELETE FROM requests WHERE from_user = ? AND to_user = ?").run(from, me);
      prepare("DELETE FROM requests WHERE from_user = ? AND to_user = ?").run(me, from);
      connectUsersRaw(me, from);
    })();
    res.json({ ok: true, fromUsername: from });
  } catch (e) {
    console.error("Error in /vibes-api/invite/accept:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

// PEOPLE
app.delete("/vibes-api/people/:id", (req, res) => {
  try {
    const me = req.me;
    const id = decodeURIComponent(req.params.id);
    prepare("DELETE FROM people WHERE id = ? AND owner = ?").run(id, me);
    res.json({ ok: true });
  } catch (e) {
    console.error(`Error in /vibes-api/people/${req.params.id} DELETE:`, e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

app.patch("/vibes-api/people/:id", async (req, res) => {
  try {
    const me = req.me;
    const id = decodeURIComponent(req.params.id);
    const body = req.body;
    const row = prepare("SELECT * FROM people WHERE id = ? AND owner = ?").get(id, me);
    if (!row) return res.status(404).json({ error: "Not found" });
    const updates = [];
    const params = [];
    if ("friendIndex" in body) { updates.push("friend_index = ?"); params.push(body.friendIndex); }
    if ("romanticIndex" in body) { updates.push("romantic_index = ?"); params.push(body.romanticIndex); }
    if ("showRomantic" in body) { updates.push("show_romantic = ?"); params.push(body.showRomantic ? 1 : 0); }
    if ("name" in body) { updates.push("name = ?"); params.push(String(body.name || row.name)); }
    if ("photoDataUrl" in body) { updates.push("photo_data_url = ?"); params.push(body.photoDataUrl || null); }
    if (updates.length) {
      params.push(id, me);
      prepare(`UPDATE people SET ${updates.join(", ")} WHERE id = ? AND owner = ?`).run(params);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(`Error in /vibes-api/people/${req.params.id} PATCH:`, e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

// MESSAGES
app.get("/vibes-api/messages", (req, res) => {
  try {
    const me = req.me;
    const partners = prepare(`
      SELECT DISTINCT peer FROM (
        SELECT to_user AS peer FROM messages WHERE from_user = ?
        UNION
        SELECT from_user AS peer FROM messages WHERE to_user = ?
      )
    `).all(me, me);
    const convos = partners.map((p) => {
      const peer = p.peer;
      const last = prepare("SELECT * FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY ts DESC LIMIT 1").get(me, peer, peer, me);
      const unread = prepare("SELECT COUNT(*) as c FROM messages WHERE from_user = ? AND to_user = ? AND read = 0").get(peer, me);
      const u = prepare("SELECT * FROM users WHERE username = ?").get(peer);
      const streakCount = computeStreak(me, peer);
      return {
        username: peer,
        name: (u?.display_name) || peer,
        photoDataUrl: u?.photo_data_url || null,
        lastMessage: last?.body || "",
        ts: last?.ts || 0,
        unread: unread?.c || 0,
        streakCount,
      };
    }).sort((a, b) => b.ts - a.ts);
    res.json(convos);
  } catch (e) {
    console.error("Error in /vibes-api/messages GET:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

app.get("/vibes-api/messages/:peer", (req, res) => {
  try {
    const me = req.me;
    const peer = decodeURIComponent(req.params.peer);
    // Get both sides' expiry settings
    const myRow = prepare("SELECT chat_expiry FROM people WHERE owner = ? AND source_username = ?").get(me, peer);
    const peerRow = prepare("SELECT chat_expiry FROM people WHERE owner = ? AND source_username = ?").get(peer, me);
    const myExpiry = myRow ? myRow.chat_expiry : null;
    const peerExpiry = peerRow ? peerRow.chat_expiry : null;
    // Effective TTL = shortest (most restrictive) of the two
    let effectiveTtl = null;
    if (myExpiry !== null && peerExpiry !== null) effectiveTtl = Math.min(myExpiry, peerExpiry);
    else if (myExpiry !== null) effectiveTtl = myExpiry;
    else if (peerExpiry !== null) effectiveTtl = peerExpiry;
    // Delete expired messages if TTL is set
    if (effectiveTtl !== null) {
      const cutoff = now() - effectiveTtl;
      prepare("DELETE FROM messages WHERE ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)) AND ts < ?").run(me, peer, peer, me, cutoff);
    }
    const msgs = prepare("SELECT * FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY ts ASC").all(me, peer, peer, me);
    prepare("UPDATE messages SET read = 1 WHERE from_user = ? AND to_user = ?").run(peer, me);
    const msgIds = msgs.map(m => m.id);
    const reactions = msgIds.length
      ? prepare(`SELECT msg_id, username, emoji FROM reactions2 WHERE msg_id IN (${msgIds.map(()=>'?').join(',')}) ORDER BY id ASC`).all(...msgIds)
      : [];
    const reactionsByMsg = {};
    for (const r of reactions) {
      if (!reactionsByMsg[r.msg_id]) reactionsByMsg[r.msg_id] = [];
      reactionsByMsg[r.msg_id].push({ username: r.username, emoji: r.emoji });
    }
    res.json({
      messages: msgs.map((m) => ({ id: m.id, from: m.from_user, to: m.to_user, body: m.body, ts: m.ts, read: !!m.read, reactions: reactionsByMsg[m.id] || [] })),
      myExpiry,
      peerExpiry,
      effectiveTtl
    });
  } catch (e) {
    console.error(`Error in /vibes-api/messages/${req.params.peer} GET:`, e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

app.post("/vibes-api/messages/:peer/react", (req, res) => {
  try {
    const me = req.me;
    const peer = decodeURIComponent(req.params.peer);
    const { msgId, emoji } = req.body;
    if (!msgId || !emoji) return res.status(400).json({ error: "Missing msgId or emoji" });
    const msg = prepare("SELECT id FROM messages WHERE id = ? AND (from_user IN (?,?) AND to_user IN (?,?))").get(msgId, me, peer, me, peer);
    if (!msg) return res.status(403).json({ error: "Message not found" });
    prepare("INSERT OR IGNORE INTO reactions2 (msg_id, username, emoji) VALUES (?,?,?)").run(msgId, me, emoji);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/vibes-api/messages/:peer/react", (req, res) => {
  try {
    const me = req.me;
    const peer = decodeURIComponent(req.params.peer);
    const { msgId, emoji } = req.body;
    if (!msgId || !emoji) return res.status(400).json({ error: "Missing msgId or emoji" });
    prepare("DELETE FROM reactions2 WHERE msg_id = ? AND username = ? AND emoji = ?").run(msgId, me, emoji);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/vibes-api/messages/:peer/:msgId", (req, res) => {
  try {
    const me = req.me;
    const peer = decodeURIComponent(req.params.peer);
    const msgId = parseInt(req.params.msgId);
    const msg = prepare("SELECT id FROM messages WHERE id = ? AND from_user = ?").get(msgId, me);
    if (!msg) return res.status(403).json({ error: "Not your message" });
    prepare("DELETE FROM reactions2 WHERE msg_id = ?").run(msgId);
    prepare("DELETE FROM messages WHERE id = ?").run(msgId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/vibes-api/messages/:peer/expiry", (req, res) => {
  try {
    const me = req.me;
    const peer = decodeURIComponent(req.params.peer);
    const { expiry } = req.body; // seconds or null
    const val = expiry === null ? null : Number(expiry);
    if (val !== null && (val < 60 || val > 2592000 || val % 60 !== 0)) return res.status(400).json({ error: "Invalid expiry" });
    const row = prepare("SELECT id FROM people WHERE owner = ? AND source_username = ?").get(me, peer);
    if (!row) return res.status(403).json({ error: "Not connected" });
    prepare("UPDATE people SET chat_expiry = ? WHERE owner = ? AND source_username = ?").run(val, me, peer);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Notify peer that you copied/saved something in the chat
app.post("/vibes-api/messages/:peer/notify-action", (req, res) => {
  try {
    const me = req.me;
    const peer = decodeURIComponent(req.params.peer);
    const { action } = req.body; // 'screenshot' | 'copy' | 'save'
    const sender = prepare("SELECT display_name FROM users WHERE username = ?").get(me);
    const senderName = (sender && sender.display_name) || me;
    const body = action === 'copy' ? `${senderName} copied a message` : action === 'save' ? `${senderName} saved a photo` : `${senderName} took a screenshot`;
    sendPushToUser(peer, { title: '👁 Vibes', body, tag: `action-${me}-${action}`, data: {} });
    // Also store as a system message so it shows in chat even without push
    prepare("INSERT INTO messages (from_user, to_user, body, ts, read) VALUES (?, ?, ?, ?, 0)").run('__system__', peer, JSON.stringify({ type: 'action', actor: me, actorName: senderName, action }), now());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/vibes-api/messages/:peer", async (req, res) => {
  try {
    const me = req.me;
    const peer = decodeURIComponent(req.params.peer);
    const { body } = req.body;
    if (!body) return res.status(400).json({ error: "Body required" });
    const connected = prepare("SELECT 1 FROM people WHERE owner = ? AND source_username = ?").get(me, peer);
    const peerIsAdmin = prepare("SELECT is_admin FROM users WHERE username = ?").get(peer);
    if (!connected && !(peerIsAdmin && peerIsAdmin.is_admin)) return res.status(403).json({ error: "Not connected" });
    prepare("INSERT INTO messages (from_user, to_user, body, ts, read) VALUES (?, ?, ?, ?, 0)").run(me, peer, String(body), now());
    maybeFlagTrialEnd(me);
    // Push notification to recipient
    const sender = prepare("SELECT display_name FROM users WHERE username = ?").get(me);
    const senderName = (sender && sender.display_name) || me;
    const isImage = String(body).startsWith('data:image/');
    const unreadCount = prepare("SELECT COUNT(*) AS c FROM messages WHERE to_user = ? AND read = 0").get(peer).c;
    sendPushToUser(peer, {
      title: senderName,
      body: isImage ? '📷 Sent a photo' : String(body).slice(0, 100),
      tag: `msg-${me}`,
      data: { fromUser: me, unreadCount }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(`Error in /vibes-api/messages/${req.params.peer} POST:`, e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

// RIZZ ASSIST — short flirty message suggestions, generated server-side so the
// LLM API key never reaches the client. Requires GROQ_API_KEY to be set.
const ROMANTIC_STEPS = ["No Attraction", "Curious", "Talking", "Dating", "Partner", "Soulmate"];
app.post("/vibes-api/rizz", async (req, res) => {
  try {
    const me = req.me;
    const meUser = prepare("SELECT plan FROM users WHERE username = ?").get(me);
    if (!meUser || (meUser.plan !== "best" && meUser.plan !== "plus")) return res.status(403).json({ error: "Rizz Assist is a Plus or Best plan feature", upgradeRequired: true });
    const { peerUsername } = req.body;
    if (!peerUsername) return res.status(400).json({ error: "peerUsername required" });
    const peer = String(peerUsername).toLowerCase();
    const connected = prepare("SELECT 1 FROM people WHERE owner = ? AND source_username = ?").get(me, peer);
    if (!connected) return res.status(403).json({ error: "Not connected" });
    if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: "Rizz assist isn't configured on this server" });

    const peerUser = prepare("SELECT * FROM users WHERE username = ?").get(peer);
    const peerName = peerUser ? (peerUser.display_name || peerUser.username) : peer;
    const person = loadPeopleForUser(me).find((p) => p.sourceUsername === peer);
    const vibeLabel = person && person.effectiveRomanticIndex != null ? ROMANTIC_STEPS[person.effectiveRomanticIndex] : "Curious";

    const rows = prepare("SELECT * FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY ts DESC LIMIT 10").all(me, peer, peer, me);
    const recent = rows.reverse().filter((m) => !m.body.startsWith("data:image/"));
    const history = recent.map((m) => `${m.from_user === me ? "Me" : peerName}: ${m.body}`).join("\n");

    const prompt = `You are helping someone flirt. Their romantic Vibe Score with ${peerName} is "${vibeLabel}". Give 3 short, witty, natural message suggestions they could send next. Keep each under 12 words. No quotes, no numbering, just one per line. Recent chat:\n${history || "(no messages yet)"}`;

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!groqRes.ok) throw new Error(`Groq API error: ${groqRes.status}`);
    const data = await groqRes.json();
    const text = data?.choices?.[0]?.message?.content || "";
    const suggestions = text.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 3);
    if (!suggestions.length) throw new Error("No suggestions returned");
    res.json({ suggestions });
  } catch (e) {
    console.error("Error in /vibes-api/rizz:", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

// PUSH NOTIFICATIONS
function sendPushToUser(username, payload) {
  const subs = prepare("SELECT subscription FROM push_subscriptions WHERE username = ?").all(username);
  if (!subs.length) { console.log(`[push] no subscriptions for ${username}`); return; }
  for (const row of subs) {
    try {
      const sub = JSON.parse(row.subscription);
      webpush.sendNotification(sub, JSON.stringify(payload)).catch(err => {
        console.error(`[push] failed for ${username}: ${err.statusCode} ${err.message}`);
        if (err.statusCode === 410 || err.statusCode === 404) {
          prepare("DELETE FROM push_subscriptions WHERE username = ? AND endpoint = ?").run(username, sub.endpoint);
        }
      });
    } catch (e) { console.error(`[push] error for ${username}:`, e.message); }
  }
}

app.get("/vibes-api/push/vapid-public-key", (req, res) => res.json({ key: process.env.VAPID_PUBLIC_KEY }));
app.post("/vibes-api/push/subscribe", (req, res) => {
  try {
    const me = req.me;
    const sub = req.body;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: "Invalid subscription" });
    prepare("INSERT OR REPLACE INTO push_subscriptions (username, endpoint, subscription) VALUES (?, ?, ?)").run(me, sub.endpoint, JSON.stringify(sub));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.delete("/vibes-api/push/subscribe", (req, res) => {
  try {
    const me = req.me;
    prepare("DELETE FROM push_subscriptions WHERE username = ?").run(me);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// MISC
app.post("/vibes-api/track/open", (req, res) => {
  const date = new Date().toISOString().slice(0, 10);
  prepare(`INSERT INTO page_views (date, count) VALUES (?, 1) ON CONFLICT(date) DO UPDATE SET count = count + 1`).run(date);
  res.json({ ok: true });
});

app.post("/vibes-api/track/install", (req, res) => {
  prepare("INSERT INTO pwa_installs (ts) VALUES (?)").run(now());
  res.json({ ok: true });
});

// Admin endpoints
function requireAdmin(req, res, next) {
  const row = prepare("SELECT is_admin FROM users WHERE username = ?").get(req.me);
  if (!row || !row.is_admin) return res.status(403).json({ error: 'Forbidden' });
  next();
}

app.get("/vibes-api/admin/push-debug", requireAdmin, (req, res) => {
  const subs = prepare("SELECT username, endpoint FROM push_subscriptions").all();
  res.json({ vapidPublicKey: process.env.VAPID_PUBLIC_KEY?.slice(0,20)+'...', subscriptions: subs });
});

app.get("/vibes-api/admin/stats", requireAdmin, (req, res) => {
  const days = 14;
  const views = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    const row = prepare("SELECT count FROM page_views WHERE date = ?").get(date);
    views.push({ date, count: row ? row.count : 0 });
  }
  const totalUsers = prepare("SELECT COUNT(*) AS c FROM users WHERE banned = 0").get().c;
  const totalInstalls = prepare("SELECT COUNT(*) AS c FROM pwa_installs").get().c;
  res.json({ views, totalUsers, totalInstalls });
});

app.get("/vibes-api/admin/users", requireAdmin, (req, res) => {
  const users = prepare("SELECT username, display_name, photo_data_url, banned FROM users ORDER BY rowid DESC").all();
  res.json(users.map(u => ({ username: u.username, displayName: u.display_name || u.username, photoDataUrl: u.photo_data_url || null, banned: !!u.banned })));
});

app.post("/vibes-api/admin/users/:username/ban", requireAdmin, (req, res) => {
  prepare("UPDATE users SET banned = 1 WHERE username = ?").run(req.params.username);
  res.json({ ok: true });
});

app.post("/vibes-api/admin/users/:username/unban", requireAdmin, (req, res) => {
  prepare("UPDATE users SET banned = 0 WHERE username = ?").run(req.params.username);
  res.json({ ok: true });
});

app.delete("/vibes-api/admin/users/:username", requireAdmin, (req, res) => {
  const u = req.params.username;
  db.transaction(() => {
    prepare("DELETE FROM people WHERE owner = ? OR source_username = ?").run(u, u);
    prepare("DELETE FROM messages WHERE from_user = ? OR to_user = ?").run(u, u);
    prepare("DELETE FROM requests WHERE from_user = ? OR to_user = ?").run(u, u);
    prepare("DELETE FROM presence WHERE username = ?").run(u);
    prepare("DELETE FROM reactions2 WHERE username = ?").run(u);
    prepare("DELETE FROM push_subscriptions WHERE username = ?").run(u);
    prepare("DELETE FROM users WHERE username = ? AND is_admin = 0").run(u);
  })();
  res.json({ ok: true });
});

app.post("/vibes-api/admin/clear-accounts", requireAdmin, (req, res) => {
  db.transaction(() => {
    const others = prepare("SELECT username FROM users WHERE is_admin = 0").all().map(r => r.username);
    for (const u of others) {
      prepare("DELETE FROM people WHERE owner = ? OR source_username = ?").run(u, u);
      prepare("DELETE FROM messages WHERE from_user = ? OR to_user = ?").run(u, u);
      prepare("DELETE FROM requests WHERE from_user = ? OR to_user = ?").run(u, u);
      prepare("DELETE FROM presence WHERE username = ?").run(u);
      prepare("DELETE FROM reactions2 WHERE username = ?").run(u);
      prepare("DELETE FROM push_subscriptions WHERE username = ?").run(u);
      prepare("DELETE FROM users WHERE username = ?").run(u);
    }
  })();
  res.json({ ok: true });
});

// Presence
app.post("/vibes-api/presence/update", (req, res) => {
  try {
    const me = req.me;
    const status = req.body.status || 'online';
    const chatWith = req.body.chatWith || null;
    const n = now();
    prepare(`INSERT INTO presence (username, status, last_seen, last_active, chat_with)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET status=excluded.status, last_seen=excluded.last_seen, last_active=excluded.last_active, chat_with=excluded.chat_with`
    ).run(me, status, n, n, chatWith);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/vibes-api/presence/:username", (req, res) => {
  try {
    const row = prepare("SELECT status, last_seen, chat_with FROM presence WHERE username = ?").get(req.params.username);
    if (!row) return res.json({ status: 'offline', lastSeen: 0, chatWith: null });
    const stale = now() - row.last_seen > 180;
    res.json({ status: stale ? 'offline' : row.status, lastSeen: row.last_seen, chatWith: row.chat_with || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Typing indicators
app.post("/vibes-api/typing/:peer", (req, res) => {
  try {
    const me = req.me;
    const peer = req.params.peer;
    if (req.body.typing) {
      prepare(`INSERT INTO typing_indicators (username, peer, typing_at) VALUES (?, ?, ?)
        ON CONFLICT(username, peer) DO UPDATE SET typing_at=excluded.typing_at`).run(me, peer, now());
    } else {
      prepare("DELETE FROM typing_indicators WHERE username = ? AND peer = ?").run(me, peer);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/vibes-api/typing/:peer", (req, res) => {
  try {
    const row = prepare("SELECT typing_at FROM typing_indicators WHERE username = ? AND peer = ?").get(req.params.peer, req.me);
    const typing = row && (now() - row.typing_at) < 5;
    res.json({ typing: !!typing });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Handle 404 for API routes
app.use("/vibes-api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});
// --- Start the Server ---
if (require.main === module) {
  dbPromise.then(() => {
    app.listen(PORT, () => {
        console.log(`Vibes backend listening on http://localhost:${PORT}`);
      console.log(`DB at ${DB_PATH}`);
    });
  }).catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
}

module.exports = app;


