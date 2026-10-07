const CACHE = 'a22-chat-v2';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Сетевой-first для всего, КРОМЕ api и socket.io и uploads
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/chat/api/') ||
      url.pathname.startsWith('/socket.io/') ||
      url.pathname.startsWith('/uploads/')) return;

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.status === 200 && fresh.type === 'basic') {
        const clone = fresh.clone();
        caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      throw err;
    }
  })());
});

self.addEventListener('push', e => {
  if (!e.data) return;
  let payload = {};
  try { payload = e.data.json(); } catch { payload = { body: e.data.text() }; }
  const title = payload.title || 'a22 Chat';
  const opts = {
    body: payload.body || '',
    icon: payload.icon || '/icon.svg',
    badge: '/icon.svg',
    tag: payload.tag || 'chat-' + Date.now(),
    data: { chatId: payload.chatId || null }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const chatId = (e.notification.data && e.notification.data.chatId) || null;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === location.origin) {
        await c.focus();
        c.postMessage({ type: 'open-chat', chatId });
        return;
      }
    }
    await self.clients.openWindow(chatId ? '/?chat=' + chatId : '/');
  })());
});
