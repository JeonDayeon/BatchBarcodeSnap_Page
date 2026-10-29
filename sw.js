const CACHE_NAME = "batchbarcode-shell-v19";
const LIVE_SHELL=["./live-decoder.js?v=19","./live-worker.js?v=19","./native-decoder.js?v=19","./camera-photo.js?v=19"];
const SHELL = ["./photo-job-queue.js?v=19", "./photo-review.js?v=19", "./", "./index.html", "./styles.css?v=19", "./app.js?v=19", "./web-parity.js?v=19", "./document-files.js?v=19", "./photo-decoder.js?v=19", "./photo-worker.js?v=19", "./photo-engine.js?v=19", "./vendor/zxing-wasm/reader.js", "./vendor/zxing-wasm/share.js", "./vendor/zxing-wasm/zxing_reader.wasm", "./help.html", "./help.css?v=web19", "./help.js?v=web19", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll([...SHELL,...LIVE_SHELL])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("batchbarcode-shell-") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  // Check the current shell first so a previous installation cannot mask fixes.
  event.respondWith(fetch(request).then(async response => {
    if (response.ok) { const cache = await caches.open(CACHE_NAME); await cache.put(request, response.clone()); }
    return response;
  }).catch(async () => {
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(request) || (request.mode === 'navigate' ? await cache.match('./index.html') : null) || Response.error();
  }));
});


