/* DSR Researcher - network-first app shell (always revalidated, so a new version shows on the
   first reopen), offline fallback from the cache. Wikipedia requests always go to the network.
   Only ever deletes its OWN old caches: every DSR app shares the github.io origin's cache storage. */
var CACHE = 'dsr-research-v1f';
var OWN = 'dsr-research-';
var SHELL = ['./', './index.html', './mp3.js?v=1f', './app.js?v=1f', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(OWN) === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request; if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req, { cache: 'no-cache' }).then(function (res) {
    if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () { return caches.match(req).then(function (h) { return h || caches.match('./index.html'); }); }));
});
