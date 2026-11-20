// 呱咩小窩帳｜背景小幫手（Service Worker）
// 負責：接收推播並顯示通知、點通知時打開 APP。
// 不快取帳目資料（避免看到舊的帳），只在沒網路時顯示提示頁。

const VERSION = 'preview-2';
const OFFLINE_URL = './offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll([OFFLINE_URL, './icons/記帳APP 圖示.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

// 網頁、程式、樣式：每次都向 GitHub 確認有沒有新版本（沒變就很快，有變就拿新的），
// 避免手機暫存 10 分鐘、更新後還看到舊畫面。沒網路時才顯示離線頁。
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const sameSite = new URL(req.url).origin === self.location.origin;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req, { cache: 'no-cache' }).catch(() => caches.match(OFFLINE_URL)));
    return;
  }
  if (sameSite && ['script', 'style', 'manifest'].includes(req.destination)) {
    event.respondWith(fetch(req, { cache: 'no-cache' }).catch(() => fetch(req)));
  }
});

// 收到推播 → 顯示通知
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() };
  }
  // 如果 APP 正開著，請畫面馬上重新抓資料（同步更新）
  const tellPages = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((wins) => wins.forEach((w) => w.postMessage({ type: 'refresh' })));
  event.waitUntil(Promise.all([tellPages,
    self.registration.showNotification(data.title || '呱咩小窩帳', {
      body: data.body || '有新的消息',
      icon: './icons/記帳APP 圖示.png',
      badge: './icons/記帳APP 圖示.png',
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      data: { url: data.url || './' },
    }),
  ]));
});

// 點通知 → 打開（或切換到）APP
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const existing = wins.find((w) => w.url.startsWith(self.registration.scope));
      if (existing) {
        existing.navigate(target).catch(() => {});
        return existing.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
