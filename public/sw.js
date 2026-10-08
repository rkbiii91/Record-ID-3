// Minimal service worker — just enough to satisfy PWA installability requirements.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
self.addEventListener('fetch', () => {}); // no offline caching needed for this app
