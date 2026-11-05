import { describe, expect, it } from 'vitest';

import type { ChatMessage, ChatSession, DecisionResponse } from '@zhunzou/shared';

import type { MetaAgent, MetaReview } from '../src/meta-agent.js';
import { createTestContext } from './helpers.js';

const ENV = 'decision-env';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

/** Minimal Meta-Agent stub: the decision policy only needs `review`. */
function stubMeta(review: MetaReview): MetaAgent {
  return { review: async () => review };
}

async function setup(policy: string, review: MetaReview) {
  const ctx = await createTestContext(stubMeta(review), [], {
    DECISION_POLICY: policy,
  });
  const sessionResponse = await ctx.app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: ctx.auth,
    payload: { env: ENV, projectName: 'agent-hub', title: '裁决会话' },
  });
  const session = sessionResponse.json().session as ChatSession;

  const tokenResponse = await ctx.app.inject({
    method: 'POST',
    url: `/api/agents/${ENV}/token`,
    headers: ctx.auth,
  });
  const agentAuth = {
    authorization: `Bearer ${tokenResponse.json().token}`,
  };

  return { ctx, session, agentAuth };
}

function decide(ctx: Ctx, agentAuth: { authorization: string }, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/decisions',
    headers: agentAuth,
    payload: {
      env: ENV,
      projectName: 'agent-hub',
      ...payload,
    },
  });
}

describe('POST /api/decisions', () => {
  it('auto-queues a reply when the hub approves it', async () => {
    const { ctx, session, agentAuth } = await setup('reply', {
      canResolve: true,
      selectedOption: 'A',
      reason: '符合规范，自动放行',
    });

    try {
      const response = await decide(ctx, agentAuth, {
        kind: 'reply',
        proposal: '先跑 pnpm test，再决定下一步',
        rationale: '验证当前改动',
      });

      expect(response.statusCode).toBe(201);
      const body = response.json() as DecisionResponse;
      expect(body.verdict).toBe('APPROVED');
      expect(body.reason).toContain('自动放行');

      const message = body.message as ChatMessage;
      expect(message).toMatchObject({
        status: 'PENDING',
        origin: 'agent',
        decision: 'AUTO',
      });

      const claimed = await ctx.app.inject({
        method: 'GET',
        url: `/api/sessions/next?env=${ENV}&timeout=10`,
        headers: agentAuth,
      });
      expect(claimed.json().message.id).toBe(message.id);
      expect(claimed.json().session.id).toBe(session.id);
    } finally {
      await ctx.close();
    }
  });

  it('opens a human ticket and sends nothing when the risk is destructive', async () => {
    const { ctx, agentAuth } = await setup('all', {
      canResolve: true,
      selectedOption: 'A',
      reason: '看起来没问题',
    });

    try {
      const response = await decide(ctx, agentAuth, {
        kind: 'reply',
        proposal: '直接把生产库清空',
        risk: 'destructive',
      });

      expect(response.statusCode).toBe(201);
      const body = response.json() as DecisionResponse;
      expect(body.verdict).toBe('PENDING');
      expect(body.ticket?.status).toBe('PENDING_HUMAN');
      expect(body.message).toBeUndefined();

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

  it('escalates everything when the policy is off', async () => {
    const { ctx, agentAuth } = await setup('off', {
      canResolve: true,
      selectedOption: 'A',
      reason: 'unused',
    });

    try {
      const response = await decide(ctx, agentAuth, {
        kind: 'reply',
        proposal: '继续',
      });

      expect(response.json().verdict).toBe('PENDING');
      expect(response.json().ticket.status).toBe('PENDING_HUMAN');
    } finally {
      await ctx.close();
    }
  });

  it('does not rule on code-changing steps in reply-only mode', async () => {
    const { ctx, agentAuth } = await setup('reply', {
      canResolve: true,
      selectedOption: 'A',
      reason: 'unused',
    });

    try {
      const response = await decide(ctx, agentAuth, {
        kind: 'next_step',
        proposal: '重构登录模块并改数据库 schema',
        risk: 'caution',
      });

      expect(response.json().verdict).toBe('PENDING');
      expect(response.json().reason).toContain('DECISION_POLICY=reply');
    } finally {
      await ctx.close();
    }
  });

  it('lets the hub approve a next step in all mode', async () => {
    const { ctx, agentAuth } = await setup('all', {
      canResolve: true,
      selectedOption: 'A',
      reason: '规范覆盖，风险可控',
    });

    try {
      const response = await decide(ctx, agentAuth, {
        kind: 'next_step',
        proposal: '补充会话模块的单元测试',
        risk: 'safe',
      });

      expect(response.json().verdict).toBe('APPROVED');
      // Approved steps keep an audit record on the board.
      expect(response.json().ticket.status).toBe('AUTO_RESOLVED');
      expect(response.json().ticket.resolutionReason).toContain('风险可控');
    } finally {
      await ctx.close();
    }
  });

  it('falls back to a human when the meta-agent declines', async () => {
    const { ctx, agentAuth } = await setup('all', {
      canResolve: false,
      reason: '规范未覆盖',
    });

    try {
      const response = await decide(ctx, agentAuth, {
        kind: 'reply',
        proposal: '把鉴权改成免登录',
      });

      expect(response.json().verdict).toBe('PENDING');
      expect(response.json().reason).toContain('规范未覆盖');
      expect(response.json().ticket.blockerQuestion).toContain('把鉴权改成免登录');
    } finally {
      await ctx.close();
    }
  });
});
