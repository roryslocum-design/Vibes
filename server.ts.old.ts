import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { readFileSync, statSync } from "fs";
import { join } from "path";

const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || join(import.meta.dir, "vibes.db");
const HTML_PATH = join(import.meta.dir, "index.html");

const db = new Database(DB_PATH);
db.exec(`PRAGMA journal_mode = WAL;`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  photo_data_url TEXT,
  bio TEXT DEFAULT '',
  streaks_enabled INTEGER DEFAULT 0,
  hidden_scales TEXT DEFAULT '[]',
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
`);

const now = () => Math.floor(Date.now() / 1000);

function authenticate(req: Request): string | null {
  const u = req.headers.get("x-username");
  const p = req.headers.get("x-password");
  if (!u || !p) return null;
  const row = db.query("SELECT password FROM users WHERE username = ?").get(u) as any;
  if (!row || row.password !== p) return null;
  return u;
}

function jsonResp(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, x-username, x-password",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    },
  });
}

function errResp(error: string, status = 400) {
  return jsonResp({ error }, status);
}

function userPublic(u: any) {
  return {
    username: u.username,
    displayName: u.display_name || "",
    photoDataUrl: u.photo_data_url || null,
    bio: u.bio || "",
  };
}

function getEffective(me: string, otherUsername: string) {
  // Get me's person row for other, and other's person row for me
  const mine = db.query("SELECT * FROM people WHERE owner = ? AND source_username = ?").get(me, otherUsername) as any;
  const theirs = db.query("SELECT * FROM people WHERE owner = ? AND source_username = ?").get(otherUsername, me) as any;
  return { mine, theirs };
}

function loadPeopleForUser(username: string) {
  const rows = db.query("SELECT * FROM people WHERE owner = ? ORDER BY created_at ASC").all(username) as any[];
  return rows.map((p) => {
    // Only show an effective score if YOU have rated this person — keeps ratings private until you commit
    let effectiveFriendIndex = p.friend_index;
    let effectiveRomanticIndex = (p.show_romantic && p.romantic_index != null) ? p.romantic_index : null;
    let theyRemovedRomantic = false;
    let theyHaveCommittedRomantic = false;
    if (p.source_username) {
      const theirs = db.query("SELECT * FROM people WHERE owner = ? AND source_username = ?").get(p.source_username, username) as any;
      if (theirs) {
        // effective = min of both sides, ONLY when both have rated
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
        // committed romantic on other side?
        const committed = db.query("SELECT 1 FROM people WHERE owner = ? AND source_username != ? AND romantic_index >= 3 AND show_romantic = 1 LIMIT 1").get(p.source_username, username);
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

function loadMeState(username: string) {
  const u = db.query("SELECT * FROM users WHERE username = ?").get(username) as any;
  if (!u) return null;
  const people = loadPeopleForUser(username);
  const pendingRequests = (db.query("SELECT r.from_user, r.created_at, u.username, u.display_name, u.photo_data_url FROM requests r JOIN users u ON u.username = r.from_user WHERE r.to_user = ? ORDER BY r.created_at DESC").all(username) as any[]).map((r) => ({
    fromUsername: r.from_user,
    fromName: r.display_name || r.from_user,
    photoDataUrl: r.photo_data_url || null,
    createdAt: r.created_at,
  }));
  const sentRequests = (db.query("SELECT r.to_user, r.created_at, u.display_name, u.photo_data_url FROM requests r JOIN users u ON u.username = r.to_user WHERE r.from_user = ? ORDER BY r.created_at DESC").all(username) as any[]).map((r) => ({
    toUsername: r.to_user,
    toName: r.display_name || r.to_user,
    photoDataUrl: r.photo_data_url || null,
    createdAt: r.created_at,
  }));
  // pull and clear notifications
  const notifs = db.query("SELECT * FROM notifications WHERE to_user = ?").all(username) as any[];
  if (notifs.length) db.run("DELETE FROM notifications WHERE to_user = ?", [username]);

  return {
    username: u.username,
    displayName: u.display_name || "",
    photoDataUrl: u.photo_data_url || null,
    bio: u.bio || "",
    streaksEnabled: !!u.streaks_enabled,
    hiddenScales: JSON.parse(u.hidden_scales || "[]"),
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

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

const SCALES_FRIEND_DEFAULT = 1;

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, x-username, x-password",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        },
      });
    }

    // Static: root + /vibes/* serves the app (with /relations/* as legacy alias)
    if (!path.startsWith("/vibes-api")) {
      if (path === "/relations" || path === "/relations/" || path === "/relations/index.html") {
        return new Response(null, { status: 302, headers: { "Location": "/vibes/" } });
      }
      if (path === "/" || path === "/vibes" || path === "/vibes/" || path === "/vibes/index.html") {
        const html = readFileSync(HTML_PATH, "utf8");
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      // Manifest / icon stubs to silence 404s
      if (path === "/vibes/manifest.json") {
        return jsonResp({ name: "Vibes", short_name: "Vibes", start_url: "/vibes/", display: "standalone", background_color: "#000", theme_color: "#000", icons: [] });
      }
      if (path === "/vibes/icon.svg") {
        return new Response(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0a84ff"/><text x="32" y="42" text-anchor="middle" font-size="34" fill="white" font-family="sans-serif">V</text></svg>`, { headers: { "Content-Type": "image/svg+xml" } });
      }
      return new Response("Not found", { status: 404 });
    }

    const apiPath = path.slice("/vibes-api".length); // begins with /

    try {
      // ─── AUTH ────────────────────────────────────────────────────────────
      if (apiPath === "/auth/signup" && method === "POST") {
        const { username, password } = await readJson(req);
        if (!username || !password) return errResp("Username and password required");
        const uname = String(username).toLowerCase().trim();
        if (uname.length < 2) return errResp("Username too short");
        if (String(password).length < 4) return errResp("Password too short");
        const existing = db.query("SELECT 1 FROM users WHERE username = ?").get(uname);
        if (existing) return errResp("Username taken");
        db.run("INSERT INTO users (username, password, display_name, created_at) VALUES (?, ?, ?, ?)", [uname, String(password), uname, now()]);
        return jsonResp({ username: uname });
      }

      if (apiPath === "/auth/login" && method === "POST") {
        const { username, password } = await readJson(req);
        if (!username || !password) return errResp("Username and password required");
        const uname = String(username).toLowerCase().trim();
        const row = db.query("SELECT password FROM users WHERE username = ?").get(uname) as any;
        if (!row || row.password !== String(password)) return errResp("Invalid username or password", 401);
        return jsonResp({ username: uname });
      }

      // All routes below require auth
      const me = authenticate(req);
      if (!me) return errResp("Unauthorized", 401);

      if (apiPath === "/auth/delete" && method === "DELETE") {
        db.run("DELETE FROM users WHERE username = ?", [me]);
        db.run("DELETE FROM people WHERE owner = ?", [me]);
        db.run("DELETE FROM people WHERE source_username = ?", [me]);
        db.run("DELETE FROM requests WHERE from_user = ? OR to_user = ?", [me, me]);
        db.run("DELETE FROM messages WHERE from_user = ? OR to_user = ?", [me, me]);
        db.run("DELETE FROM notifications WHERE to_user = ? OR from_user = ?", [me, me]);
        return jsonResp({ ok: true });
      }

      // ─── ME ──────────────────────────────────────────────────────────────
      if (apiPath === "/me" && method === "GET") {
        const state = loadMeState(me);
        return jsonResp(state);
      }

      if (apiPath === "/me" && method === "PATCH") {
        const body = await readJson(req);
        const updates: string[] = [];
        const params: any[] = [];
        if ("displayName" in body) { updates.push("display_name = ?"); params.push(String(body.displayName || "")); }
        if ("photoDataUrl" in body) { updates.push("photo_data_url = ?"); params.push(body.photoDataUrl || null); }
        if ("bio" in body) { updates.push("bio = ?"); params.push(String(body.bio || "")); }
        if ("streaksEnabled" in body) { updates.push("streaks_enabled = ?"); params.push(body.streaksEnabled ? 1 : 0); }
        if ("hiddenScales" in body) { updates.push("hidden_scales = ?"); params.push(JSON.stringify(body.hiddenScales || [])); }
        if (updates.length) {
          params.push(me);
          db.run(`UPDATE users SET ${updates.join(", ")} WHERE username = ?`, params);
        }
        return jsonResp(loadMeState(me));
      }

      // ─── USER SEARCH ────────────────────────────────────────────────────
      if (apiPath === "/users/search" && method === "GET") {
        const q = (url.searchParams.get("q") || "").toLowerCase().trim();
        if (!q) return jsonResp([]);
        const rows = db.query("SELECT * FROM users WHERE username != ? AND (username LIKE ? OR LOWER(display_name) LIKE ?) LIMIT 20").all(me, `%${q}%`, `%${q}%`) as any[];
        const results = rows.map((u) => {
          const connected = db.query("SELECT 1 FROM people WHERE owner = ? AND source_username = ?").get(me, u.username) ? true : false;
          const pending = db.query("SELECT 1 FROM requests WHERE from_user = ? AND to_user = ?").get(me, u.username) ? true : false;
          const theyRequested = db.query("SELECT 1 FROM requests WHERE from_user = ? AND to_user = ?").get(u.username, me) ? true : false;
          return {
            username: u.username,
            displayName: u.display_name || u.username,
            photoDataUrl: u.photo_data_url || null,
            connected, pending, theyRequested,
          };
        });
        return jsonResp(results);
      }

      if (apiPath.startsWith("/users/") && method === "GET") {
        const username = decodeURIComponent(apiPath.slice("/users/".length));
        const u = db.query("SELECT * FROM users WHERE username = ?").get(username) as any;
        if (!u) return errResp("User not found", 404);
        return jsonResp(userPublic(u));
      }

      // ─── REQUESTS ───────────────────────────────────────────────────────
      if (apiPath === "/requests/send" && method === "POST") {
        const { toUsername } = await readJson(req);
        if (!toUsername) return errResp("toUsername required");
        const to = String(toUsername).toLowerCase();
        if (to === me) return errResp("Cannot add yourself");
        const target = db.query("SELECT 1 FROM users WHERE username = ?").get(to);
        if (!target) return errResp("User not found", 404);
        // If they already requested me, auto-accept
        const theirReq = db.query("SELECT 1 FROM requests WHERE from_user = ? AND to_user = ?").get(to, me);
        if (theirReq) {
          return acceptRequest(me, to);
        }
        const exists = db.query("SELECT 1 FROM requests WHERE from_user = ? AND to_user = ?").get(me, to);
        if (!exists) {
          db.run("INSERT INTO requests (from_user, to_user, created_at) VALUES (?, ?, ?)", [me, to, now()]);
        }
        return jsonResp({ ok: true });
      }

      if (apiPath === "/requests/accept" && method === "POST") {
        const { fromUsername } = await readJson(req);
        if (!fromUsername) return errResp("fromUsername required");
        return acceptRequest(me, String(fromUsername).toLowerCase());
      }

      if (apiPath === "/requests/decline" && method === "POST") {
        const { fromUsername } = await readJson(req);
        const from = String(fromUsername || "").toLowerCase();
        db.run("DELETE FROM requests WHERE from_user = ? AND to_user = ?", [from, me]);
        return jsonResp({ ok: true });
      }

      if (apiPath === "/requests/cancel" && method === "POST") {
        const { toUsername } = await readJson(req);
        const to = String(toUsername || "").toLowerCase();
        db.run("DELETE FROM requests WHERE from_user = ? AND to_user = ?", [me, to]);
        return jsonResp({ ok: true });
      }

      // ─── PEOPLE ─────────────────────────────────────────────────────────
      if (apiPath.startsWith("/people/") && method === "DELETE") {
        const id = decodeURIComponent(apiPath.slice("/people/".length));
        db.run("DELETE FROM people WHERE id = ? AND owner = ?", [id, me]);
        return jsonResp({ ok: true });
      }

      if (apiPath.startsWith("/people/") && method === "PATCH") {
        const id = decodeURIComponent(apiPath.slice("/people/".length));
        const body = await readJson(req);
        const row = db.query("SELECT * FROM people WHERE id = ? AND owner = ?").get(id, me) as any;
        if (!row) return errResp("Not found", 404);
        const updates: string[] = [];
        const params: any[] = [];
        if ("friendIndex" in body) { updates.push("friend_index = ?"); params.push(body.friendIndex); }
        if ("romanticIndex" in body) { updates.push("romantic_index = ?"); params.push(body.romanticIndex); }
        if ("showRomantic" in body) { updates.push("show_romantic = ?"); params.push(body.showRomantic ? 1 : 0); }
        if ("name" in body) { updates.push("name = ?"); params.push(String(body.name || row.name)); }
        if ("photoDataUrl" in body) { updates.push("photo_data_url = ?"); params.push(body.photoDataUrl || null); }
        if (updates.length) {
          params.push(id, me);
          db.run(`UPDATE people SET ${updates.join(", ")} WHERE id = ? AND owner = ?`, params);
        }
        return jsonResp({ ok: true });
      }

      // ─── MESSAGES ───────────────────────────────────────────────────────
      if (apiPath === "/messages" && method === "GET") {
        // Build conversation list
        const partners = db.query(`
          SELECT DISTINCT peer FROM (
            SELECT to_user AS peer FROM messages WHERE from_user = ?
            UNION
            SELECT from_user AS peer FROM messages WHERE to_user = ?
          )
        `).all(me, me) as any[];
        const convos = partners.map((p: any) => {
          const peer = p.peer;
          const last = db.query("SELECT * FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY ts DESC LIMIT 1").get(me, peer, peer, me) as any;
          const unread = db.query("SELECT COUNT(*) as c FROM messages WHERE from_user = ? AND to_user = ? AND read = 0").get(peer, me) as any;
          const u = db.query("SELECT * FROM users WHERE username = ?").get(peer) as any;
          // streak: count consecutive days both sent at least one message
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
        return jsonResp(convos);
      }

      if (apiPath.startsWith("/messages/") && method === "GET") {
        const peer = decodeURIComponent(apiPath.slice("/messages/".length));
        const msgs = db.query("SELECT * FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY ts ASC").all(me, peer, peer, me) as any[];
        // mark incoming as read
        db.run("UPDATE messages SET read = 1 WHERE from_user = ? AND to_user = ?", [peer, me]);
        return jsonResp(msgs.map((m) => ({ id: m.id, from: m.from_user, to: m.to_user, body: m.body, ts: m.ts, read: !!m.read })));
      }

      if (apiPath.startsWith("/messages/") && method === "POST") {
        const peer = decodeURIComponent(apiPath.slice("/messages/".length));
        const { body } = await readJson(req);
        if (!body) return errResp("Body required");
        // must be connected
        const connected = db.query("SELECT 1 FROM people WHERE owner = ? AND source_username = ?").get(me, peer);
        if (!connected) return errResp("Not connected", 403);
        db.run("INSERT INTO messages (from_user, to_user, body, ts, read) VALUES (?, ?, ?, ?, 0)", [me, peer, String(body), now()]);
        return jsonResp({ ok: true });
      }

      // ─── MISC ───────────────────────────────────────────────────────────
      if (apiPath === "/track/open" && method === "POST") return jsonResp({ ok: true });
      if (apiPath === "/push/vapid-public-key" && method === "GET") return jsonResp({ key: null });
      if (apiPath === "/push/subscribe" && method === "POST") return jsonResp({ ok: true });

      return errResp("Not found", 404);
    } catch (e: any) {
      console.error("err", apiPath, e);
      return errResp(e?.message || "Server error", 500);
    }
  },
});

function acceptRequest(me: string, fromUser: string) {
  const exists = db.query("SELECT 1 FROM requests WHERE from_user = ? AND to_user = ?").get(fromUser, me);
  if (!exists) return errResp("No such request", 404);
  const themUser = db.query("SELECT * FROM users WHERE username = ?").get(fromUser) as any;
  const myUser = db.query("SELECT * FROM users WHERE username = ?").get(me) as any;
  if (!themUser || !myUser) return errResp("User missing", 404);

  // delete request
  db.run("DELETE FROM requests WHERE from_user = ? AND to_user = ?", [fromUser, me]);
  // also clear any reverse pending
  db.run("DELETE FROM requests WHERE from_user = ? AND to_user = ?", [me, fromUser]);

  const ts = now();
  // Create people row for me → them (if not exists)
  const mine = db.query("SELECT * FROM people WHERE owner = ? AND source_username = ?").get(me, fromUser) as any;
  if (!mine) {
    db.run("INSERT INTO people (id, owner, name, source_username, friend_index, romantic_index, show_romantic, photo_data_url, created_at) VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)",
      [randomUUID(), me, themUser.display_name || themUser.username, fromUser, SCALES_FRIEND_DEFAULT, themUser.photo_data_url || null, ts]);
  }
  // And them → me
  const theirs = db.query("SELECT * FROM people WHERE owner = ? AND source_username = ?").get(fromUser, me) as any;
  if (!theirs) {
    db.run("INSERT INTO people (id, owner, name, source_username, friend_index, romantic_index, show_romantic, photo_data_url, created_at) VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)",
      [randomUUID(), fromUser, myUser.display_name || myUser.username, me, SCALES_FRIEND_DEFAULT, myUser.photo_data_url || null, ts]);
  }
  return jsonResp({ ok: true });
}

function computeStreak(a: string, b: string): number {
  // simple: count consecutive days (UTC) where both sent at least one message, walking back from today
  const rows = db.query("SELECT ts, from_user FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY ts DESC").all(a, b, b, a) as any[];
  if (!rows.length) return 0;
  const days = new Map<string, Set<string>>();
  for (const r of rows) {
    const d = new Date(r.ts * 1000);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (!days.has(key)) days.set(key, new Set());
    days.get(key)!.add(r.from_user);
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

console.log(`vibes backend listening on http://0.0.0.0:${PORT}`);
console.log(`db at ${DB_PATH}`);
