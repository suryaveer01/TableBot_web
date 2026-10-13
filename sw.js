// Caches the app so it still opens at the table with no signal. Stale-while-revalidate: serve the
// cached copy immediately and refresh it in the background, so a push to GitHub Pages shows up on
// the next launch. Bump CACHE when the file list changes.
const CACHE = 'tablebot-v2';
const FILES = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/protocol.js',
  'js/robot.js',
  'js/calibration.js',
  'data/base-conf.json',
  'data/basic-trainings.json',
  'data/advanced-trainings.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
