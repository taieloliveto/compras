/* Service worker de Compras: la app abre sin conexión. Los datos viven en localStorage y se sincronizan aparte. */
const V = 'compras-v4';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'merge.js', 'config.js', 'manifest.webmanifest', 'img/pattern.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // la API del servidor nunca se cachea

  // Páginas: primero la red (así llegan las versiones nuevas), con la copia guardada como respaldo.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(r => { const copy = r.clone(); caches.open(V).then(c => c.put('index.html', copy)); return r; })
        .catch(() => caches.match('index.html'))
    );
    return;
  }

  // Resto: lo guardado al instante y se actualiza en segundo plano.
  e.respondWith(
    caches.open(V).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r && r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    })
  );
});
