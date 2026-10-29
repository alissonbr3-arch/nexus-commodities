const CACHE_NAME = "nexus-shell-v3";
const APP_SHELL = ["/", "/index.html", "/manifest.json", "/icon-192-v2.png", "/icon-512-v2.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first pro próprio app (index.html/manifest/ícones), pra sempre pegar a versão mais nova
// quando online, com fallback pro cache só se a rede cair. Nunca intercepta Supabase/CDNs externos.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request, { cache: "no-store" }) // sem o cache HTTP do navegador: o app sempre abre a última versão publicada
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
