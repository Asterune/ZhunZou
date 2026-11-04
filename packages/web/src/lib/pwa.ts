/**
 * PWA registration and update prompting.
 *
 * Only runs in production builds: in dev the Vite server does not serve
 * `/sw.js`, and a stale service worker would shadow hot updates.
 *
 * Update flow
 * - A new service worker is *not* activated automatically (`sw.js` waits for
 *   a `SKIP_WAITING` message). The update stays in `registration.waiting`.
 * - The UI shows a prompt (`updateReady`) and the user decides:
 *   "update now" posts the message and reloads once the new worker controls
 *   the page; "later" hides the prompt for the current session. Reopening the
 *   app finds the same waiting worker and prompts again.
 */
import { ref } from 'vue';

/** How often an open app checks `sw.js` for a new version. */
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** Reload even if `controllerchange` never arrives (activation stalled). */
const UPDATE_FALLBACK_RELOAD_MS = 8_000;

/** True when a new build is waiting and the user has not deferred it yet. */
export const updateReady = ref(false);

/** True between "update now" and the page reload. */
export const updating = ref(false);

let registration: ServiceWorkerRegistration | null = null;
let deferred = false;
let reloading = false;

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // First installs also fire this event (clients.claim()); only reload when
    // the user explicitly asked for the update.
    if (!updating.value || reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    void setup();
  });
}

/** The user chose "update now". */
export function applyUpdate(): void {
  if (updating.value) return;

  const waiting = registration?.waiting;
  if (!waiting) {
    // Nothing to hand over (already activated): a plain reload is enough.
    updating.value = true;
    reloading = true;
    window.location.reload();
    return;
  }

  updating.value = true;
  waiting.postMessage({ type: 'SKIP_WAITING' });

  window.setTimeout(() => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  }, UPDATE_FALLBACK_RELOAD_MS);
}

/** The user chose "later": stay quiet until the app is reopened. */
export function dismissUpdate(): void {
  if (updating.value) return;
  deferred = true;
  updateReady.value = false;
}

async function setup(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
    });
    registration = reg;

    // A new build may already be waiting (reopened app, or an update that
    // landed before this page registered).
    if (reg.waiting && navigator.serviceWorker.controller && !deferred) {
      updateReady.value = true;
    }

    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state !== 'installed') return;
        // No controller means this is the first install, not an update.
        if (!navigator.serviceWorker.controller) return;
        if (deferred) return;
        updateReady.value = true;
      });
    });

    // Mobile PWAs can stay open for days, so poll and also check whenever the
    // app returns to the foreground.
    window.setInterval(() => {
      void checkForUpdate();
    }, UPDATE_CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void checkForUpdate();
    });
  } catch (error) {
    // Offline caching is an enhancement; never break the dashboard over it.
    console.warn('[pwa] service worker registration failed', error);
  }
}

async function checkForUpdate(): Promise<void> {
  if (!registration || updating.value || deferred) return;
  try {
    await registration.update();
    if (registration.waiting && navigator.serviceWorker.controller) {
      updateReady.value = true;
    }
  } catch {
    // Offline or the server is unreachable: try again on the next tick.
  }
}
