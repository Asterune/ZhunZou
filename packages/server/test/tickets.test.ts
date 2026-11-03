import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DecisionTicket } from '@zhunzou/shared';

import {
  createTestContext,
  sleep,
  TEST_TOKEN,
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

describe('authentication', () => {
  it('exposes an unauthenticated health check', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
  });

  it('rejects requests without a token', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/tickets' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects requests with a wrong token', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { authorization: 'Bearer nope' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts the configured token', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('POST /api/tickets', () => {
  it('creates a PENDING_META ticket with a numeric string id', async () => {
    const ticket = await createTicket({ projectName: 'create-test' });

    expect(ticket.id).toMatch(/^\d+$/);
    expect(ticket.status).toBe('PENDING_META');
    expect(ticket.options).toHaveLength(2);
    expect(ticket.createdAt).toBeGreaterThan(0);
  });

  it('rejects duplicate option keys', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: ctx.auth,
      payload: ticketInput({
        options: [
          { key: 'A', label: '方案一' },
          { key: 'A', label: '方案二' },
        ],
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a recommendation outside the options', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: ctx.auth,
      payload: ticketInput({ recommendedOption: 'Z' }),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/tickets', () => {
  it('filters by projectName', async () => {
    await createTicket({ projectName: 'filter-project' });
    await createTicket({ projectName: 'other-project' });

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/tickets?projectName=filter-project',
      headers: ctx.auth,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tickets.length).toBeGreaterThan(0);
    expect(
      body.tickets.every((ticket: DecisionTicket) => ticket.projectName === 'filter-project'),
    ).toBe(true);
  });

  it('filters by status', async () => {
    const ticket = await createTicket();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/resolve`,
      headers: ctx.auth,
      payload: { selectedOption: 'B' },
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/tickets?status=HUMAN_RESOLVED',
      headers: ctx.auth,
    });

    const body = response.json();
    expect(body.tickets.length).toBeGreaterThan(0);
    expect(
      body.tickets.every(
        (item: DecisionTicket) => item.status === 'HUMAN_RESOLVED',
      ),
    ).toBe(true);
  });

  it('rejects an invalid status filter', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/tickets?status=DONE',
      headers: ctx.auth,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/tickets/:id/wait', () => {
  it('is woken immediately when a human resolves the ticket', async () => {
    const ticket = await createTicket();

    const waiter = ctx.app.inject({
      method: 'GET',
      url: `/api/tickets/${ticket.id}/wait?timeout=5000`,
      headers: ctx.auth,
    });

    await sleep(100);

    const startedAt = Date.now();
    const resolveResponse = await ctx.app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/resolve`,
      headers: ctx.auth,
      payload: { selectedOption: 'B', customInstruction: '用行内文案' },
    });
    expect(resolveResponse.statusCode).toBe(200);

    const waitResponse = await waiter;
    const elapsed = Date.now() - startedAt;

    expect(waitResponse.statusCode).toBe(200);
    const body = waitResponse.json();
    expect(body.resolved).toBe(true);
    expect(body.timedOut).toBe(false);
    expect(body.ticket.status).toBe('HUMAN_RESOLVED');
    expect(body.ticket.selectedOption).toBe('B');
    expect(body.ticket.customInstruction).toBe('用行内文案');
    expect(elapsed).toBeLessThan(1_000);
  });

  it('returns immediately when the ticket is already resolved', async () => {
    const ticket = await createTicket();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/resolve`,
      headers: ctx.auth,
      payload: { selectedOption: 'A' },
    });

    const startedAt = Date.now();
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/tickets/${ticket.id}/wait?timeout=5000`,
      headers: ctx.auth,
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(response.json()).toMatchObject({ resolved: true, timedOut: false });
  });

  it('times out without resolving', async () => {
    const ticket = await createTicket();

    const startedAt = Date.now();
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/tickets/${ticket.id}/wait?timeout=60`,
      headers: ctx.auth,
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
    expect(response.json()).toMatchObject({ resolved: false, timedOut: true });
    expect(['PENDING_META', 'PENDING_HUMAN']).toContain(response.json().ticket.status);
  });

  it('wakes waiters when a ticket is cancelled', async () => {
    const ticket = await createTicket();

    const waiter = ctx.app.inject({
      method: 'GET',
      url: `/api/tickets/${ticket.id}/wait?timeout=5000`,
      headers: ctx.auth,
    });

    await sleep(80);
    const cancelResponse = await ctx.app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/cancel`,
      headers: ctx.auth,
    });
    expect(cancelResponse.statusCode).toBe(200);

    const body = (await waiter).json();
    expect(body.resolved).toBe(false);
    expect(body.timedOut).toBe(false);
    expect(body.ticket.status).toBe('CANCELLED');
  });

  it('returns 404 for an unknown ticket', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/tickets/999999/wait?timeout=10',
      headers: ctx.auth,
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a timeout beyond the proxy-safe ceiling', async () => {
    const ticket = await createTicket();
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/tickets/${ticket.id}/wait?timeout=60000`,
      headers: ctx.auth,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /api/tickets/:id/resolve', () => {
  it('rejects an option that does not belong to the ticket', async () => {
    const ticket = await createTicket();
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/resolve`,
      headers: ctx.auth,
      payload: { selectedOption: 'Z' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('INVALID_OPTION');
  });

  it('rejects a second approval', async () => {
    const ticket = await createTicket();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/resolve`,
      headers: ctx.auth,
      payload: { selectedOption: 'A' },
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/resolve`,
      headers: ctx.auth,
      payload: { selectedOption: 'B' },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('ALREADY_FINALIZED');
  });
});

describe('body-less POST endpoints', () => {
  it('accepts a cancel request that declares JSON but sends no body', async () => {
    const ticket = await createTicket();

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/cancel`,
      headers: { ...ctx.auth, 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ticket.status).toBe('CANCELLED');
  });

  it('still rejects a malformed JSON body', async () => {
    const ticket = await createTicket();

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/resolve`,
      headers: { ...ctx.auth, 'content-type': 'application/json' },
      payload: '{"selectedOption":',
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('status heartbeats', () => {
  it('records heartbeats and marks the env online', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/status/heartbeat',
      headers: ctx.auth,
      payload: {
        env: 'company-cursor',
        status: 'Running',
        projectName: 'yikuaomed-erp',
        currentTask: '补测试',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().heartbeat).toMatchObject({
      env: 'company-cursor',
      status: 'Running',
      online: true,
    });

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: ctx.auth,
    });
    expect(
      list.json().envs.some((env: { env: string }) => env.env === 'company-cursor'),
    ).toBe(true);
  });

  it('normalizes the legacy idle label from older bridges', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/status/heartbeat',
      headers: ctx.auth,
      payload: {
        env: 'legacy-bridge',
        status: 'Idle',
        currentTask: 'MCP 已连接，等待任务',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().heartbeat.currentTask).toBe('MCP 已连接');
  });

  it('rejects an unknown status', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/status/heartbeat',
      headers: ctx.auth,
      payload: { env: 'company-cursor', status: 'Sleeping' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GLOBAL_RULES.md editing', () => {
  it('returns an empty document before the first write', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/rules',
      headers: ctx.auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ content: '', updatedAt: 0 });
  });

  it('persists rules written through the API', async () => {
    const content = '# 规则\n\n1. 一律使用 Pinia。\n';
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/rules',
      headers: ctx.auth,
      payload: { content },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().content).toBe(content);
    expect(put.json().updatedAt).toBeGreaterThan(0);

    const get = await ctx.app.inject({
      method: 'GET',
      url: '/api/rules',
      headers: ctx.auth,
    });
    expect(get.json().content).toBe(content);
  });
});
