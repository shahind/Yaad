// Service worker for the web build: the app shell is precached; dictionary data files are
// cached the first time they are used (or all at once from Settings), so the web version
// keeps working offline.
const SHELL = 'yaad-shell-v1';
const DATA = 'yaad-data-v1';
const SHELL_FILES = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/search.worker.js',
  'js/normalize.js',
  'js/render.js',
  'js/store.js',
  'js/platform.js',
  'js/inflate.js',
  'js/boot.js',
  'js/vendor/capacitor.js',
  'fonts/Vazirmatn.woff2',
  'icons/mark.png',
  'icons/favicon-64.png',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isData = url.pathname.includes('/data/');
  if (isData && !url.pathname.endsWith('meta.json')) {
    // Data files are immutable for a given build: cache first.
    e.respondWith(
      caches.open(DATA).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      }),
    );
    return;
  }
  // Shell and meta: network first, fall back to cache when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(isData ? DATA : SHELL).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
