import { describe, expect, it } from 'vitest';

import type { AgentTask } from '@zhunzou/shared';

import {
  createTestContext,
  waitFor,
} from './helpers.js';

const ENV = 'stale-task-env';

async function createTask(ctx: Awaited<ReturnType<typeof createTestContext>>): Promise<AgentTask> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: ctx.auth,
    payload: {
      env: ENV,
      projectName: 'stale-project',
      title: '长时间任务',
      instruction: '做完后回报结果。',
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().task as AgentTask;
}

async function claimTask(
  ctx: Awaited<ReturnType<typeof createTestContext>>,
): Promise<AgentTask | null> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/tasks/next?env=${ENV}&timeout=10`,
    headers: ctx.auth,
  });
  expect(response.statusCode).toBe(200);
  return response.json().task as AgentTask | null;
}

describe('stale CLAIMED task cleanup', () => {
  it('requeues a task when its env goes offline, then fails it after max attempts', async () => {
    const ctx = await createTestContext(undefined, undefined, {
      TASK_CLAIM_TIMEOUT_MS: '0',
      TASK_MAX_ATTEMPTS: '2',
      SWEEP_INTERVAL_MS: '20',
    });

    try {
      await createTask(ctx);

      const first = await claimTask(ctx);
      expect(first).toMatchObject({ status: 'CLAIMED', attempts: 1 });

      const requeued = await waitFor(() => {
        const task = ctx.app.repo.getTask(Number(first!.id));
        return task?.status === 'PENDING' ? task : null;
      });
      expect(requeued.attempts).toBe(1);

      const second = await claimTask(ctx);
      expect(second).toMatchObject({ status: 'CLAIMED', attempts: 2 });

      const failed = await waitFor(() => {
        const task = ctx.app.repo.getTask(Number(second!.id));
        return task?.status === 'FAILED' ? task : null;
      });
      expect(failed.result).toContain('离线');
    } finally {
      await ctx.close();
    }
  });

  it('fails a task after the hard timeout even when the env is online', async () => {
    const ctx = await createTestContext(undefined, undefined, {
      TASK_HARD_TIMEOUT_MS: '50',
      TASK_CLAIM_TIMEOUT_MS: '999999',
      TASK_MAX_ATTEMPTS: '5',
      SWEEP_INTERVAL_MS: '20',
    });

    try {
      await createTask(ctx);
      const claimed = await claimTask(ctx);
      expect(claimed?.status).toBe('CLAIMED');

      await ctx.app.inject({
        method: 'POST',
        url: '/api/status/heartbeat',
        headers: ctx.auth,
        payload: { env: ENV, status: 'Running', currentTask: '长时间任务' },
      });

      const failed = await waitFor(() => {
        const task = ctx.app.repo.getTask(Number(claimed!.id));
        return task?.status === 'FAILED' ? task : null;
      });
      expect(failed.result).toContain('超时');
    } finally {
      await ctx.close();
    }
  });

  it('does not touch a healthy claimed task', async () => {
    const ctx = await createTestContext(undefined, undefined, {
      TASK_CLAIM_TIMEOUT_MS: '50',
      TASK_HARD_TIMEOUT_MS: '999999',
      SWEEP_INTERVAL_MS: '20',
    });

    try {
      await createTask(ctx);
      const claimed = await claimTask(ctx);
      expect(claimed?.status).toBe('CLAIMED');

      await ctx.app.inject({
        method: 'POST',
        url: '/api/status/heartbeat',
        headers: ctx.auth,
        payload: { env: ENV, status: 'Running', currentTask: '长时间任务' },
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(ctx.app.repo.getTask(Number(claimed!.id))?.status).toBe('CLAIMED');
    } finally {
      await ctx.close();
    }
  });
});
