// 간단한 오프라인 캐시 — 앱 껍데기는 캐시, API는 항상 네트워크
const CACHE = "recipe-tube-v10";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/icon.svg", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return; // API는 브라우저 기본 처리(네트워크)
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      if (res.ok && e.request.method === "GET") caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match("/index.html")))
  );
});
