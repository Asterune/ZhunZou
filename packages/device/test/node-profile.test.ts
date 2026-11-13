import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DeviceCapabilities, NodeProfile } from '@zhunzou/shared';

import { createDeviceConnection } from '../src/connection.js';
import type { DeviceConfig } from '../src/config.js';

const capabilities: DeviceCapabilities = {
  protocol: 1,
  os: 'darwin',
  arch: 'arm64',
  hostname: 'studio-mini',
  machineId: 'mm-1',
  pty: { available: false, backend: 'none', shell: '/bin/zsh' },
  tools: [],
  features: ['ws', 'heartbeat'],
};

let scanRoot = '';

beforeAll(() => {
  scanRoot = mkdtempSync(join(tmpdir(), 'zhunzou-node-'));
  const repo = join(scanRoot, 'code', 'pte-dojo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
});

afterAll(() => rmSync(scanRoot, { recursive: true, force: true }));

function waitFor<T>(probe: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      const value = probe();
      if (value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(tick, 15);
    };
    tick();
  });
}

/** Runs one device daemon against a throwaway socket server. */
async function capture(
  node: Partial<DeviceConfig['node']> | false,
  freeMemBytes: number,
): Promise<{ hello: Record<string, unknown>; heartbeat: Record<string, unknown> }> {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const received: Array<Record<string, unknown>> = [];

  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      received.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  const config: DeviceConfig = {
    hubUrl: `http://127.0.0.1:${address.port}`,
    token: 'zz_test_token',
    env: 'studio-mini',
    heartbeatMs: 40,
    reconnectMinMs: 100,
    reconnectMaxMs: 500,
    ...(node === false ? {} : { node: { role: 'hybrid', tags: ['gpu'], ...(node ?? {}) } }),
  };

  const connection = createDeviceConnection({
    config,
    capabilities,
    stats: () => ({ cpuCount: 8, freeMemBytes }),
    autoReconnect: false,
    log: () => undefined,
    error: () => undefined,
  });

  try {
    connection.start();
    const hello = await waitFor(() =>
      received.find((frame) => frame.type === 'hello'),
    );
    const heartbeat = await waitFor(() =>
      received.find((frame) => frame.type === 'heartbeat'),
    );
    return { hello, heartbeat };
  } finally {
    connection.stop();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('node profile reporting', () => {
  it('introduces itself with the routing profile on hello', async () => {
    const { hello } = await capture(
      { maxConcurrency: 3, scanDirs: [join(scanRoot, 'code')] },
      6 * 1024 ** 3,
    );
    const profile = hello.profile as NodeProfile;

    expect(profile).toMatchObject({
      nodeId: 'mm-1',
      hostname: 'studio-mini',
      role: 'hybrid',
      tags: ['gpu'],
      maxConcurrency: 3,
    });
    expect(profile.repos).toEqual([
      {
        name: 'pte-dojo',
        path: join(scanRoot, 'code', 'pte-dojo'),
        defaultBranch: 'main',
      },
    ]);
    expect(profile.freeMemoryMB).toBe(6144);
  });

  it('keeps the memory figure fresh on every heartbeat', async () => {
    const { heartbeat } = await capture({}, 512 * 1024 ** 2);
    const profile = heartbeat.profile as NodeProfile;

    expect(profile.freeMemoryMB).toBe(512);
    expect(profile).toMatchObject({ role: 'hybrid', maxConcurrency: 1 });
  });

  it('says nothing about routing when the machine is presence-only', async () => {
    const { hello, heartbeat } = await capture(false, 1024 ** 3);

    expect(hello).not.toHaveProperty('profile');
    expect(heartbeat).not.toHaveProperty('profile');
  });
});
