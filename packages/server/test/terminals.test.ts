import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';

import type { TerminalSession } from '@zhunzou/shared';

import { createTestContext, sleep, waitFor } from './helpers.js';

const ENV = 'home-mac';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

function wsServerUrl(ctx: Ctx, path: string): string {
  const address = ctx.app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server is not listening');
  }
  return `ws://127.0.0.1:${address.port}${path}`;
}

interface OpenedSocket {
  socket: WebSocket;
  frames: Array<Record<string, unknown>>;
}

function collect(socket: WebSocket): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  socket.on('message', (data) => {
    try {
      frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
    } catch {
      // ignore
    }
  });
  return frames;
}

async function openSocket(
  url: string,
  headers: Record<string, string> = {},
): Promise<OpenedSocket> {
  const socket = new WebSocket(url, { headers });
  const frames = collect(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      reject(new Error(`unexpected response ${response.statusCode}`));
    });
  });
  return { socket, frames };
}

function capabilities() {
  return {
    protocol: 1,
    os: 'darwin',
    arch: 'arm64',
    hostname: 'macbook',
    shell: '/bin/zsh',
    pty: { available: true, backend: 'forkpty', shell: '/bin/zsh' },
    tools: [{ name: 'node' }],
    features: ['ws', 'heartbeat', 'pty'],
  };
}

describe('terminal manager', () => {
  it('creates a PTY session, streams output, forwards input and closes', async () => {
    const ctx = await createTestContext();
    try {
      await ctx.app.listen({ port: 0, host: '127.0.0.1' });

      const device = await openSocket(
        wsServerUrl(ctx, `/ws/device?env=${ENV}`),
        ctx.auth,
      );
      device.socket.send(
        JSON.stringify({
          type: 'hello',
          protocol: 1,
          env: ENV,
          capabilities: capabilities(),
        }),
      );
      await waitFor(() =>
        device.frames.find((frame) => frame.type === 'ready'),
      );

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/terminals',
        headers: ctx.auth,
        payload: { env: ENV, title: 'test shell', cols: 100, rows: 30 },
      });
      expect(created.statusCode).toBe(201);
      const session = created.json().session as TerminalSession;
      expect(session).toMatchObject({
        env: ENV,
        title: 'test shell',
        status: 'STARTING',
        cols: 100,
        rows: 30,
      });

      const createFrame = await waitFor(() =>
        device.frames.find(
          (frame) =>
            frame.type === 'pty.create' && frame.sessionId === session.id,
        ),
      );
      expect(createFrame).toMatchObject({ cols: 100, rows: 30 });

      device.socket.send(
        JSON.stringify({
          type: 'pty.ready',
          sessionId: session.id,
          pid: 1234,
          shell: '/bin/zsh',
        }),
      );
      device.socket.send(
        JSON.stringify({
          type: 'pty.output',
          sessionId: session.id,
          seq: 1,
          data: 'hello\n',
        }),
      );
      device.socket.send(
        JSON.stringify({
          type: 'pty.output',
          sessionId: session.id,
          seq: 2,
          data: 'world\n',
        }),
      );

      await sleep(50);

      const fetched = await ctx.app.inject({
        method: 'GET',
        url: `/api/terminals/${session.id}`,
        headers: ctx.auth,
      });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json().session.status).toBe('ACTIVE');

      const ticketResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/realtime/ticket',
        headers: ctx.auth,
      });
      const { ticket } = ticketResponse.json() as { ticket: string };

      const viewer = await openSocket(
        wsServerUrl(
          ctx,
          `/ws/terminal?sessionId=${session.id}&ticket=${encodeURIComponent(ticket)}&afterSeq=0`,
        ),
      );

      const viewerReady = await waitFor(() =>
        viewer.frames.find((frame) => frame.type === 'terminal.ready'),
      );
      expect(viewerReady).toMatchObject({
        type: 'terminal.ready',
        sessionId: session.id,
      });
      expect(viewerReady.writerId).toBe(viewerReady.viewerId);
      const firstViewerId = String(viewerReady.viewerId);
      await waitFor(
        () =>
          viewer.frames.filter((frame) => frame.type === 'terminal.output')
            .length >= 2,
      );
      const output = viewer.frames
        .filter((frame) => frame.type === 'terminal.output')
        .map((frame) => frame.data)
        .join('');
      expect(output).toContain('hello');
      expect(output).toContain('world');

      viewer.socket.send(JSON.stringify({ type: 'terminal.input', data: 'ls\r' }));
      const inputFrame = await waitFor(() =>
        device.frames.find((frame) => frame.type === 'pty.input'),
      );
      expect(inputFrame).toMatchObject({ sessionId: session.id, data: 'ls\r' });

      viewer.socket.send(
        JSON.stringify({ type: 'terminal.resize', cols: 120, rows: 40 }),
      );
      const resizeFrame = await waitFor(() =>
        device.frames.find((frame) => frame.type === 'pty.resize'),
      );
      expect(resizeFrame).toMatchObject({ cols: 120, rows: 40 });

      viewer.socket.send(
        JSON.stringify({ type: 'terminal.signal', signal: 'SIGINT' }),
      );
      const signalFrame = await waitFor(() =>
        device.frames.find((frame) => frame.type === 'pty.signal'),
      );
      expect(signalFrame).toMatchObject({ signal: 'SIGINT' });

      // A second viewer starts read-only; claiming control transfers input.
      const second = await openSocket(
        wsServerUrl(
          ctx,
          `/ws/terminal?sessionId=${session.id}&ticket=${encodeURIComponent(ticket)}&afterSeq=2`,
        ),
      );
      const secondReady = await waitFor(() =>
        second.frames.find((frame) => frame.type === 'terminal.ready'),
      );
      expect(secondReady.writerId).toBe(firstViewerId);
      const secondViewerId = String(secondReady.viewerId);

      const inputCountBefore = device.frames.filter(
        (frame) => frame.type === 'pty.input',
      ).length;
      second.socket.send(
        JSON.stringify({ type: 'terminal.input', data: 'rm -rf\r' }),
      );
      const readOnly = await waitFor(() =>
        second.frames.find(
          (frame) =>
            frame.type === 'terminal.error' && frame.code === 'READ_ONLY',
        ),
      );
      expect(readOnly).toMatchObject({ code: 'READ_ONLY' });
      expect(
        device.frames.filter((frame) => frame.type === 'pty.input'),
      ).toHaveLength(inputCountBefore);

      second.socket.send(JSON.stringify({ type: 'terminal.claim', label: 'e2e' }));
      const control = await waitFor(() =>
        second.frames.find(
          (frame) =>
            frame.type === 'terminal.control' &&
            frame.writerId === secondViewerId,
        ),
      );
      expect(control).toMatchObject({ writerId: secondViewerId });

      second.socket.send(JSON.stringify({ type: 'terminal.input', data: 'pwd\r' }));
      const secondInput = await waitFor(() =>
        device.frames.find(
          (frame) => frame.type === 'pty.input' && frame.data === 'pwd\r',
        ),
      );
      expect(secondInput).toMatchObject({ data: 'pwd\r' });

      const audit = await ctx.app.inject({
        method: 'GET',
        url: `/api/terminals/${session.id}/audit`,
        headers: ctx.auth,
      });
      expect(audit.statusCode).toBe(200);
      const kinds = (audit.json().entries as Array<{ kind: string }>).map(
        (entry) => entry.kind,
      );
      expect(kinds).toContain('CREATE');
      expect(kinds).toContain('INPUT');
      expect(kinds).toContain('CLAIM');
      expect(kinds).toContain('SIGNAL');

      const exported = await ctx.app.inject({
        method: 'GET',
        url: `/api/terminals/${session.id}/audit/export?format=csv`,
        headers: ctx.auth,
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.headers['content-type']).toContain('text/csv');
      expect(exported.body).toContain('kind');
      expect(exported.body).toContain('INPUT');

      const stats = await ctx.app.inject({
        method: 'GET',
        url: '/api/terminals/stats',
        headers: ctx.auth,
      });
      expect(stats.json()).toMatchObject({
        enabled: true,
        active: 1,
        viewers: 2,
        sessionsCreated: 1,
      });
      expect(stats.json().inputBytes).toBeGreaterThan(0);
      expect(stats.json().outputBytes).toBeGreaterThan(0);

      second.socket.close();

      device.socket.send(
        JSON.stringify({
          type: 'pty.exit',
          sessionId: session.id,
          code: 0,
        }),
      );
      await waitFor(() =>
        viewer.frames.find((frame) => frame.type === 'terminal.exit'),
      );

      const closed = await ctx.app.inject({
        method: 'GET',
        url: `/api/terminals/${session.id}`,
        headers: ctx.auth,
      });
      expect(closed.json().session.status).toBe('CLOSED');

      viewer.socket.close();
      device.socket.close();
      await sleep(20);
    } finally {
      await ctx.close();
    }
  });

  it('refuses to create a terminal on an offline device', async () => {
    const ctx = await createTestContext();
    try {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/terminals',
        headers: ctx.auth,
        payload: { env: 'offline-device', cols: 80, rows: 24 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('DEVICE_OFFLINE');
    } finally {
      await ctx.close();
    }
  });


  it('honours the per-device terminal enable flag', async () => {
    const ctx = await createTestContext();
    try {
      await ctx.app.listen({ port: 0, host: '127.0.0.1' });
      const device = await openSocket(
        wsServerUrl(ctx, `/ws/device?env=${ENV}`),
        ctx.auth,
      );
      device.socket.send(
        JSON.stringify({
          type: 'hello',
          protocol: 1,
          env: ENV,
          capabilities: capabilities(),
        }),
      );
      await waitFor(() =>
        device.frames.find((frame) => frame.type === 'ready'),
      );
      await sleep(50);

      const patched = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/agents/${ENV}`,
        headers: ctx.auth,
        payload: { terminalEnabled: false },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().agent.terminalEnabled).toBe(false);

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/terminals',
        headers: ctx.auth,
        payload: { env: ENV, cols: 80, rows: 24 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('TERMINAL_FORBIDDEN');

      device.socket.close();
      await sleep(20);
    } finally {
      await ctx.close();
    }
  });

  it('enforces TERMINAL_ALLOWED_ENVS before touching a device', async () => {
    const ctx = await createTestContext(undefined, undefined, {
      TERMINAL_ALLOWED_ENVS: 'other-device',
    });
    try {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/terminals',
        headers: ctx.auth,
        payload: { env: ENV, cols: 80, rows: 24 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('TERMINAL_FORBIDDEN');
    } finally {
      await ctx.close();
    }
  });
});
