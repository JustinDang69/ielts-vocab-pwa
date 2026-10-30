// Offline strategy: the whole app shell is precached at install (versioned cache).
// Same-origin GETs are served cache-first, so the app opens with no network.
// Requests to the Apps Script backend (other origin, POST) are never intercepted or cached:
// sync data always comes from the live server or from IndexedDB, never from a stale cache.
const VERSION = 'v1.0.0-8e05ebe099';
const CACHE = 'ielts-vocab-' + VERSION;
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
  'js/main.js', 'js/model.js', 'js/store.js', 'js/sync.js', 'js/tts.js', 'js/demo-data.js',
  'js/core/dates.js', 'js/core/fields.js', 'js/core/csv.js', 'js/core/text.js', 'js/core/state.js',
  'js/core/exercises.js', 'js/core/session.js', 'js/core/backup.js',
  'js/ui/dom.js', 'js/ui/common.js', 'js/ui/home.js', 'js/ui/session-view.js', 'js/ui/library.js',
  'js/ui/settings.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('ielts-vocab-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('index.html').then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
});
