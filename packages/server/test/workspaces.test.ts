import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WorkspaceProject } from '@zhunzou/shared';

import { createTestContext, ticketInput, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

async function bind(
  env: string,
  projectName: string,
): Promise<WorkspaceProject> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/workspace-projects',
    headers: ctx.auth,
    payload: { env, projectName },
  });
  expect(response.statusCode).toBe(201);
  return response.json().project as WorkspaceProject;
}

async function list(env?: string): Promise<WorkspaceProject[]> {
  const query = env ? `?env=${encodeURIComponent(env)}` : '';
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/workspace-projects${query}`,
    headers: ctx.auth,
  });
  expect(response.statusCode).toBe(200);
  return response.json().projects as WorkspaceProject[];
}

describe('workspace project bindings', () => {
  it('binds a project to a workspace and lists it', async () => {
    const project = await bind('bind-env', 'yikuaomed-erp');

    expect(project.id).toMatch(/^\d+$/);
    expect(project.env).toBe('bind-env');
    expect(project.projectName).toBe('yikuaomed-erp');

    const projects = await list('bind-env');
    expect(projects).toHaveLength(1);
    expect(projects[0]?.projectName).toBe('yikuaomed-erp');
  });

  it('is idempotent for the same env and project', async () => {
    const first = await bind('idempotent-env', 'agent-hub');
    const second = await bind('idempotent-env', 'agent-hub');

    expect(second.id).toBe(first.id);
    expect(await list('idempotent-env')).toHaveLength(1);
  });

  it('rejects an empty project name', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspace-projects',
      headers: ctx.auth,
      payload: { env: 'invalid-env', projectName: '   ' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('filters the list by env', async () => {
    await bind('filter-env-a', 'project-a');
    await bind('filter-env-b', 'project-b');

    const projects = await list('filter-env-a');
    expect(projects.map((project) => project.projectName)).toEqual(['project-a']);
  });

  it('auto-binds the project reported by a heartbeat', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/status/heartbeat',
      headers: ctx.auth,
      payload: {
        env: 'heartbeat-env',
        status: 'Running',
        projectName: 'heartbeat-project',
      },
    });
    expect(response.statusCode).toBe(200);

    const projects = await list('heartbeat-env');
    expect(projects.map((project) => project.projectName)).toEqual([
      'heartbeat-project',
    ]);
  });

  it('auto-binds the project of a dispatched task', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: ctx.auth,
      payload: {
        env: 'task-env',
        projectName: 'task-project',
        title: '绑定工作区项目',
        instruction: '验证任务下发时自动绑定项目。',
      },
    });
    expect(response.statusCode).toBe(201);

    const projects = await list('task-env');
    expect(projects.map((project) => project.projectName)).toEqual([
      'task-project',
    ]);
  });

  it('auto-binds the project of a ticket', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: ctx.auth,
      payload: ticketInput({ env: 'ticket-env', projectName: 'ticket-project' }),
    });
    expect(response.statusCode).toBe(201);

    const projects = await list('ticket-env');
    expect(projects.map((project) => project.projectName)).toEqual([
      'ticket-project',
    ]);
  });

  it('removes a binding', async () => {
    const project = await bind('unbind-env', 'temporary-project');

    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/workspace-projects/${project.id}`,
      headers: ctx.auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().project.id).toBe(project.id);
    expect(await list('unbind-env')).toHaveLength(0);
  });

  it('returns 404 when unbinding an unknown project', async () => {
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/workspace-projects/999999',
      headers: ctx.auth,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});
