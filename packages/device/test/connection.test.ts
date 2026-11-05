import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';

import type { DeviceCapabilities } from '@zhunzou/shared';

import { createDeviceConnection } from '../src/connection.js';
import type { DeviceConfig } from '../src/config.js';

const capabilities: DeviceCapabilities = {
  protocol: 1,
  os: 'darwin',
  arch: 'arm64',
  hostname: 'test-mac',
  shell: '/bin/zsh',
  pty: { available: false, backend: 'none', shell: '/bin/zsh' },
  tools: [{ name: 'node', version: 'v22.0.0' }],
  features: ['ws', 'heartbeat'],
};

function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 3_000,
): Promise<T> {
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

describe('device connection', () => {
  it('sends hello with auth, capabilities and heartbeats', async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const received: Array<Record<string, unknown>> = [];
    let authHeader = '';

    wss.on('connection', (socket, request) => {
      authHeader = request.headers.authorization ?? '';
      socket.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(frame);
        if (frame.type === 'hello') {
          socket.send(
            JSON.stringify({
              type: 'ready',
              protocol: 1,
              serverTime: Date.now(),
              heartbeatMs: 60,
              role: 'device',
              env: 'test-mac',
            }),
          );
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;

    const config: DeviceConfig = {
      hubUrl: `http://127.0.0.1:${address.port}`,
      token: 'zz_test_token',
      env: 'test-mac',
      heartbeatMs: 60,
      reconnectMinMs: 100,
      reconnectMaxMs: 500,
    };

    const connection = createDeviceConnection({
      config,
      capabilities,
      stats: () => ({ cpuCount: 4, load1: 0.5 }),
      autoReconnect: false,
      log: () => undefined,
      error: () => undefined,
    });

    try {
      connection.start();

      const hello = await waitFor(() =>
        received.find((frame) => frame.type === 'hello'),
      );
      expect(authHeader).toBe('Bearer zz_test_token');
      expect(hello).toMatchObject({
        type: 'hello',
        protocol: 1,
        env: 'test-mac',
      });
      expect(
        (hello.capabilities as DeviceCapabilities).tools[0]?.name,
      ).toBe('node');
      expect((hello.stats as { cpuCount: number }).cpuCount).toBe(4);

      const heartbeat = await waitFor(() =>
        received.find((frame) => frame.type === 'heartbeat'),
      );
      expect((heartbeat.stats as { load1: number }).load1).toBe(0.5);
      expect(connection.connected).toBe(true);
    } finally {
      connection.stop();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
