// Minimal service worker: makes the app installable and serves the shell when
// the network drops. Delivery actions are NOT queued offline - a rider must
// know whether a completion actually reached the server, so those still fail
// loudly rather than pretending to succeed.
const CACHE = "rider-shell-v1";
const SHELL = ["/", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache API traffic - stale stops or stale cash figures are worse
  // than an honest error.
  if (e.request.method !== "GET" || url.port === "3000") return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request).then((r) => r ?? caches.match("/"))),
  );
});
