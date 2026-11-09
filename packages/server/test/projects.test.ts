import { describe, expect, it } from 'vitest';

import type { Project } from '@zhunzou/shared';

import { createTestContext, ticketInput, type TestContext } from './helpers.js';

async function projects(ctx: TestContext): Promise<Project[]> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/projects',
    headers: ctx.auth,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { projects: Project[] }).projects;
}

async function createTicket(
  ctx: TestContext,
  overrides: Parameters<typeof ticketInput>[0],
): Promise<string> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tickets',
    headers: ctx.auth,
    payload: ticketInput(overrides),
  });
  return (response.json() as { ticket: { id: string } }).ticket.id;
}

describe('GET /api/projects', () => {
  it('counts the work seen under each project name', async () => {
    const ctx = await createTestContext();
    try {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/agents',
        headers: ctx.auth,
        payload: { env: 'cursor-erp', kind: 'cursor', host: 'lq' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: '/api/status/heartbeat',
        headers: ctx.auth,
        payload: {
          env: 'cursor-erp',
          status: 'Working',
          projectName: 'erp',
          agent: { host: 'lq' },
        },
      });

      const open = await createTicket(ctx, {
        env: 'cursor-erp',
        projectName: 'erp',
      });
      await createTicket(ctx, { env: 'cursor-erp', projectName: 'erp' });
      await createTicket(ctx, {
        env: 'opencode-crm',
        projectName: 'crm',
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/api/tickets/${open}/resolve`,
        headers: ctx.auth,
        payload: { selectedOption: 'A' },
      });
      ctx.app.repo.createTask({
        env: 'cursor-erp',
        title: '补测试',
        instruction: '给登录页补测试',
        projectName: 'erp',
      });

      const list = await projects(ctx);
      expect(list.find((project) => project.name === 'erp')).toMatchObject({
        ticketCount: 2,
        pendingCount: 1,
        taskCount: 1,
        envs: ['cursor-erp'],
        deviceIds: ['host:lq'],
      });
      // The env that filed this ticket never enrolled, so the project has work
      // to report but no live machine behind it.
      expect(list.find((project) => project.name === 'crm')).toMatchObject({
        ticketCount: 1,
        pendingCount: 1,
        envs: [],
        deviceIds: [],
      });
      // Most recently active first.
      expect(list[0]?.name).toBe('erp');
    } finally {
      await ctx.close();
    }
  });

  it('keeps a project the hub only knows from a binding', async () => {
    const ctx = await createTestContext();
    try {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/agents',
        headers: ctx.auth,
        payload: { env: 'cursor-legacy', kind: 'cursor', host: 'office-pc' },
      });
      ctx.app.repo.bindWorkspaceProject('cursor-legacy', 'legacy-wiki');

      const [project] = await projects(ctx);
      expect(project).toMatchObject({
        name: 'legacy-wiki',
        ticketCount: 0,
        taskCount: 0,
        envs: ['cursor-legacy'],
        deviceIds: ['host:office-pc'],
      });
      expect(project.lastActivityAt).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it('drops a project whose only evidence was a deleted agent', async () => {
    const ctx = await createTestContext();
    try {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/agents',
        headers: ctx.auth,
        payload: { env: 'cursor-legacy', kind: 'cursor', host: 'office-pc' },
      });
      ctx.app.repo.bindWorkspaceProject('cursor-legacy', 'legacy-wiki');
      expect(await projects(ctx)).toHaveLength(1);

      await ctx.app.inject({
        method: 'DELETE',
        url: '/api/agents/cursor-legacy',
        headers: ctx.auth,
      });

      // The binding row survives deletion, so filtering on it alone would keep
      // advertising a project the hub can no longer reach.
      expect(await projects(ctx)).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it('answers admin credentials only', async () => {
    const ctx = await createTestContext();
    try {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/projects',
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await ctx.close();
    }
  });
});
