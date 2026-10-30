// Minimal service worker so the app can be installed. Everything goes to the
// network: notes must never be served stale from a cache.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
