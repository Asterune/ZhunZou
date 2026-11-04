/**
 * PWA registration.
 *
 * Only runs in production builds: in dev the Vite server does not serve
 * `/sw.js`, and a stale service worker would shadow hot updates.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
      // Offline caching is an enhancement; never break the dashboard over it.
      console.warn('[pwa] service worker registration failed', error);
    });
  });
}
