import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';

import { RealtimeHubClient } from '../src/realtime-client.js';
import type { BridgeConfig } from '../src/config.js';

const config = (port: number): BridgeConfig => ({
  hubUrl: `http://127.0.0.1:${port}`,
  token: 'zz_test',
  agentEnv: 'home-mac',
  fallback: 'cli',
  waitTimeoutMs: 1_000,
  cliCommand: 'npx zhunzou-bridge',
  heartbeatIntervalMs: 30_000,
  agentKind: 'opencode',
  transport: 'ws',
});

const task = {
  id: '1',
  env: 'home-mac',
  title: 'task',
  instruction: 'do it',
  status: 'PENDING',
  attempts: 0,
  createdAt: 1,
  updatedAt: 1,
};

const ticket = {
  id: '1',
  env: 'home-mac',
  projectName: 'agent-hub',
  status: 'HUMAN_RESOLVED',
  doneSummary: 'done',
  blockerQuestion: 'which?',
  nextStepPlan: 'do A',
  options: [
    { key: 'A', label: 'A' },
    { key: 'B', label: 'B' },
  ],
  recommendedOption: 'A',
  selectedOption: 'A',
  resolvedBy: 'HUMAN',
  createdAt: 1,
  updatedAt: 1,
};

const chatSession = {
  id: '1',
  env: 'home-mac',
  title: 'chat',
  status: 'ACTIVE',
  createdAt: 1,
  updatedAt: 1,
};
const chatMessage = {
  id: '1',
  sessionId: '1',
  role: 'user',
  content: 'hello',
  status: 'RUNNING',
  createdAt: 1,
  updatedAt: 1,
};

describe('RealtimeHubClient', () => {
  it('claims tasks, waits tickets and claims chat over the bridge socket', async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    let authHeader = '';

    wss.on('connection', (socket, request) => {
      authHeader = request.headers.authorization ?? '';
      socket.send(
        JSON.stringify({
          type: 'ready',
          protocol: 1,
          serverTime: Date.now(),
          heartbeatMs: 30_000,
          role: 'bridge',
          env: 'home-mac',
        }),
      );

      socket.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as {
          type: string;
          requestId: string;
        };
        if (frame.type === 'task.claim') {
          socket.send(
            JSON.stringify({
              type: 'task.assigned',
              requestId: frame.requestId,
              task,
              timedOut: false,
            }),
          );
        } else if (frame.type === 'ticket.wait') {
          socket.send(
            JSON.stringify({
              type: 'ticket.resolved',
              requestId: frame.requestId,
              ticket,
              timedOut: false,
            }),
          );
        } else if (frame.type === 'chat.claim') {
          socket.send(
            JSON.stringify({
              type: 'chat.assigned',
              requestId: frame.requestId,
              session: chatSession,
              message: chatMessage,
              timedOut: false,
            }),
          );
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const client = new RealtimeHubClient(config(address.port));

    try {
      const taskResult = await client.nextTask(500);
      expect(taskResult.task).toMatchObject({ id: '1', env: 'home-mac' });
      expect(taskResult.timedOut).toBe(false);

      const ticketResult = await client.wait('1', 500);
      expect(ticketResult.resolved).toBe(true);
      expect(ticketResult.ticket.status).toBe('HUMAN_RESOLVED');

      const chatResult = await client.nextChatMessage(500);
      expect(chatResult.session).toMatchObject({ id: '1' });
      expect(chatResult.message).toMatchObject({ content: 'hello' });
      expect(authHeader).toBe('Bearer zz_test');
    } finally {
      client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
