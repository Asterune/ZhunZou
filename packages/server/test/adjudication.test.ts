import { describe, expect, it } from 'vitest';

import type { DecisionTicket } from '@zhunzou/shared';

import type { MetaAgent, MetaReview } from '../src/meta-agent.js';
import { createTestContext, ticketInput, waitFor } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

function stub(review: MetaReview): MetaAgent {
  return { review: async () => review };
}

const CAUTION_TICKET = ticketInput({
  options: [
    { key: 'A', label: '改 API 返回结构', risk: 'caution' },
    { key: 'B', label: '保持旧结构', prosCons: '兼容', risk: 'safe' },
  ],
});

async function createTicket(ctx: Ctx, payload = ticketInput()) {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tickets',
    headers: ctx.auth,
    payload,
  });
  return response.json().ticket as DecisionTicket;
}

function settled(ctx: Ctx, id: string) {
  return waitFor(() => {
    const current = ctx.app.repo.get(Number(id));
    return current && current.status !== 'PENDING_META' ? current : null;
  });
}

describe('L2 adjudication', () => {
  it('records category and confidence on an auto-approval', async () => {
    const ctx = await createTestContext(
      stub({
        canResolve: true,
        selectedOption: 'A',
        reason: '低风险重构',
        confidence: 0.93,
        category: 'refactor',
      }),
    );

    try {
      const created = await createTicket(ctx);
      const ticket = await settled(ctx, created.id);

      expect(ticket.status).toBe('AUTO_RESOLVED');
      expect(ticket.category).toBe('refactor');
      expect(ticket.confidence).toBe(0.93);
      expect(ticket.reviewCount).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it('escalates when the judge is below the confidence floor', async () => {
    const ctx = await createTestContext(
      stub({
        canResolve: true,
        selectedOption: 'A',
        reason: '大概是吧',
        confidence: 0.2,
        category: 'refactor',
      }),
      [],
      { DECISION_MIN_CONFIDENCE: '0.7' },
    );

    try {
      const created = await createTicket(ctx);
      const ticket = await settled(ctx, created.id);

      expect(ticket.status).toBe('PENDING_HUMAN');
      expect(ticket.resolutionReason).toContain('置信度');
      expect(ticket.category).toBe('refactor');
    } finally {
      await ctx.close();
    }
  });

  it('requires the challenger to agree on high-risk changes', async () => {
    let challengerCalls = 0;
    const ctx = await createTestContext(
      stub({
        canResolve: true,
        selectedOption: 'A',
        reason: '正审放行',
        confidence: 0.9,
        category: 'api-contract',
      }),
      [],
      {},
      {
        challenger: {
          async review() {
            challengerCalls += 1;
            return {
              canResolve: true,
              selectedOption: 'B',
              reason: '契约变更应先人工确认',
              confidence: 0.9,
              category: 'api-contract',
            };
          },
        },
      },
    );

    try {
      const created = await createTicket(ctx, CAUTION_TICKET);
      const ticket = await settled(ctx, created.id);

      expect(challengerCalls).toBe(1);
      expect(ticket.status).toBe('PENDING_HUMAN');
      expect(ticket.resolutionReason).toContain('双审未达成一致');
      expect(ticket.reviewCount).toBe(2);
    } finally {
      await ctx.close();
    }
  });

  it('auto-approves when both reviewers pick the same option', async () => {
    const ctx = await createTestContext(
      stub({
        canResolve: true,
        selectedOption: 'B',
        reason: '保持兼容',
        confidence: 0.88,
        category: 'api-contract',
      }),
      [],
      {},
      {
        challenger: stub({
          canResolve: true,
          selectedOption: 'B',
          reason: '可回滚，同意',
          confidence: 0.8,
        }),
      },
    );

    try {
      const created = await createTicket(ctx, CAUTION_TICKET);
      const ticket = await settled(ctx, created.id);

      expect(ticket.status).toBe('AUTO_RESOLVED');
      expect(ticket.selectedOption).toBe('B');
      expect(ticket.reviewCount).toBe(2);
      expect(ticket.resolutionReason).toContain('双审一致');
    } finally {
      await ctx.close();
    }
  });

  it('stops auto-approving once the daily quota is spent', async () => {
    const ctx = await createTestContext(
      stub({
        canResolve: true,
        selectedOption: 'A',
        reason: '符合规范',
        confidence: 0.95,
        category: 'refactor',
      }),
      [],
      { DECISION_DAILY_QUOTA: '1' },
    );

    try {
      const first = await createTicket(ctx);
      expect((await settled(ctx, first.id)).status).toBe('AUTO_RESOLVED');

      const second = await createTicket(ctx);
      const ticket = await settled(ctx, second.id);
      expect(ticket.status).toBe('PENDING_HUMAN');
      expect(ticket.resolutionReason).toContain('配额');
    } finally {
      await ctx.close();
    }
  });

  it('flags a sampled approval for audit without blocking it', async () => {
    const ctx = await createTestContext(
      stub({
        canResolve: true,
        selectedOption: 'A',
        reason: '符合规范',
        confidence: 0.95,
        category: 'refactor',
      }),
      [],
      { DECISION_AUDIT_RATE: '1' },
      { random: () => 0 },
    );

    try {
      const created = await createTicket(ctx);
      const ticket = await settled(ctx, created.id);

      expect(ticket.status).toBe('AUTO_RESOLVED');
      expect(ticket.auditRequired).toBe(true);
      expect(ticket.auditVerdict).toBe('PENDING');
    } finally {
      await ctx.close();
    }
  });

  it('records a clean audit without demoting the category', async () => {
    const ctx = await createTestContext(
      stub({
        canResolve: true,
        selectedOption: 'A',
        reason: '符合规范',
        confidence: 0.95,
        category: 'refactor',
      }),
      [],
      { DECISION_AUDIT_RATE: '1' },
      { random: () => 0 },
    );

    try {
      const created = await createTicket(ctx);
      await settled(ctx, created.id);

      const audit = await ctx.app.inject({
        method: 'POST',
        url: `/api/tickets/${created.id}/audit`,
        headers: ctx.auth,
        payload: { verdict: 'OK', reason: '看过 diff，没问题' },
      });
      expect(audit.statusCode).toBe(200);
      const ticket = audit.json().ticket as DecisionTicket;
      expect(ticket.auditVerdict).toBe('OK');
      expect(audit.json().demotedUntil).toBeUndefined();
      expect(ctx.app.repo.listActiveDemotions()).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  it('overturning an auto-approval demotes its category', async () => {
    const ctx = await createTestContext(
      stub({
        canResolve: true,
        selectedOption: 'A',
        reason: '符合规范',
        confidence: 0.95,
        category: 'refactor',
      }),
      [],
      { DECISION_AUDIT_RATE: '1', DECISION_DEMOTION_MINUTES: '60' },
      { random: () => 0 },
    );

    try {
      const created = await createTicket(ctx);
      await settled(ctx, created.id);

      const audit = await ctx.app.inject({
        method: 'POST',
        url: `/api/tickets/${created.id}/audit`,
        headers: ctx.auth,
        payload: {
          verdict: 'REVERSED',
          selectedOption: 'B',
          reason: '这个契约不能动',
        },
      });
      expect(audit.statusCode).toBe(200);
      expect(audit.json().demotedUntil).toBeGreaterThan(Date.now());

      const reversed = ctx.app.repo.get(Number(created.id))!;
      expect(reversed.status).toBe('HUMAN_RESOLVED');
      expect(reversed.selectedOption).toBe('B');
      expect(reversed.auditVerdict).toBe('REVERSED');

      const demotions = await ctx.app.inject({
        method: 'GET',
        url: '/api/decision-demotions',
        headers: ctx.auth,
      });
      expect(demotions.json().demotions).toHaveLength(1);

      // The next ticket in the same category must wait for a human.
      const next = await createTicket(ctx);
      const ticket = await settled(ctx, next.id);
      expect(ticket.status).toBe('PENDING_HUMAN');
      expect(ticket.resolutionReason).toContain('人工推翻');
    } finally {
      await ctx.close();
    }
  });

  it('refuses to audit a ticket the hub never auto-approved', async () => {
    const ctx = await createTestContext(
      stub({ canResolve: false, reason: '规范未覆盖' }),
    );

    try {
      const created = await createTicket(ctx);
      await settled(ctx, created.id);

      const audit = await ctx.app.inject({
        method: 'POST',
        url: `/api/tickets/${created.id}/audit`,
        headers: ctx.auth,
        payload: { verdict: 'OK' },
      });
      expect(audit.statusCode).toBe(409);
    } finally {
      await ctx.close();
    }
  });
});
