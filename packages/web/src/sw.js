/**
 * Zhunzou dashboard service worker.
 *
 * Hand-written on purpose (no Workbox): the app is a single-bundle SPA, so a
 * small runtime cache is enough and keeps the dependency tree flat.
 *
 * This file lives in `src/` so the Vite config can emit it with a per-build id
 * (`__BUILD_ID__`). That id changes the script bytes on every deploy, which is
 * what lets an already-open app discover updates via `registration.update()`.
 *
 * Strategy
 * - navigation: network-first, fall back to the cached page / shell / offline page
 * - hashed build output (/assets/): stale-while-revalidate
 * - icons / manifest: stale-while-revalidate
 * - API, health checks and release downloads: never intercepted
 *
 * Bump CACHE_VERSION whenever the caching behaviour below changes; the old
 * caches are dropped on activate.
 *
 * Build: __BUILD_ID__
 */

/** Stamped by vite.config.ts; the page compares this with its own bundle id. */
const BUILD_ID = '__BUILD_ID__';

const CACHE_VERSION = 'zhunzou-v2';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;
const OFFLINE_URL = '/offline.html';
const SHELL_URLS = [
  '/',
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

/** Paths that must always hit the network: they carry auth or live data. */
const BYPASS_PREFIXES = ['/api/', '/releases/', '/a/'];
const BYPASS_PATHS = ['/healthz'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // A failed precache must not wedge the install (offline first visit).
      await Promise.all(
        SHELL_URLS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch {
            /* optional shell entry */
          }
        }),
      );
      // New versions wait here until the page asks for them, so the user can
      // keep working and apply the update from the in-app prompt.
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
    return;
  }

  // The page asks which build this worker carries. If it matches the running
  // bundle, a manual refresh already applied the update and no prompt is due.
  if (data.type === 'BUILD_ID') {
    const reply = { type: 'BUILD_ID', buildId: BUILD_ID };
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage(reply);
    } else if (event.source && event.source.postMessage) {
      event.source.postMessage(reply);
    }
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => !name.startsWith(CACHE_VERSION))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function isBypassed(url) {
  if (url.origin !== self.location.origin) return true;
  if (BYPASS_PATHS.includes(url.pathname)) return true;
  return BYPASS_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

/** Network-first with a cache fallback, used for HTML navigations. */
async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const cachedPage = await cache.match(request);
    if (cachedPage) return cachedPage;
    const cachedShell = await cache.match('/');
    if (cachedShell) return cachedShell;
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response('Offline', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}

/** Stale-while-revalidate: instant paint, refresh in the background. */
async function handleAsset(event, cacheName) {
  const { request } = event;
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then(async (response) => {
      if (response && response.ok) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Best-effort refresh: the cached copy answers this request immediately,
    // the network update lands in the cache for the next navigation.
    return cached;
  }

  const response = await network;
  if (response) return response;
  return new Response('Offline', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (isBypassed(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(handleAsset(event, ASSET_CACHE));
    return;
  }

  if (
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest'
  ) {
    event.respondWith(handleAsset(event, SHELL_CACHE));
  }
});
