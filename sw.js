const CACHE_NAME = 'vibes-v4';

// Install — skip waiting immediately so this SW activates without delay
self.addEventListener('install', event => {
  self.skipWaiting();
});

// Activate — delete ALL old caches, claim clients, then navigate each open window
// to force a fresh HTML load (bypasses any stale cached page content)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then(clients => Promise.all(clients.map(client => client.navigate(client.url))))
  );
});

// Fetch — HTML is always fetched from network (never cached), other assets cache-first
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // Never cache HTML — always serve fresh from network so deploys are instant
  if (event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(fetch(event.request).catch(() => new Response('Offline', { status: 503 })));
    return;
  }

  // API calls — network only (no caching)
  if (event.request.url.includes('/vibes-api/')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response('Offline', { status: 503 }))
    );
    return;
  }

  // Static assets (JS, CSS, images) — cache first, update in background
  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request).then(res => {
        if (res && res.status === 200 && res.type !== 'error') {
          caches.open(CACHE_NAME).then(c => c.put(event.request, res.clone()));
        }
        return res;
      });
      return cached || network;
    })
  );
});

// Messages from page
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// Push notifications
self.addEventListener('push', event => {
  let data = { title: 'Vibes', body: 'New message' };
  try { data = event.data.json(); } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Vibes', {
      body: data.body || 'New message',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'vibes-msg',
      data: data.data || {},
      renotify: true
    }).then(() => {
      if ('setAppBadge' in self.navigator) {
        const count = (data.data && data.data.unreadCount) || 1;
        return self.navigator.setAppBadge(count).catch(() => {});
      }
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if ('clearAppBadge' in self.navigator) self.navigator.clearAppBadge().catch(() => {});
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if (c.url && 'focus' in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
