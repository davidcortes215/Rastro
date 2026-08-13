/* ==========================================================================
   Rastro — service worker
   Permite instalar la app y usarla sin conexión.

   Estrategia: "red primero, caché de reserva" para los archivos propios.
   Así una versión nueva llega siempre que haya conexión (importante, porque
   se publican cambios a menudo) y, sin conexión, la app sigue abriendo.

   Las peticiones a otros dominios (teselas del mapa, Supabase, Overpass) no
   se interceptan: se dejan pasar tal cual.
   ========================================================================== */
var CACHE = "rastro-v3";
var CORE = [
  "./",
  "./index.html",
  "./styles.css",
  "./config.js",
  "./store.js",
  "./app.js",
  "./cloud.js",
  "./pwa.js",
  "./manifest.json",
  "./icono-64.png",
  "./icono-180.png",
  "./icono-192.png",
  "./icono-512.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(CORE); })
      .catch(function () { /* si algo no se puede guardar, se instala igual */ })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (claves) {
      return Promise.all(claves.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;   // mapas y servicios: sin tocar

  // Se pide siempre con revalidación: GitHub Pages marca los archivos como
  // cacheables varios minutos y, sin esto, la versión antigua del navegador
  // se servía como si fuera la buena y los cambios no llegaban.
  // Para navegaciones se construye desde la URL: no se puede crear un
  // Request nuevo a partir de otro en modo "navigate".
  var peticion = (req.mode === "navigate")
    ? fetch(req.url, { cache: "no-cache", credentials: "same-origin" })
    : fetch(req, { cache: "no-cache" });

  e.respondWith(
    peticion.then(function (res) {
      if (res && res.status === 200 && res.type === "basic") {
        var copia = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copia); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        // Sin conexión: lo guardado, y para navegaciones la propia app.
        return hit || (req.mode === "navigate" ? caches.match("./index.html") : Response.error());
      });
    })
  );
});
