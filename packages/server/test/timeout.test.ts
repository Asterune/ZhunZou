import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DecisionTicket } from '@zhunzou/shared';

import {
  createTestContext,
  sleep,
  ticketInput,
  waitFor,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext(undefined, undefined, {
    AUTO_RESOLVE_TIMEOUT_MS: '80',
    SWEEP_INTERVAL_MS: '20',
  });
});

afterAll(async () => {
  await ctx.close();
});

async function createTicket(
  overrides: Parameters<typeof ticketInput>[0] = {},
): Promise<DecisionTicket> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tickets',
    headers: ctx.auth,
    payload: ticketInput(overrides),
  });
  expect(response.statusCode).toBe(201);
  return response.json().ticket as DecisionTicket;
}

describe('timeout auto-resolve', () => {
  it('sets an expiry and applies the recommended option', async () => {
    const ticket = await createTicket({ projectName: 'sla-project' });

    expect(ticket.expiresAt).toBeGreaterThan(ticket.createdAt);

    const resolved = await waitFor(() => {
      const current = ctx.app.repo.get(Number(ticket.id));
      return current?.status === 'AUTO_RESOLVED' ? current : null;
    });

    expect(resolved.resolvedBy).toBe('TIMEOUT');
    expect(resolved.selectedOption).toBe('A');
    expect(resolved.resolutionReason).toContain('自动裁决时限');
  });

  it('does not override a human decision that arrives first', async () => {
    const scoped = await createTestContext(undefined, undefined, {
      AUTO_RESOLVE_TIMEOUT_MS: '500',
      SWEEP_INTERVAL_MS: '20',
    });

    try {
      const created = await scoped.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: scoped.auth,
        payload: ticketInput({ projectName: 'sla-human-project' }),
      });
      const ticket = created.json().ticket as DecisionTicket;

      const human = await scoped.app.inject({
        method: 'POST',
        url: `/api/tickets/${ticket.id}/resolve`,
        headers: scoped.auth,
        payload: { selectedOption: 'B' },
      });
      expect(human.statusCode).toBe(200);

      await sleep(600);
      const final = scoped.app.repo.get(Number(ticket.id));
      expect(final?.status).toBe('HUMAN_RESOLVED');
      expect(final?.selectedOption).toBe('B');
    } finally {
      await scoped.close();
    }
  });

  it('never auto-resolves a destructive recommended option', async () => {
    const ticket = await createTicket({
      projectName: 'sla-destructive-project',
      options: [
        { key: 'A', label: '删除生产数据', risk: 'destructive' },
        { key: 'B', label: '保留数据' },
      ],
      recommendedOption: 'A',
    });

    await sleep(220);
    const current = ctx.app.repo.get(Number(ticket.id));

    expect(current?.status).not.toBe('AUTO_RESOLVED');
    expect(current?.expiresAt).toBeUndefined();
  });

  it('respects the project allowlist', async () => {
    const scoped = await createTestContext(undefined, undefined, {
      AUTO_RESOLVE_TIMEOUT_MS: '80',
      AUTO_RESOLVE_PROJECTS: 'only-this-project',
      SWEEP_INTERVAL_MS: '20',
    });

    try {
      const response = await scoped.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: scoped.auth,
        payload: ticketInput({ projectName: 'not-allowed-project' }),
      });
      const ticket = response.json().ticket as DecisionTicket;
      expect(ticket.expiresAt).toBeUndefined();

      await sleep(180);
      expect(scoped.app.repo.get(Number(ticket.id))?.status).not.toBe(
        'AUTO_RESOLVED',
      );
    } finally {
      await scoped.close();
    }
  });
});

describe('POST /api/tickets/:id/extend', () => {
  it('pushes the deadline out and keeps the ticket pending', async () => {
    const scoped = await createTestContext(undefined, undefined, {
      AUTO_RESOLVE_TIMEOUT_MS: '200',
      SWEEP_INTERVAL_MS: '20',
    });

    try {
      const created = await scoped.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: scoped.auth,
        payload: ticketInput({ projectName: 'sla-extend-project' }),
      });
      const ticket = created.json().ticket as DecisionTicket;
      const before = ticket.expiresAt!;

      const response = await scoped.app.inject({
        method: 'POST',
        url: `/api/tickets/${ticket.id}/extend`,
        headers: scoped.auth,
        payload: { minutes: 10 },
      });

      expect(response.statusCode).toBe(200);
      const extended = response.json().ticket as DecisionTicket;
      expect(extended.expiresAt).toBeGreaterThan(before);

      await sleep(400);
      expect(scoped.app.repo.get(Number(ticket.id))?.status).not.toBe(
        'AUTO_RESOLVED',
      );
    } finally {
      await scoped.close();
    }
  });

  it('rejects extending a finalized ticket', async () => {
    const ticket = await createTicket({ projectName: 'sla-extend-done' });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/resolve`,
      headers: ctx.auth,
      payload: { selectedOption: 'A' },
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/extend`,
      headers: ctx.auth,
      payload: { minutes: 10 },
    });

    expect(response.statusCode).toBe(409);
  });
});

describe('destructive option confirmation', () => {
  it('requires confirmDestructive before a human can select it', async () => {
    const ticket = await createTicket({
      projectName: 'destructive-confirm-project',
      options: [
        { key: 'A', label: '安全方案' },
        { key: 'B', label: '清空数据', risk: 'destructive' },
      ],
      recommendedOption: 'A',
    });

    const rejected = await ctx.app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/resolve`,
      headers: ctx.auth,
      payload: { selectedOption: 'B' },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.code).toBe(
      'DESTRUCTIVE_OPTION_REQUIRES_CONFIRMATION',
    );

    const accepted = await ctx.app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/resolve`,
      headers: ctx.auth,
      payload: { selectedOption: 'B', confirmDestructive: true },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().ticket.selectedOption).toBe('B');
  });
});
