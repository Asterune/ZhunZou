import { describe, expect, it } from 'vitest';

import type { ChatMessage, ChatSession } from '@zhunzou/shared';

import { createTestContext } from './helpers.js';

const ENV = 'chat-env';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

async function createSession(ctx: Ctx, env = ENV): Promise<ChatSession> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: ctx.auth,
    payload: { env, projectName: 'agent-hub', title: '第一个会话' },
  });
  expect(response.statusCode).toBe(201);
  return response.json().session as ChatSession;
}

async function issueAgentToken(ctx: Ctx, env = ENV): Promise<{ authorization: string }> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/agents/${env}/token`,
    headers: ctx.auth,
  });
  return { authorization: `Bearer ${response.json().token}` };
}

describe('interactive sessions', () => {
  it('queues a user message and lets the agent claim, stream and complete it', async () => {
    const ctx = await createTestContext();
    try {
      const session = await createSession(ctx);
      const agentAuth = await issueAgentToken(ctx);

      const send = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/messages`,
        headers: ctx.auth,
        payload: { content: '看看这个仓库用了什么测试框架' },
      });
      expect(send.statusCode).toBe(201);
      const userMessage = send.json().message as ChatMessage;
      expect(userMessage).toMatchObject({
        role: 'user',
        status: 'PENDING',
      });

      const next = await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/next?env=${ENV}&timeout=10`,
        headers: agentAuth,
      });
      expect(next.statusCode).toBe(200);
      const claimed = next.json() as {
        session: ChatSession;
        message: ChatMessage;
        timedOut: boolean;
      };
      expect(claimed.session.id).toBe(session.id);
      expect(claimed.message.status).toBe('RUNNING');

      const event = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/messages/${userMessage.id}/events`,
        headers: agentAuth,
        payload: { stream: 'stdout', chunk: '正在检查 package.json\n' },
      });
      expect(event.statusCode).toBe(201);

      const complete = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/messages/${userMessage.id}/complete`,
        headers: agentAuth,
        payload: {
          status: 'DONE',
          content: '项目使用 Vitest，测试在 packages/*/test。',
          externalId: 'ext-session-1',
        },
      });
      expect(complete.statusCode).toBe(200);
      expect(complete.json().session.externalId).toBe('ext-session-1');
      expect(complete.json().assistant).toMatchObject({
        role: 'assistant',
        status: 'DONE',
      });

      const loaded = await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}`,
        headers: ctx.auth,
      });
      const messages = loaded.json().messages as ChatMessage[];
      expect(messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
      ]);
      expect(messages[0]?.status).toBe('DONE');

      const events = await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}/events?after=0`,
        headers: ctx.auth,
      });
      expect(events.json().events).toHaveLength(1);
      expect(events.json().events[0].chunk).toContain('package.json');
    } finally {
      await ctx.close();
    }
  });

  it('scopes sessions and messages to the agent token env', async () => {
    const ctx = await createTestContext();
    try {
      const session = await createSession(ctx);
      const foreignAuth = await issueAgentToken(ctx, 'other-env');

      const read = await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}`,
        headers: foreignAuth,
      });
      expect(read.statusCode).toBe(403);

      const next = await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/next?env=${ENV}&timeout=10`,
        headers: foreignAuth,
      });
      expect(next.statusCode).toBe(403);

      const send = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/messages`,
        headers: foreignAuth,
        payload: { content: 'should fail' },
      });
      // Agent tokens cannot send human messages even for their own env.
      expect(send.statusCode).toBe(403);
    } finally {
      await ctx.close();
    }
  });

  it('closes a session and stops handing out new messages', async () => {
    const ctx = await createTestContext();
    try {
      const session = await createSession(ctx);

      const closed = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/close`,
        headers: ctx.auth,
      });
      expect(closed.statusCode).toBe(200);
      expect(closed.json().session.status).toBe('CLOSED');

      const send = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/messages`,
        headers: ctx.auth,
        payload: { content: 'too late' },
      });
      expect(send.statusCode).toBe(409);

      const next = await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/next?env=${ENV}&timeout=10`,
        headers: ctx.auth,
      });
      expect(next.json().message).toBeNull();
    } finally {
      await ctx.close();
    }
  });

  it('fails a RUNNING message only when its env is offline, then supports retry', async () => {
    const ctx = await createTestContext();
    try {
      const session = await createSession(ctx);
      const agentAuth = await issueAgentToken(ctx);

      await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/messages`,
        headers: ctx.auth,
        payload: { content: 'long turn' },
      });
      const next = await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/next?env=${ENV}&timeout=10`,
        headers: agentAuth,
      });
      const message = next.json().message as ChatMessage;

      // A live env is never interrupted, even with an aggressive cutoff.
      expect(
        ctx.app.repo.failStaleChatMessages(
          new Set([ENV]),
          Date.now() + 60_000,
        ),
      ).toBe(0);

      // Offline + past cutoff → failed with a retryable error.
      expect(
        ctx.app.repo.failStaleChatMessages(new Set(), Date.now() + 60_000),
      ).toBe(1);

      const failed = await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}`,
        headers: ctx.auth,
      });
      expect(failed.json().messages[0]).toMatchObject({
        status: 'FAILED',
        error: expect.stringContaining('可以重试'),
      });

      const retry = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/messages/${message.id}/retry`,
        headers: ctx.auth,
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().message.status).toBe('PENDING');

      const reclaimed = await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/next?env=${ENV}&timeout=10`,
        headers: agentAuth,
      });
      expect(reclaimed.json().message.id).toBe(message.id);
      expect(reclaimed.json().message.status).toBe('RUNNING');
    } finally {
      await ctx.close();
    }
  });

  it('wakes a long-poll as soon as the human sends a message', async () => {
    const ctx = await createTestContext();
    try {
      const session = await createSession(ctx);
      const agentAuth = await issueAgentToken(ctx);

      const waiting = ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/next?env=${ENV}&timeout=5000`,
        headers: agentAuth,
      });

      await new Promise((resolve) => setTimeout(resolve, 30));
      await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/messages`,
        headers: ctx.auth,
        payload: { content: 'wake up' },
      });

      const response = await waiting;
      expect(response.statusCode).toBe(200);
      expect(response.json().message.content).toBe('wake up');
    } finally {
      await ctx.close();
    }
  });
});
