import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DecisionTicket } from '@zhunzou/shared';

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

describe('POST /api/tickets/batch-resolve', () => {
  it('resolves each ticket with its own recommended option', async () => {
    const first = await createTicket({ projectName: 'batch-one' });
    const second = await createTicket({
      projectName: 'batch-two',
      recommendedOption: 'B',
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/tickets/batch-resolve',
      headers: ctx.auth,
      payload: { ticketIds: [first.id, second.id] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.skipped).toEqual([]);
    expect(body.tickets).toHaveLength(2);
    expect(
      body.tickets.find((ticket: DecisionTicket) => ticket.id === first.id)
        ?.selectedOption,
    ).toBe('A');
    expect(
      body.tickets.find((ticket: DecisionTicket) => ticket.id === second.id)
        ?.selectedOption,
    ).toBe('B');
  });

  it('pins a selected option across all tickets', async () => {
    const first = await createTicket({ projectName: 'batch-pin-one' });
    const second = await createTicket({ projectName: 'batch-pin-two' });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/tickets/batch-resolve',
      headers: ctx.auth,
      payload: {
        ticketIds: [first.id, second.id],
        selectedOption: 'B',
        customInstruction: '统一按 B 执行',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .tickets.every((ticket: DecisionTicket) => ticket.selectedOption === 'B'),
    ).toBe(true);
    expect(
      response
        .json()
        .tickets.every(
          (ticket: DecisionTicket) =>
            ticket.customInstruction === '统一按 B 执行',
        ),
    ).toBe(true);
  });

  it('skips finalized and unknown tickets instead of failing the batch', async () => {
    const ticket = await createTicket({ projectName: 'batch-skip' });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/resolve`,
      headers: ctx.auth,
      payload: { selectedOption: 'A' },
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/tickets/batch-resolve',
      headers: ctx.auth,
      payload: { ticketIds: [ticket.id, '999999'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().tickets).toEqual([]);
    expect(response.json().skipped).toHaveLength(2);
    expect(response.json().skipped.map((item: { id: string }) => item.id)).toEqual(
      [ticket.id, '999999'],
    );
  });

  it('skips destructive options unless explicitly confirmed', async () => {
    const ticket = await createTicket({
      projectName: 'batch-destructive',
      options: [
        { key: 'A', label: '删除数据', risk: 'destructive' },
        { key: 'B', label: '保留数据' },
      ],
      recommendedOption: 'A',
    });

    const refused = await ctx.app.inject({
      method: 'POST',
      url: '/api/tickets/batch-resolve',
      headers: ctx.auth,
      payload: { ticketIds: [ticket.id] },
    });
    expect(refused.statusCode).toBe(200);
    expect(refused.json().tickets).toEqual([]);
    expect(refused.json().skipped[0].reason).toContain('破坏性');

    const confirmed = await ctx.app.inject({
      method: 'POST',
      url: '/api/tickets/batch-resolve',
      headers: ctx.auth,
      payload: { ticketIds: [ticket.id], confirmDestructive: true },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().tickets[0].selectedOption).toBe('A');
  });

  it('rejects an empty ticket list', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/tickets/batch-resolve',
      headers: ctx.auth,
      payload: { ticketIds: [] },
    });
    expect(response.statusCode).toBe(400);
  });
});
