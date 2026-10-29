const CACHE_NAME = "batchbarcode-shell-v18";
const LIVE_SHELL=["./live-decoder.js?v=18","./live-worker.js?v=18","./native-decoder.js?v=18","./camera-photo.js?v=18"];
const SHELL = ["./", "./index.html", "./styles.css?v=18", "./app.js?v=18", "./web-parity.js?v=18", "./document-files.js?v=18", "./photo-decoder.js?v=18", "./photo-worker.js?v=18", "./photo-engine.js?v=18", "./vendor/zxing-wasm/reader.js", "./vendor/zxing-wasm/share.js", "./vendor/zxing-wasm/zxing_reader.wasm", "./help.html", "./help.css?v=web18", "./help.js?v=web18", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

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


