import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentTask, DecisionTicket } from '@zhunzou/shared';

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
  env: string,
  overrides: Parameters<typeof ticketInput>[0] = {},
): Promise<DecisionTicket> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tickets',
    headers: ctx.auth,
    payload: ticketInput({ env, ...overrides }),
  });
  expect(response.statusCode).toBe(201);
  return response.json().ticket as DecisionTicket;
}

describe('GET /api/resume', () => {
  it('returns pending/recent tickets and active tasks for one env', async () => {
    const env = 'resume-env';
    const pending = await createTicket(env, { projectName: 'resume-pending' });
    const resolved = await createTicket(env, { projectName: 'resume-resolved' });
    const other = await createTicket('other-env', {
      projectName: 'resume-other',
    });

    await ctx.app.inject({
      method: 'POST',
      url: `/api/tickets/${resolved.id}/resolve`,
      headers: ctx.auth,
      payload: { selectedOption: 'B' },
    });

    const taskResponse = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: ctx.auth,
      payload: {
        env,
        projectName: 'resume-pending',
        title: '继续未完成的任务',
        instruction: '先读现有代码再继续。',
      },
    });
    const task = taskResponse.json().task as AgentTask;
    await ctx.app.inject({
      method: 'GET',
      url: `/api/tasks/next?env=${env}&timeout=10`,
      headers: ctx.auth,
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/resume?env=${env}`,
      headers: ctx.auth,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const ticketIds = body.tickets.map((ticket: DecisionTicket) => ticket.id);

    expect(ticketIds).toContain(pending.id);
    expect(ticketIds).toContain(resolved.id);
    expect(ticketIds).not.toContain(other.id);
    expect(
      body.tasks.some((item: AgentTask) => item.id === task.id),
    ).toBe(true);
  });

  it('prioritizes pending tickets over recent terminal ones', async () => {
    const env = 'resume-priority-env';
    const pending = await createTicket(env, { projectName: 'priority-pending' });

    for (let index = 0; index < 4; index += 1) {
      const resolved = await createTicket(env, {
        projectName: `priority-resolved-${index}`,
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/api/tickets/${resolved.id}/resolve`,
        headers: ctx.auth,
        payload: { selectedOption: 'A' },
      });
    }

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/resume?env=${env}&limit=2`,
      headers: ctx.auth,
    });

    const body = response.json();
    expect(body.tickets[0]?.id).toBe(pending.id);
  });

  it('requires an env', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/resume',
      headers: ctx.auth,
    });
    expect(response.statusCode).toBe(400);
  });
});
