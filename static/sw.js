/* Service worker for the installed app.
 *
 * Prices must never be stale, so /api/ requests are always a straight trip to
 * the network and are never stored. Everything else — pages, styles, modules,
 * icons — is network-first with a cached copy behind it: a redeploy is picked
 * up on the next load exactly as the must-revalidate headers intend, and a
 * launch with no signal still opens the app instead of Safari's error page.
 */
const VERSION = "v1";
const CACHE = `stock-watcher-${VERSION}`;

// The watchlist window and what it needs, so the very first offline launch
// works. Every other page is cached the first time it is visited.
const SHELL = [
  "/index.html",
  "/styles.css",
  "/app.js",
  "/analyze.mjs",
  "/insider-model.mjs",
  "/score.mjs",
  "/detail.mjs",
  "/watchlist.mjs",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})          // a missing file must not block the install
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;   // live data, never cached

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const hit = await caches.match(request, { ignoreSearch: true });
        if (hit) return hit;
        if (request.mode === "navigate") {
          const shell = await caches.match("/index.html");
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
