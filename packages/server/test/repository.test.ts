import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DecisionTicket } from '@zhunzou/shared';

import { textSimilarity } from '../src/repository.js';
import {
  createTestContext,
  ticketInput,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
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

async function resolveTicket(
  ticketId: string,
  selectedOption = 'B',
): Promise<DecisionTicket> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/tickets/${ticketId}/resolve`,
    headers: ctx.auth,
    payload: { selectedOption },
  });
  expect(response.statusCode).toBe(200);
  return response.json().ticket as DecisionTicket;
}

describe('textSimilarity', () => {
  it('scores reformulations higher than unrelated questions', () => {
    const base = '错误提示用 Toast 还是行内文案？';
    const similar = '登录页错误提示应该用 Toast 还是行内文案';
    const unrelated = '数据库 schema 变更是否需要人工确认？';

    expect(textSimilarity(base, similar)).toBeGreaterThan(0.5);
    expect(textSimilarity(base, similar)).toBeGreaterThan(
      textSimilarity(base, unrelated),
    );
  });

  it('returns zero for empty input', () => {
    expect(textSimilarity('', 'anything')).toBe(0);
    expect(textSimilarity('???', '!!!')).toBe(0);
  });
});

describe('findSimilarTickets', () => {
  it('returns resolved tickets from the same project ranked by similarity', async () => {
    const projectName = 'memory-project';
    const resolved = await createTicket({
      projectName,
      blockerQuestion: '错误提示用 Toast 还是行内文案？',
    });
    await resolveTicket(resolved.id, 'B');

    await createTicket({
      projectName: 'other-memory-project',
      blockerQuestion: '错误提示用 Toast 还是行内文案？',
    });

    const matches = ctx.app.repo.findSimilarTickets({
      projectName,
      blockerQuestion: '登录页错误提示应该用 Toast 还是行内文案',
      limit: 5,
    });

    expect(matches.map((ticket) => ticket.id)).toContain(resolved.id);
    expect(matches.every((ticket) => ticket.projectName === projectName)).toBe(true);
    expect(matches[0]?.selectedOption).toBe('B');
  });

  it('ignores unresolved and dissimilar tickets', async () => {
    const projectName = 'memory-filter-project';
    const pending = await createTicket({
      projectName,
      blockerQuestion: '错误提示用 Toast 还是行内文案？',
    });

    const unrelated = await createTicket({
      projectName,
      blockerQuestion: '数据库 schema 变更是否需要人工确认？',
    });
    await resolveTicket(unrelated.id, 'A');

    const matches = ctx.app.repo.findSimilarTickets({
      projectName,
      blockerQuestion: '错误提示用 Toast 还是行内文案？',
    });

    expect(matches.map((ticket) => ticket.id)).not.toContain(pending.id);
    expect(matches.map((ticket) => ticket.id)).not.toContain(unrelated.id);
  });

  it('can exclude the current ticket id', async () => {
    const projectName = 'memory-exclude-project';
    const resolved = await createTicket({
      projectName,
      blockerQuestion: '统一使用 Pinia 还是 Vuex？',
    });
    await resolveTicket(resolved.id, 'A');

    const matches = ctx.app.repo.findSimilarTickets({
      projectName,
      blockerQuestion: '统一使用 Pinia 还是 Vuex？',
      excludeId: Number(resolved.id),
    });

    expect(matches.map((ticket) => ticket.id)).not.toContain(resolved.id);
  });
});
