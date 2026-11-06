import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

/**
 * The update prompt depends on the service worker *not* activating itself.
 * A regression here (calling `self.skipWaiting()` during install) would make
 * every deploy reload the app immediately and the prompt would never appear.
 */
const source = readFileSync(new URL('../src/sw.js', import.meta.url), 'utf8');

type ExtendableEvent = {
  data?: unknown;
  ports?: Array<{ postMessage: (message: unknown) => void }>;
  waitUntil: (promise: Promise<unknown>) => void;
};

type WorkerHarness = {
  listeners: Map<string, (event: ExtendableEvent) => void>;
  skipWaiting: ReturnType<typeof vi.fn>;
};

function loadWorker(): WorkerHarness {
  const listeners = new Map<string, (event: ExtendableEvent) => void>();
  const skipWaiting = vi.fn(async () => undefined);
  const cache = { add: vi.fn(async () => undefined), put: vi.fn(), match: vi.fn() };

  const context = {
    self: {
      addEventListener(type: string, handler: (event: ExtendableEvent) => void) {
        listeners.set(type, handler);
      },
      skipWaiting,
      clients: { claim: vi.fn(async () => undefined) },
      location: { origin: 'https://example.com' },
    },
    caches: {
      open: vi.fn(async () => cache),
      keys: vi.fn(async () => []),
      delete: vi.fn(async () => true),
    },
    fetch: vi.fn(async () => new Response('ok')),
    Request,
    Response,
    URL,
    console,
  };

  runInNewContext(source, context);
  return { listeners, skipWaiting };
}

async function dispatch(
  harness: WorkerHarness,
  type: string,
  event: Omit<ExtendableEvent, 'waitUntil'> = {},
): Promise<void> {
  const handler = harness.listeners.get(type);
  if (!handler) throw new Error(`missing "${type}" listener`);

  const pending: Promise<unknown>[] = [];
  handler({
    ...event,
    waitUntil: (promise) => pending.push(promise),
  });
  await Promise.all(pending);
}

describe('service worker update lifecycle', () => {
  it('does not skipWaiting during install, so updates can be prompted', async () => {
    const harness = loadWorker();
    await dispatch(harness, 'install');

    expect(harness.skipWaiting).not.toHaveBeenCalled();
  });

  it('activates only after the page sends SKIP_WAITING', async () => {
    const harness = loadWorker();

    await dispatch(harness, 'message', { data: { type: 'OTHER' } });
    expect(harness.skipWaiting).not.toHaveBeenCalled();

    await dispatch(harness, 'message', { data: { type: 'SKIP_WAITING' } });
    expect(harness.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('reports its build id so a refreshed page can skip a duplicate prompt', async () => {
    const harness = loadWorker();
    const reply = vi.fn();

    await dispatch(harness, 'message', {
      data: { type: 'BUILD_ID' },
      ports: [{ postMessage: reply }],
    });

    expect(reply).toHaveBeenCalledWith({
      type: 'BUILD_ID',
      buildId: '__BUILD_ID__',
    });
    expect(harness.skipWaiting).not.toHaveBeenCalled();
  });
});
