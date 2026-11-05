import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';

import type { Agent } from '@zhunzou/shared';

import { createTestContext, sleep, ticketInput, waitFor } from './helpers.js';

const ENV = 'home-mac';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

function serverUrl(ctx: Ctx, path: string): string {
  const address = ctx.app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server is not listening');
  }
  return `ws://127.0.0.1:${address.port}${path}`;
}

function frames(socket: WebSocket): Array<Record<string, unknown>> {
  const received: Array<Record<string, unknown>> = [];
  socket.on('message', (data) => {
    try {
      received.push(JSON.parse(data.toString()) as Record<string, unknown>);
    } catch {
      // ignore malformed frames in tests
    }
  });
  return received;
}

async function openSocket(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ socket: WebSocket; received: Array<Record<string, unknown>> }> {
  const socket = new WebSocket(url, { headers });
  // Attach the collector before the handshake completes: the server sends
  // `ready` immediately, and it can arrive before `open` resolves.
  const received = frames(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      reject(new Error(`unexpected response ${response.statusCode}`));
    });
  });
  return { socket, received };
}

async function capabilitiesPayload() {
  return {
    protocol: 1,
    os: 'darwin',
    arch: 'arm64',
    hostname: 'macbook',
    shell: '/bin/zsh',
    pty: { available: false, backend: 'none', shell: '/bin/zsh' },
    tools: [
      { name: 'git', version: 'git version 2.45.0' },
      { name: 'opencode', version: '0.6.0' },
    ],
    features: ['ws', 'heartbeat'],
  };
}

describe('realtime gateway', () => {
  it('accepts a device hello and persists its capabilities', async () => {
    const ctx = await createTestContext();
    try {
      await ctx.app.listen({ port: 0, host: '127.0.0.1' });

      const { socket, received } = await openSocket(
        serverUrl(ctx, `/ws/device?env=${ENV}`),
        ctx.auth,
      );

      await waitFor(() => received.find((frame) => frame.type === 'ready'));

      socket.send(
        JSON.stringify({
          type: 'hello',
          protocol: 1,
          env: ENV,
          capabilities: await capabilitiesPayload(),
          stats: { cpuCount: 8, load1: 1.25, totalMemBytes: 16 * 1024 ** 3 },
        }),
      );

      // device.updated is broadcast to dashboards, not echoed to the device.
      // Poll the registry endpoint instead so this test covers persistence.
      let agent: Agent | undefined;
      const deadline = Date.now() + 3_000;
      while (!agent && Date.now() < deadline) {
        const response = await ctx.app.inject({
          method: 'GET',
          url: '/api/agents',
          headers: ctx.auth,
        });
        agent = (response.json().agents as Agent[])[0];
        if (!agent) await sleep(25);
      }
      expect(agent).toBeTruthy();
      expect(agent!).toMatchObject({
        env: ENV,
        transport: 'ws',
        protocolVersion: 1,
        host: 'macbook',
        os: 'darwin-arm64',
      });
      expect(agent!.capabilities?.tools.map((tool) => tool.name)).toEqual([
        'git',
        'opencode',
      ]);
      expect(agent!.deviceStats?.cpuCount).toBe(8);

      const status = await ctx.app.inject({
        method: 'GET',
        url: '/api/status',
        headers: ctx.auth,
      });
      const [heartbeat] = status.json().envs as Array<{ env: string; online: boolean }>;
      expect(heartbeat).toMatchObject({ env: ENV, online: true });

      socket.close();
      await sleep(20);
    } finally {
      await ctx.close();
    }
  });

  it('pushes presence updates to a dashboard ticket socket', async () => {
    const ctx = await createTestContext();
    try {
      await ctx.app.listen({ port: 0, host: '127.0.0.1' });

      const ticketResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/realtime/ticket',
        headers: ctx.auth,
      });
      expect(ticketResponse.statusCode).toBe(200);
      const { ticket } = ticketResponse.json() as { ticket: string };

      const { socket: dashboard, received: dashboardFrames } = await openSocket(
        serverUrl(ctx, `/ws/realtime?ticket=${encodeURIComponent(ticket)}`),
      );
      const ready = await waitFor(() =>
        dashboardFrames.find((frame) => frame.type === 'ready'),
      );
      expect(ready).toMatchObject({ role: 'dashboard' });

      const { socket: device } = await openSocket(
        serverUrl(ctx, `/ws/device?env=${ENV}`),
        ctx.auth,
      );
      device.send(
        JSON.stringify({
          type: 'hello',
          protocol: 1,
          env: ENV,
          capabilities: await capabilitiesPayload(),
        }),
      );

      const update = await waitFor(() =>
        dashboardFrames.find((frame) => frame.type === 'device.updated'),
      );
      expect(update).toMatchObject({ type: 'device.updated' });

      device.close();
      const offline = await waitFor(() =>
        dashboardFrames.find((frame) => frame.type === 'device.offline'),
      );
      expect(offline).toMatchObject({ type: 'device.offline', env: ENV });

      const afterClose = await ctx.app.inject({
        method: 'GET',
        url: '/api/agents',
        headers: ctx.auth,
      });
      const [closedAgent] = afterClose.json().agents as Agent[];
      expect(closedAgent).toMatchObject({ online: false, connected: false });

      dashboard.close();
      await sleep(20);
    } finally {
      await ctx.close();
    }
  });


  it('pushes dashboard snapshots and change frames over WebSocket', async () => {
    const ctx = await createTestContext();
    try {
      await ctx.app.listen({ port: 0, host: '127.0.0.1' });

      const ticketResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/realtime/ticket',
        headers: ctx.auth,
      });
      const { ticket } = ticketResponse.json() as { ticket: string };

      const { socket, received } = await openSocket(
        serverUrl(ctx, `/ws/realtime?ticket=${encodeURIComponent(ticket)}`),
      );

      const initial = await waitFor(() =>
        received.find((frame) => frame.type === 'sync.snapshot'),
      );
      expect(initial).toMatchObject({ type: 'sync.snapshot' });

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: ctx.auth,
        payload: ticketInput(),
      });
      expect(created.statusCode).toBe(201);

      await waitFor(
        () => received.find((frame) => frame.type === 'sync.changed'),
        { timeoutMs: 4_000 },
      );

      socket.send(JSON.stringify({ type: 'sync.request' }));
      const snapshot = await waitFor(
        () =>
          received.find(
            (frame) =>
              frame.type === 'sync.snapshot' &&
              Array.isArray(
                (frame.state as { tickets?: unknown[] } | undefined)?.tickets,
              ) &&
              ((frame.state as { tickets: unknown[] }).tickets.length ?? 0) > 0,
          ),
        { timeoutMs: 4_000 },
      );
      expect(snapshot).toMatchObject({ type: 'sync.snapshot' });

      socket.close();
      await sleep(20);
    } finally {
      await ctx.close();
    }
  });

  it('rejects a dashboard socket without a valid ticket', async () => {
    const ctx = await createTestContext();
    try {
      await ctx.app.listen({ port: 0, host: '127.0.0.1' });
      await expect(
        openSocket(serverUrl(ctx, '/ws/realtime?ticket=bad')),
      ).rejects.toBeTruthy();
    } finally {
      await ctx.close();
    }
  });

  it('can be disabled without affecting the HTTP API', async () => {
    const ctx = await createTestContext(undefined, undefined, {
      REALTIME_ENABLED: 'false',
    });
    try {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/realtime/ticket',
        headers: ctx.auth,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('REALTIME_DISABLED');

      const health = await ctx.app.inject({ method: 'GET', url: '/healthz' });
      expect(health.statusCode).toBe(200);
    } finally {
      await ctx.close();
    }
  });
});
