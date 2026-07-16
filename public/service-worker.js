/**
 * Service Worker — Mailer (PWA)
 *
 * Ne met en cache que la coquille de l'app (HTML/CSS/JS/icônes).
 * Les appels /api/* ne sont jamais interceptés : ce sont des données
 * dynamiques (identifiants, historique, modèles) qui doivent toujours
 * venir du réseau.
 */
const CACHE_VERSION = 'mailer-cache-v2';

const CORE_ASSETS = [
  'index.html',
  'style.css',
  'app.js',
  'cookie-consent.js',
  'install-prompt.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => Promise.allSettled(CORE_ASSETS.map((a) => cache.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          if (request.mode === 'navigate') return caches.match('index.html');
          return Response.error();
        })
      )
  );
});
