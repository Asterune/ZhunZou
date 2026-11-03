import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentTask, CreateTaskInput } from '@zhunzou/shared';

import { createTestContext, sleep, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

function taskInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    env: 'company-windows',
    projectName: 'yikuaomed-erp',
    title: '给登录页补错误提示',
    instruction: '统一使用行内文案，并补一条测试。',
    ...overrides,
  };
}

async function createTask(
  overrides: Partial<CreateTaskInput> = {},
): Promise<AgentTask> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: ctx.auth,
    payload: taskInput(overrides),
  });
  expect(response.statusCode).toBe(201);
  return response.json().task as AgentTask;
}

describe('POST /api/tasks', () => {
  it('creates a PENDING task', async () => {
    const task = await createTask({ env: 'create-task-env' });

    expect(task.id).toMatch(/^\d+$/);
    expect(task.status).toBe('PENDING');
    expect(task.title).toBe('给登录页补错误提示');
    expect(task.createdAt).toBeGreaterThan(0);
  });

  it('rejects an empty instruction', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: ctx.auth,
      payload: taskInput({ instruction: '' }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/tasks', () => {
  it('filters by env and status', async () => {
    await createTask({ env: 'filter-task-env', title: 'one' });
    await createTask({ env: 'filter-task-env', title: 'two' });

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/tasks?env=filter-task-env&status=PENDING',
      headers: ctx.auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().tasks).toHaveLength(2);
  });
});

describe('GET /api/tasks/next', () => {
  it('claims the oldest pending task for the requested env', async () => {
    const first = await createTask({ env: 'claim-env', title: 'first' });
    const second = await createTask({ env: 'claim-env', title: 'second' });
    await createTask({ env: 'other-env', title: 'other' });

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/tasks/next?env=claim-env&timeout=100',
      headers: ctx.auth,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.timedOut).toBe(false);
    expect(body.task.id).toBe(first.id);
    expect(body.task.status).toBe('CLAIMED');

    const again = await ctx.app.inject({
      method: 'GET',
      url: '/api/tasks/next?env=claim-env&timeout=100',
      headers: ctx.auth,
    });
    expect(again.json().task.id).toBe(second.id);
  });

  it('times out when the env has no task', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/tasks/next?env=nobody-home&timeout=50',
      headers: ctx.auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ task: null, timedOut: true });
  });

  it('wakes immediately when a task is dispatched mid-poll', async () => {
    const waiting = ctx.app.inject({
      method: 'GET',
      url: '/api/tasks/next?env=wake-env&timeout=3000',
      headers: ctx.auth,
    });

    await sleep(100);
    const created = await createTask({ env: 'wake-env', title: 'wake up' });

    const response = await waiting;
    expect(response.statusCode).toBe(200);
    expect(response.json().task.id).toBe(created.id);
    expect(response.json().task.status).toBe('CLAIMED');
  });
});

describe('POST /api/tasks/:id/complete', () => {
  it('marks a claimed task DONE and records the result', async () => {
    const task = await createTask({ env: 'complete-env' });
    await ctx.app.inject({
      method: 'GET',
      url: '/api/tasks/next?env=complete-env&timeout=100',
      headers: ctx.auth,
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/complete`,
      headers: ctx.auth,
      payload: { status: 'DONE', result: '已补测试' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().task as AgentTask;
    expect(body.status).toBe('DONE');
    expect(body.result).toBe('已补测试');
    expect(body.completedAt).toBeGreaterThan(0);
  });

  it('rejects completing a task that was never claimed', async () => {
    const task = await createTask({ env: 'unclaimed-env' });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/complete`,
      headers: ctx.auth,
      payload: { status: 'DONE' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('INVALID_TASK_STATUS');
  });
});

describe('POST /api/tasks/:id/release', () => {
  it('requeues a claimed task so another adapter can retry it', async () => {
    const task = await createTask({ env: 'release-env' });
    await ctx.app.inject({
      method: 'GET',
      url: '/api/tasks/next?env=release-env&timeout=100',
      headers: ctx.auth,
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/release`,
      headers: ctx.auth,
      payload: { requeue: true, reason: '端侧未能唤醒' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().task as AgentTask;
    expect(body.status).toBe('PENDING');
    expect(body.claimedAt).toBeUndefined();
    expect(body.attempts).toBe(1);

    // The requeued task is claimable again.
    const again = await ctx.app.inject({
      method: 'GET',
      url: '/api/tasks/next?env=release-env&timeout=100',
      headers: ctx.auth,
    });
    expect(again.json().task.id).toBe(task.id);
    expect(again.json().task.attempts).toBe(2);
  });

  it('fails the task when requeue is false', async () => {
    const task = await createTask({ env: 'release-fail-env' });
    await ctx.app.inject({
      method: 'GET',
      url: '/api/tasks/next?env=release-fail-env&timeout=100',
      headers: ctx.auth,
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/release`,
      headers: ctx.auth,
      payload: { requeue: false, reason: '没有可用客户端' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().task as AgentTask;
    expect(body.status).toBe('FAILED');
    expect(body.result).toBe('没有可用客户端');
  });

  it('rejects releasing a task that was never claimed', async () => {
    const task = await createTask({ env: 'release-pending-env' });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/release`,
      headers: ctx.auth,
      payload: { requeue: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('ALREADY_FINALIZED');
  });
});

describe('POST /api/tasks/:id/cancel', () => {
  it('cancels a pending task', async () => {
    const task = await createTask({ env: 'cancel-env' });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/cancel`,
      headers: ctx.auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().task.status).toBe('CANCELLED');
  });

  it('rejects cancelling a finished task', async () => {
    const task = await createTask({ env: 'cancel-done-env' });
    await ctx.app.inject({
      method: 'GET',
      url: '/api/tasks/next?env=cancel-done-env&timeout=100',
      headers: ctx.auth,
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/complete`,
      headers: ctx.auth,
      payload: { status: 'DONE' },
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/cancel`,
      headers: ctx.auth,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('ALREADY_FINALIZED');
  });
});
