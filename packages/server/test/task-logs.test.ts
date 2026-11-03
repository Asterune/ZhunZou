import { describe, expect, it } from 'vitest';

import type { AgentTask, TaskLog } from '@zhunzou/shared';

import { createTestContext } from './helpers.js';

const ENV = 'log-env';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

async function createTask(ctx: Ctx, env = ENV): Promise<AgentTask> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: ctx.auth,
    payload: {
      env,
      projectName: 'logs',
      title: '带输出的任务',
      instruction: '产出一些日志。',
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().task as AgentTask;
}

async function claimTask(ctx: Ctx, env = ENV): Promise<AgentTask> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/tasks/next?env=${env}&timeout=10`,
    headers: ctx.auth,
  });
  expect(response.statusCode).toBe(200);
  return response.json().task as AgentTask;
}

async function appendLog(
  ctx: Ctx,
  taskId: string,
  chunk: string,
  stream: 'stdout' | 'stderr' | 'system' = 'stdout',
  headers = ctx.auth,
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/log`,
    headers,
    payload: { stream, chunk },
  });
}

describe('task execution logs', () => {
  it('appends and pages stdout/stderr chunks', async () => {
    const ctx = await createTestContext();
    try {
      const task = await createTask(ctx);
      await claimTask(ctx);

      expect((await appendLog(ctx, task.id, 'hello ')).statusCode).toBe(201);
      const second = await appendLog(ctx, task.id, 'oops', 'stderr');
      expect(second.statusCode).toBe(201);

      const all = await ctx.app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/logs`,
        headers: ctx.auth,
      });
      expect(all.statusCode).toBe(200);
      const page = all.json() as {
        logs: TaskLog[];
        nextAfter: number;
        truncated: boolean;
      };
      expect(page.logs.map((log) => log.chunk)).toEqual(['hello ', 'oops']);
      expect(page.logs[1]?.stream).toBe('stderr');
      expect(page.truncated).toBe(false);

      const after = await ctx.app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/logs?after=${page.logs[0]!.id}`,
        headers: ctx.auth,
      });
      expect(after.json().logs).toHaveLength(1);
      expect(after.json().logs[0].chunk).toBe('oops');
    } finally {
      await ctx.close();
    }
  });

  it('only accepts logs while the task is CLAIMED', async () => {
    const ctx = await createTestContext();
    try {
      const task = await createTask(ctx);

      const pending = await appendLog(ctx, task.id, 'too early');
      expect(pending.statusCode).toBe(409);

      await claimTask(ctx);
      await ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/complete`,
        headers: ctx.auth,
        payload: { status: 'DONE', result: 'ok' },
      });

      const late = await appendLog(ctx, task.id, 'too late');
      expect(late.statusCode).toBe(409);
    } finally {
      await ctx.close();
    }
  });

  it('scopes agent tokens to their own task logs', async () => {
    const ctx = await createTestContext();
    try {
      const tokenResponse = await ctx.app.inject({
        method: 'POST',
        url: `/api/agents/${ENV}/token`,
        headers: ctx.auth,
      });
      const agentAuth = {
        authorization: `Bearer ${tokenResponse.json().token}`,
      };

      const own = await createTask(ctx);
      await claimTask(ctx);
      expect(
        (await appendLog(ctx, own.id, 'mine', 'stdout', agentAuth)).statusCode,
      ).toBe(201);

      const foreign = await createTask(ctx, 'other-env');
      const foreignClaim = await ctx.app.inject({
        method: 'GET',
        url: '/api/tasks/next?env=other-env&timeout=10',
        headers: ctx.auth,
      });
      expect(foreignClaim.statusCode).toBe(200);

      expect(
        (await appendLog(ctx, foreign.id, 'not mine', 'stdout', agentAuth))
          .statusCode,
      ).toBe(403);

      const read = await ctx.app.inject({
        method: 'GET',
        url: `/api/tasks/${foreign.id}/logs`,
        headers: agentAuth,
      });
      expect(read.statusCode).toBe(403);
    } finally {
      await ctx.close();
    }
  });

  it('trims the oldest chunks to keep the log bounded', async () => {
    const ctx = await createTestContext();
    try {
      const task = await createTask(ctx);
      await claimTask(ctx);

      const chunk = 'x'.repeat(16_384);
      for (let index = 0; index < 18; index += 1) {
        expect((await appendLog(ctx, task.id, chunk)).statusCode).toBe(201);
      }

      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/logs?limit=500`,
        headers: ctx.auth,
      });
      const logs = response.json().logs as TaskLog[];
      const total = logs.reduce((sum, log) => sum + log.chunk.length, 0);

      expect(total).toBeLessThanOrEqual(256 * 1024);
      expect(logs.length).toBeLessThan(18);
      // The newest chunk must survive.
      expect(logs.at(-1)?.chunk).toHaveLength(16_384);
    } finally {
      await ctx.close();
    }
  });
});
