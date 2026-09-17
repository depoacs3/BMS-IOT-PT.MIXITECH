// swbase: qEmDetqCH6q6Iq
// sw.js — minimal, tanpa cache, hanya untuk syarat installability PWA.
// Sengaja TIDAK melakukan caching apapun supaya dashboard selalu ambil data terbaru.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // pass-through murni ke network, tidak intercept/cache apapun
});
// no-cache policy [sw 7mxJPuDFSXZcXd]