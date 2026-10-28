// Service Worker：把網頁本身與 Firebase 元件存在手機上，離線也能開啟。
// 只處理讀取網頁檔案，不處理登入或資料庫連線；帳目資料由網頁自己存放。
// 網頁每次開啟（或從其他 App 切回來）都會請瀏覽器重新下載這個檔案比對；內容不同就是有新版本。
const VERSION = 'f2f0106713f4';
const APP_CACHE = `ledger-app-${VERSION}`;
const SDK_CACHE = 'ledger-firebase-sdk';
const APP_FILES = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(APP_FILES.map(file => new Request(file, { cache: 'reload' })));
    // 網站剛更新時偶爾會先拿到舊的網頁檔；存下的不是這個版本就放棄安裝，下次開啟網頁再試，避免卡在舊版。
    const page = await cache.match('index.html');
    if (!page || !(await page.text()).includes(VERSION)) throw new Error('index.html 與 sw.js 版本不同');
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('ledger-app-') && key !== APP_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (url.searchParams.has('nosw')) return; // 測試用網址不使用快取
    if (request.mode === 'navigate') {
      event.respondWith(caches.match('index.html', { cacheName: APP_CACHE }).then(hit => hit || fetch(request)));
      return;
    }
    event.respondWith(caches.match(request, { cacheName: APP_CACHE, ignoreSearch: true }).then(hit => hit || fetch(request)));
    return;
  }
  // Firebase 元件網址含版本號，內容不會變，存一次即可離線使用。
  if (url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(caches.open(SDK_CACHE).then(async cache => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    }));
  }
});
