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

  it('accepts long messages up to the 32000 character limit', async () => {
    const ctx = await createTestContext();
    try {
      const session = await createSession(ctx);

      const long = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/messages`,
        headers: ctx.auth,
        payload: { content: 'a'.repeat(20_000) },
      });
      expect(long.statusCode).toBe(201);
      expect((long.json().message as ChatMessage).status).toBe('PENDING');

      const tooLong = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/messages`,
        headers: ctx.auth,
        payload: { content: 'a'.repeat(32_001) },
      });
      expect(tooLong.statusCode).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it('deletes a session together with its transcript', async () => {
    const ctx = await createTestContext();
    try {
      const session = await createSession(ctx);
      await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/messages`,
        headers: ctx.auth,
        payload: { content: '先别回，我马上删掉这个会话' },
      });

      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${session.id}`,
        headers: ctx.auth,
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ deleted: true });

      const loaded = await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}`,
        headers: ctx.auth,
      });
      expect(loaded.statusCode).toBe(404);

      const list = await ctx.app.inject({
        method: 'GET',
        url: '/api/sessions',
        headers: ctx.auth,
      });
      expect(list.json().sessions).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  it('refuses to delete a session whose message is running', async () => {
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
      await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/next?env=${ENV}&timeout=10`,
        headers: agentAuth,
      });

      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${session.id}`,
        headers: ctx.auth,
      });
      expect(removed.statusCode).toBe(409);
      expect(removed.json().error.code).toBe('SESSION_BUSY');
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

  it('keeps an agent-drafted reply invisible until a human adopts it', async () => {
    const ctx = await createTestContext();
    try {
      const session = await createSession(ctx);
      const agentAuth = await issueAgentToken(ctx);

      const drafted = await ctx.app.inject({
        method: 'POST',
        url: '/api/sessions/proposals',
        headers: agentAuth,
        payload: {
          env: ENV,
          content: '继续把剩下的两个用例补完',
          rationale: '改完的模块还缺边界用例',
        },
      });
      expect(drafted.statusCode).toBe(201);
      const proposal = drafted.json().message as ChatMessage;
      expect(proposal).toMatchObject({
        role: 'user',
        status: 'PROPOSED',
        origin: 'agent',
        rationale: '改完的模块还缺边界用例',
      });

      // Draft mode must not speak for the human: the bridge cannot claim it.
      const beforeAdoption = await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/next?env=${ENV}&timeout=10`,
        headers: agentAuth,
      });
      expect(beforeAdoption.json().timedOut).toBe(true);
      expect(beforeAdoption.json().message).toBeNull();

      const adopted = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/proposals/${proposal.id}/adopt`,
        headers: ctx.auth,
        payload: { content: '继续把剩下的两个用例补完，顺便跑一次全量测试' },
      });
      expect(adopted.statusCode).toBe(201);
      const message = adopted.json().message as ChatMessage;
      expect(message.status).toBe('PENDING');
      expect(message.content).toContain('全量测试');

      const claimed = await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/next?env=${ENV}&timeout=10`,
        headers: agentAuth,
      });
      expect(claimed.json().message.id).toBe(proposal.id);
      expect(claimed.json().message.status).toBe('RUNNING');
    } finally {
      await ctx.close();
    }
  });

  it('reports how many messages still need attention per session', async () => {
    const ctx = await createTestContext();
    try {
      const session = await createSession(ctx);
      const agentAuth = await issueAgentToken(ctx);

      const drafted = await ctx.app.inject({
        method: 'POST',
        url: '/api/sessions/proposals',
        headers: agentAuth,
        payload: { env: ENV, sessionId: session.id, content: '补一条回归测试' },
      });
      const proposal = drafted.json().message as ChatMessage;

      const withDraft = await ctx.app.inject({
        method: 'GET',
        url: '/api/sessions',
        headers: ctx.auth,
      });
      expect(withDraft.json().sessions[0]).toMatchObject({
        id: session.id,
        messageCount: 1,
        pendingCount: 1,
      });

      await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/proposals/${proposal.id}/discard`,
        headers: ctx.auth,
      });

      const afterDiscard = await ctx.app.inject({
        method: 'GET',
        url: '/api/sessions',
        headers: ctx.auth,
      });
      expect(afterDiscard.json().sessions[0]).toMatchObject({
        id: session.id,
        messageCount: 1,
        pendingCount: 0,
      });
    } finally {
      await ctx.close();
    }
  });

  it('discards a draft without queueing it, keeping it for audit', async () => {
    const ctx = await createTestContext();
    try {
      const session = await createSession(ctx);
      const agentAuth = await issueAgentToken(ctx);

      const drafted = await ctx.app.inject({
        method: 'POST',
        url: '/api/sessions/proposals',
        headers: agentAuth,
        payload: { env: ENV, sessionId: session.id, content: '把死代码删掉' },
      });
      expect(drafted.statusCode).toBe(201);
      const proposal = drafted.json().message as ChatMessage;

      const discarded = await ctx.app.inject({
        method: 'POST',
        url: `/api/sessions/${session.id}/proposals/${proposal.id}/discard`,
        headers: ctx.auth,
      });
      expect(discarded.statusCode).toBe(200);
      expect(discarded.json().message.status).toBe('DISCARDED');

      const transcript = await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}`,
        headers: ctx.auth,
      });
      const messages = transcript.json().messages as ChatMessage[];
      expect(messages.map((item) => item.id)).toContain(proposal.id);

      const next = await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/next?env=${ENV}&timeout=10`,
        headers: agentAuth,
      });
      expect(next.json().timedOut).toBe(true);
    } finally {
      await ctx.close();
    }
  });
});
