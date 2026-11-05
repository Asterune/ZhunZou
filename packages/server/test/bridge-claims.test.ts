import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';

import type { AgentTask, ChatSession, DecisionTicket } from '@zhunzou/shared';

import { createTestContext, sleep, ticketInput, waitFor } from './helpers.js';

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

describe('bridge WebSocket claims', () => {
  it('claims tasks, waits tickets and claims chat messages', async () => {
    const ctx = await createTestContext();
    try {
      await ctx.app.listen({ port: 0, host: '127.0.0.1' });

      const bridge = await openSocket(
        wsServerUrl(ctx, `/ws/bridge?env=${ENV}`),
        ctx.auth,
      );
      const ready = await waitFor(() =>
        bridge.frames.find((frame) => frame.type === 'ready'),
      );
      expect(ready).toMatchObject({ role: 'bridge', env: ENV });

      const createdTask = await ctx.app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: ctx.auth,
        payload: {
          env: ENV,
          title: 'bridge claim',
          instruction: 'run the task',
        },
      });
      const task = createdTask.json().task as AgentTask;

      bridge.socket.send(
        JSON.stringify({
          type: 'task.claim',
          requestId: 'task-1',
          timeoutMs: 1_000,
        }),
      );
      const assigned = await waitFor(() =>
        bridge.frames.find((frame) => frame.type === 'task.assigned'),
      );
      expect(assigned).toMatchObject({
        requestId: 'task-1',
        timedOut: false,
        task: { id: task.id, env: ENV },
      });

      bridge.socket.send(
        JSON.stringify({
          type: 'task.complete',
          requestId: 'task-2',
          taskId: task.id,
          status: 'DONE',
          result: 'finished',
        }),
      );
      const completed = await waitFor(() =>
        bridge.frames.find((frame) => frame.type === 'task.completed'),
      );
      expect(completed).toMatchObject({
        requestId: 'task-2',
        task: { id: task.id, status: 'DONE' },
      });

      const createdTicket = await ctx.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: ctx.auth,
        payload: ticketInput({ env: ENV }),
      });
      const ticket = createdTicket.json().ticket as DecisionTicket;

      bridge.socket.send(
        JSON.stringify({
          type: 'ticket.wait',
          requestId: 'ticket-1',
          ticketId: ticket.id,
          timeoutMs: 2_000,
        }),
      );
      await sleep(100);

      await ctx.app.inject({
        method: 'POST',
        url: `/api/tickets/${ticket.id}/resolve`,
        headers: ctx.auth,
        payload: { selectedOption: 'A' },
      });

      const resolved = await waitFor(() =>
        bridge.frames.find((frame) => frame.type === 'ticket.resolved'),
      );
      expect(resolved).toMatchObject({
        requestId: 'ticket-1',
        timedOut: false,
        ticket: { id: ticket.id, status: 'HUMAN_RESOLVED' },
      });

      const createdSession = await ctx.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: ctx.auth,
        payload: { env: ENV, title: 'bridge chat' },
      });
      const session = createdSession.json().session as ChatSession;
      await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/messages`,
        headers: ctx.auth,
        payload: { content: 'hello bridge' },
      });

      bridge.socket.send(
        JSON.stringify({
          type: 'chat.claim',
          requestId: 'chat-1',
          timeoutMs: 2_000,
        }),
      );
      const assignedChat = await waitFor(() =>
        bridge.frames.find((frame) => frame.type === 'chat.assigned'),
      );
      expect(assignedChat).toMatchObject({
        requestId: 'chat-1',
        timedOut: false,
        session: { id: session.id, env: ENV },
        message: { role: 'user', content: 'hello bridge' },
      });

      const message = assignedChat.message as { id: string };
      bridge.socket.send(
        JSON.stringify({
          type: 'chat.complete',
          requestId: 'chat-2',
          sessionId: session.id,
          messageId: message.id,
          status: 'DONE',
          content: 'bridge reply',
        }),
      );
      const completedChat = await waitFor(() =>
        bridge.frames.find((frame) => frame.type === 'chat.completed'),
      );
      expect(completedChat).toMatchObject({
        requestId: 'chat-2',
        session: { id: session.id },
        message: { status: 'DONE' },
      });

      bridge.socket.close();
      await sleep(20);
    } finally {
      await ctx.close();
    }
  });

  it('returns a timed-out task claim when no work is queued', async () => {
    const ctx = await createTestContext();
    try {
      await ctx.app.listen({ port: 0, host: '127.0.0.1' });
      const bridge = await openSocket(
        wsServerUrl(ctx, `/ws/bridge?env=${ENV}`),
        ctx.auth,
      );
      await waitFor(() =>
        bridge.frames.find((frame) => frame.type === 'ready'),
      );

      bridge.socket.send(
        JSON.stringify({
          type: 'task.claim',
          requestId: 'none-1',
          timeoutMs: 50,
        }),
      );
      const assigned = await waitFor(() =>
        bridge.frames.find((frame) => frame.type === 'task.assigned'),
      );
      expect(assigned).toMatchObject({
        requestId: 'none-1',
        timedOut: true,
        task: null,
      });

      bridge.socket.close();
      await sleep(20);
    } finally {
      await ctx.close();
    }
  });
});
