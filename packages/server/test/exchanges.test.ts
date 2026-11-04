import { describe, expect, it } from 'vitest';

import type { Exchange, AgentTokenResponse } from '@zhunzou/shared';

import { createTestContext } from './helpers.js';

const ENV = 'cursor-agent-hub';
const OTHER = 'cursor-blog';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

async function issueToken(ctx: Ctx, env: string): Promise<string> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/agents/${env}/token`,
    headers: ctx.auth,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as AgentTokenResponse).token;
}

function reportExchange(
  ctx: Ctx,
  payload: Record<string, unknown>,
  token: string,
) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/exchanges',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

describe('mirrored exchanges', () => {
  it('stores the question and conclusion of a turn', async () => {
    const ctx = await createTestContext();
    try {
      const token = await issueToken(ctx, ENV);
      const response = await reportExchange(
        ctx,
        {
          env: ENV,
          projectName: 'agent-hub',
          question: '可以看 Cursor 当前在跑的任务吗？',
          conclusion: '看板现在能看到每轮追问与结论了。',
        },
        token,
      );

      expect(response.statusCode).toBe(201);
      const { exchange } = response.json() as { exchange: Exchange };
      expect(exchange).toMatchObject({
        env: ENV,
        projectName: 'agent-hub',
        question: '可以看 Cursor 当前在跑的任务吗？',
      });
      expect(exchange.createdAt).toBeGreaterThan(0);
    } finally {
      await ctx.close();
    }
  });

  it('rejects an empty exchange', async () => {
    const ctx = await createTestContext();
    try {
      const token = await issueToken(ctx, ENV);
      const response = await reportExchange(
        ctx,
        { env: ENV, question: '   ' },
        token,
      );
      expect(response.statusCode).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it('scopes writes to the token env and lists newest first', async () => {
    const ctx = await createTestContext();
    try {
      const token = await issueToken(ctx, ENV);
      const foreignToken = await issueToken(ctx, OTHER);

      const denied = await reportExchange(
        ctx,
        { env: OTHER, question: 'should not pass' },
        token,
      );
      expect(denied.statusCode).toBe(403);

      for (const question of ['第一轮', '第二轮']) {
        const response = await reportExchange(ctx, { env: ENV, question }, token);
        expect(response.statusCode).toBe(201);
      }
      const other = await reportExchange(
        ctx,
        { env: OTHER, question: '别处的问题' },
        foreignToken,
      );
      expect(other.statusCode).toBe(201);

      const list = await ctx.app.inject({
        method: 'GET',
        url: `/api/exchanges?env=${ENV}&limit=10`,
        headers: ctx.auth,
      });
      expect(list.statusCode).toBe(200);
      const { exchanges } = list.json() as { exchanges: Exchange[] };
      expect(exchanges.map((item) => item.question)).toEqual([
        '第二轮',
        '第一轮',
      ]);
    } finally {
      await ctx.close();
    }
  });

  it('requires the admin token for the list endpoint', async () => {
    const ctx = await createTestContext();
    try {
      const token = await issueToken(ctx, ENV);
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/exchanges',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await ctx.close();
    }
  });
});
