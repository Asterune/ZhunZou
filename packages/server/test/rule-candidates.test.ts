import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DecisionTicket, RuleCandidate } from '@zhunzou/shared';

import {
  createTestContext,
  ticketInput,
  waitFor,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

async function createAndResolve(
  overrides: Parameters<typeof ticketInput>[0] = {},
  selectedOption = 'B',
  customInstruction?: string,
): Promise<DecisionTicket> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/tickets',
    headers: ctx.auth,
    payload: ticketInput(overrides),
  });
  expect(created.statusCode).toBe(201);
  const ticket = created.json().ticket as DecisionTicket;

  const resolved = await ctx.app.inject({
    method: 'POST',
    url: `/api/tickets/${ticket.id}/resolve`,
    headers: ctx.auth,
    payload: {
      selectedOption,
      ...(customInstruction ? { customInstruction } : {}),
    },
  });
  expect(resolved.statusCode).toBe(200);
  return resolved.json().ticket as DecisionTicket;
}

async function waitForCandidate(ticketId: string): Promise<RuleCandidate> {
  return waitFor(() =>
    ctx.app.repo
      .listRuleCandidates({ limit: 100 })
      .candidates.find(
        (candidate) =>
          candidate.ticketId === ticketId && candidate.status === 'PENDING',
      ),
  );
}

describe('rule candidates', () => {
  it('distills a candidate after a human approval', async () => {
    const ticket = await createAndResolve(
      { projectName: 'candidate-project' },
      'B',
      '先只改登录页',
    );

    const candidate = await waitForCandidate(ticket.id);

    expect(candidate.content.startsWith('- ')).toBe(true);
    expect(candidate.content).toContain('candidate-project');
    expect(candidate.content).toContain('方案 B');
    expect(candidate.content).toContain('先只改登录页');
    expect(candidate.status).toBe('PENDING');
  });

  it('accepts a candidate and appends it to GLOBAL_RULES.md', async () => {
    const ticket = await createAndResolve({ projectName: 'accept-project' });
    const candidate = await waitForCandidate(ticket.id);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/rules/candidates/${candidate.id}/accept`,
      headers: ctx.auth,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.candidate).toMatchObject({
      id: candidate.id,
      ticketId: ticket.id,
      status: 'ACCEPTED',
    });
    expect(body.rules.content).toContain('## 历史批复沉淀');
    expect(body.rules.content).toContain('accept-project');
    expect(body.rules.content).toContain('方案 B');

    const stored = await ctx.app.inject({
      method: 'GET',
      url: '/api/rules',
      headers: ctx.auth,
    });
    expect(stored.json().content).toBe(body.rules.content);
  });

  it('rejects accepting the same candidate twice', async () => {
    const ticket = await createAndResolve({ projectName: 'double-accept' });
    const candidate = await waitForCandidate(ticket.id);

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/rules/candidates/${candidate.id}/accept`,
      headers: ctx.auth,
    });
    expect(first.statusCode).toBe(200);

    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/rules/candidates/${candidate.id}/accept`,
      headers: ctx.auth,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('ALREADY_FINALIZED');
  });

  it('dismisses a candidate without touching the rules file', async () => {
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/api/rules',
      headers: ctx.auth,
    });
    const ticket = await createAndResolve({ projectName: 'dismiss-project' });
    const candidate = await waitForCandidate(ticket.id);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/rules/candidates/${candidate.id}/dismiss`,
      headers: ctx.auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().candidate.status).toBe('DISMISSED');

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/rules',
      headers: ctx.auth,
    });
    expect(after.json().content).toBe(before.json().content);

    const accept = await ctx.app.inject({
      method: 'POST',
      url: `/api/rules/candidates/${candidate.id}/accept`,
      headers: ctx.auth,
    });
    expect(accept.statusCode).toBe(409);
  });

  it('filters candidates by status and hides finalized ones from PENDING', async () => {
    const ticket = await createAndResolve({ projectName: 'filter-candidate' });
    const candidate = await waitForCandidate(ticket.id);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/rules/candidates/${candidate.id}/dismiss`,
      headers: ctx.auth,
    });

    const pending = await ctx.app.inject({
      method: 'GET',
      url: '/api/rules/candidates?status=PENDING',
      headers: ctx.auth,
    });
    expect(pending.statusCode).toBe(200);
    expect(
      pending
        .json()
        .candidates.some((item: RuleCandidate) => item.id === candidate.id),
    ).toBe(false);

    const dismissed = await ctx.app.inject({
      method: 'GET',
      url: '/api/rules/candidates?status=DISMISSED',
      headers: ctx.auth,
    });
    expect(
      dismissed
        .json()
        .candidates.some((item: RuleCandidate) => item.id === candidate.id),
    ).toBe(true);
  });

  it('returns 404 for an unknown candidate', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules/candidates/999999/accept',
      headers: ctx.auth,
    });
    expect(response.statusCode).toBe(404);
  });
});
