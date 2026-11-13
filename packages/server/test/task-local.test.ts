import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { AgentTask } from '@zhunzou/shared';

import { createDatabase } from '../src/db/client.js';
import { TicketRepository } from '../src/repository.js';
import { createTestContext } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

const WRAP_BODY = {
  env: 'wrap-env',
  projectName: 'pte-dojo',
  title: 'cursor-agent -p 修登录页校验',
  instruction: 'cursor-agent -p --force 修登录页校验',
  engine: 'cursor',
  workspacePath: '/Users/qiliu/code/pte-dojo',
};

async function register(
  ctx: Ctx,
  body: Record<string, unknown> = WRAP_BODY,
  headers = ctx.auth,
) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/tasks/local',
    headers,
    payload: body,
  });
}

async function takeover(
  ctx: Ctx,
  taskId: string,
  body: Record<string, unknown> = { reason: '本地 5 分钟无操作，卡在 y/n' },
  headers = ctx.auth,
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/takeover`,
    headers,
    payload: body,
  });
}

async function agentHeaders(ctx: Ctx, env: string): Promise<{ authorization: string }> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/agents/${env}/token`,
    headers: ctx.auth,
  });
  return { authorization: `Bearer ${response.json().token as string}` };
}

async function logs(ctx: Ctx, taskId: string) {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/tasks/${taskId}/logs`,
    headers: ctx.auth,
  });
  return response.json() as { logs: Array<{ stream: string; chunk: string }> };
}

describe('local wrap registration', () => {
  it('creates a claimed LOCAL_WRAP task that no wake loop can steal', async () => {
    const ctx = await createTestContext();
    try {
      const agentAuth = await agentHeaders(ctx, 'wrap-env');
      const response = await register(ctx, WRAP_BODY, agentAuth);
      expect(response.statusCode).toBe(201);
      const task = response.json().task as AgentTask;
      expect(task).toMatchObject({
        origin: 'LOCAL_WRAP',
        status: 'CLAIMED',
        attempts: 1,
        managedBySupervisor: false,
        engine: 'cursor',
        workspacePath: '/Users/qiliu/code/pte-dojo',
      });
      expect(task.claimedAt).toBeGreaterThan(0);
      expect(task.leaseAt).toBe(task.claimedAt);

      // The whole point: a PENDING row here would be claimed and re-run.
      const next = await ctx.app.inject({
        method: 'GET',
        url: '/api/tasks/next?env=wrap-env&timeout=10',
        headers: ctx.auth,
      });
      expect(next.json().task).toBeNull();
    } finally {
      await ctx.close();
    }
  });

  it('reports engine events and logs against the wrapped run', async () => {
    const ctx = await createTestContext();
    try {
      const task = (await register(ctx)).json().task as AgentTask;

      const events = await ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/events`,
        headers: ctx.auth,
        payload: { events: [{ kind: 'session', sessionId: 'ses_1' }] },
      });
      expect(events.statusCode).toBe(201);

      const log = await ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/log`,
        headers: ctx.auth,
        payload: { stream: 'stdout', chunk: 'Applying edit…' },
      });
      expect(log.statusCode).toBe(201);

      const shown = await ctx.app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}`,
        headers: ctx.auth,
      });
      expect((shown.json().task as AgentTask).sessionId).toBe('ses_1');
    } finally {
      await ctx.close();
    }
  });

  it('ignores an origin the node claims for itself', async () => {
    const ctx = await createTestContext();
    try {
      const response = await register(ctx, {
        ...WRAP_BODY,
        origin: 'HUB_DISPATCH',
        status: 'DONE',
        managedBySupervisor: true,
        attempts: 99,
      });
      expect(response.statusCode).toBe(201);
      const task = response.json().task as AgentTask;
      expect(task.origin).toBe('LOCAL_WRAP');
      expect(task.status).toBe('CLAIMED');
      expect(task.managedBySupervisor).toBe(false);
      expect(task.attempts).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it('refuses to register into someone else env', async () => {
    const ctx = await createTestContext();
    try {
      const agentAuth = await agentHeaders(ctx, 'mine-env');
      const response = await register(ctx, { ...WRAP_BODY, env: 'theirs-env' }, agentAuth);
      expect(response.statusCode).toBe(403);
      expect((await response.json()).error.code).toBe('ENV_FORBIDDEN');
    } finally {
      await ctx.close();
    }
  });

  it('rejects a relative workspace and a blank title', async () => {
    const ctx = await createTestContext();
    try {
      expect(
        (await register(ctx, { ...WRAP_BODY, workspacePath: 'pte-dojo' })).statusCode,
      ).toBe(400);
      expect((await register(ctx, { ...WRAP_BODY, title: '  ' })).statusCode).toBe(400);
      expect((await register(ctx, { ...WRAP_BODY, engine: 'vim' })).statusCode).toBe(400);
    } finally {
      await ctx.close();
    }
  });
});

describe('task takeover', () => {
  it('hands a live run to the supervisor and records why', async () => {
    const ctx = await createTestContext();
    try {
      const task = (await register(ctx)).json().task as AgentTask;
      const response = await takeover(ctx, task.id);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ changed: true });
      expect((response.json().task as AgentTask).managedBySupervisor).toBe(true);

      const entries = await logs(ctx, task.id);
      expect(entries.logs.some((item) => item.chunk.includes('卡在 y/n'))).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it('is idempotent and leaves no second audit line', async () => {
    const ctx = await createTestContext();
    try {
      const task = (await register(ctx)).json().task as AgentTask;
      expect((await takeover(ctx, task.id)).statusCode).toBe(200);

      const second = await takeover(ctx, task.id, { reason: '再来一次' });
      expect(second.statusCode).toBe(200);
      expect(second.json().changed).toBe(false);

      const entries = await logs(ctx, task.id);
      expect(entries.logs.filter((item) => item.stream === 'system')).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });

  it('will not take over work that already finished', async () => {
    const ctx = await createTestContext();
    try {
      const task = (await register(ctx)).json().task as AgentTask;
      await ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/complete`,
        headers: ctx.auth,
        payload: { status: 'DONE', result: '完成' },
      });

      const response = await takeover(ctx, task.id);
      expect(response.statusCode).toBe(409);
      expect((await response.json()).error.code).toBe('INVALID_TASK_STATUS');
      expect((await takeover(ctx, '90011')).statusCode).toBe(404);
    } finally {
      await ctx.close();
    }
  });

  it('takes over a dispatched task too, but only its own env', async () => {
    const ctx = await createTestContext();
    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: ctx.auth,
        payload: { env: 'guard-env', title: '派单', instruction: '跑一下' },
      });
      const claimed = await ctx.app.inject({
        method: 'GET',
        url: '/api/tasks/next?env=guard-env&timeout=10',
        headers: ctx.auth,
      });
      const taskId = (claimed.json().task as AgentTask).id;
      expect(taskId).toBe(created.json().task.id);

      const other = await agentHeaders(ctx, 'wrap-env');
      expect((await takeover(ctx, taskId, { reason: '不该越界' }, other)).statusCode).toBe(403);

      const mine = await agentHeaders(ctx, 'guard-env');
      expect((await takeover(ctx, taskId, { reason: '本机无人' }, mine)).statusCode).toBe(200);
    } finally {
      await ctx.close();
    }
  });
});

describe('local wrap on an old database', () => {
  it('registers and takes over after the columns were added', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhunzou-legacy-'));
    const path = join(dir, 'legacy.db');
    const old = new Database(path);
    old
      .exec(`CREATE TABLE agent_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        env TEXT NOT NULL,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        project_name TEXT,
        claimed_at INTEGER,
        completed_at INTEGER,
        result TEXT,
        lease_at INTEGER
      );`);
    old.close();

    const upgraded = createDatabase(path);
    const repo = new TicketRepository(upgraded.db);
    try {
      const task = repo.createWrappedTask({
        env: 'legacy-env',
        title: 'claude -p 补测试',
        instruction: 'claude -p 补测试',
      });
      expect(task.origin).toBe('LOCAL_WRAP');
      expect(task.status).toBe('CLAIMED');
      expect(task.managedBySupervisor).toBe(false);

      const takeoverResult = repo.markTaskManaged(Number(task.id), '本地无操作');
      expect(takeoverResult.changed).toBe(true);
      expect(takeoverResult.task.managedBySupervisor).toBe(true);
      expect(repo.markTaskManaged(Number(task.id), '重复').changed).toBe(false);
    } finally {
      upgraded.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
