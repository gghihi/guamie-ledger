// 呱咩小窩帳｜背景小幫手（Service Worker）
// 負責：接收推播並顯示通知、點通知時打開 APP。
// 不快取帳目資料（避免看到舊的帳），只在沒網路時顯示提示頁。

const VERSION = 'v11-1';
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

// 只有「打開頁面」沒網路時才顯示離線頁；其他一律走網路，確保資料是最新的
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});

// 收到推播 → 顯示通知
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || '呱咩小窩帳', {
      body: data.body || '有新的消息',
      icon: './icons/記帳APP 圖示.png',
      badge: './icons/記帳APP 圖示.png',
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      data: { url: data.url || './' },
    }),
  );
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
