import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { AgentTask, TaskEvent } from '@zhunzou/shared';

import { createDatabase } from '../src/db/client.js';
import { TicketRepository } from '../src/repository.js';
import { createTestContext } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

async function createTask(ctx: Ctx, env: string): Promise<AgentTask> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: ctx.auth,
    payload: {
      env,
      projectName: 'adapters',
      title: '给表单加校验',
      instruction: '按现有组件风格实现。',
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().task as AgentTask;
}

async function claimTask(ctx: Ctx, env: string): Promise<AgentTask | null> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/tasks/next?env=${env}&timeout=10`,
    headers: ctx.auth,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { task: AgentTask | null }).task;
}

async function report(
  ctx: Ctx,
  taskId: string,
  events: unknown[],
  headers = ctx.auth,
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/events`,
    headers,
    payload: { events },
  });
}

async function readEvents(ctx: Ctx, taskId: string, query = '', headers = ctx.auth) {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/tasks/${taskId}/events${query}`,
    headers,
  });
}

const TOOL_EVENT = { kind: 'tool_call', engine: 'claude-code', tool: 'Edit' };
const SESSION_EVENT = { kind: 'session', sessionId: 'abc-123' };

describe('task engine events', () => {
  it('stores a batch and pages it back', async () => {
    const ctx = await createTestContext();
    try {
      const task = await createTask(ctx, 'events-env');
      await claimTask(ctx, 'events-env');

      const stored = await report(ctx, task.id, [
        SESSION_EVENT,
        TOOL_EVENT,
        { kind: 'permission_required', tool: 'Bash', action: { kind: 'command', command: 'rm -rf build' } },
      ]);
      expect(stored.statusCode).toBe(201);
      expect(stored.json().stored).toBe(3);

      const all = await readEvents(ctx, task.id);
      expect(all.statusCode).toBe(200);
      const page = all.json() as { events: TaskEvent[]; nextAfter: number; truncated: boolean };
      expect(page.events.map((event) => event.kind)).toEqual([
        'session',
        'tool_call',
        'permission_required',
      ]);
      expect(page.events[0]?.sessionId).toBe('abc-123');
      expect(page.events[1]?.engine).toBe('claude-code');
      expect(page.truncated).toBe(false);

      const after = await readEvents(ctx, task.id, `?after=${page.events[0]!.id}&limit=1`);
      const second = after.json() as { events: TaskEvent[]; truncated: boolean };
      expect(second.events).toHaveLength(1);
      expect(second.events[0]?.kind).toBe('tool_call');
      // A full page means there is more to read, which is what the tailer loops on.
      expect(second.truncated).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it('keeps the session id on the task so the next claim resumes in place', async () => {
    const ctx = await createTestContext();
    try {
      const task = await createTask(ctx, 'resume-env');
      await claimTask(ctx, 'resume-env');
      expect((await report(ctx, task.id, [SESSION_EVENT])).statusCode).toBe(201);

      const released = await ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/release`,
        headers: ctx.auth,
        payload: { requeue: true, reason: '等待人工批准' },
      });
      expect(released.statusCode).toBe(200);

      const shown = await ctx.app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}`,
        headers: ctx.auth,
      });
      expect(shown.json().task.sessionId).toBe('abc-123');

      // Whoever claims it next gets the credential without any extra plumbing.
      const claimed = await claimTask(ctx, 'resume-env');
      expect(claimed?.sessionId).toBe('abc-123');
      expect(claimed?.status).toBe('CLAIMED');
    } finally {
      await ctx.close();
    }
  });

  it('leaves a stored session id alone when a batch has none', async () => {
    const ctx = await createTestContext();
    try {
      const task = await createTask(ctx, 'keep-env');
      await claimTask(ctx, 'keep-env');
      await report(ctx, task.id, [SESSION_EVENT]);
      expect((await report(ctx, task.id, [TOOL_EVENT])).statusCode).toBe(201);

      const shown = await ctx.app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}`,
        headers: ctx.auth,
      });
      expect(shown.json().task.sessionId).toBe('abc-123');
    } finally {
      await ctx.close();
    }
  });

  it('refuses an unclaimed task, an unknown task and another env', async () => {
    const ctx = await createTestContext();
    try {
      const task = await createTask(ctx, 'guard-env');
      const early = await report(ctx, task.id, [TOOL_EVENT]);
      expect(early.statusCode).toBe(409);
      expect(early.json().error.code).toBe('INVALID_TASK_STATUS');

      const missing = await report(ctx, '9999', [TOOL_EVENT]);
      expect(missing.statusCode).toBe(404);

      await claimTask(ctx, 'guard-env');
      expect((await report(ctx, task.id, [TOOL_EVENT])).statusCode).toBe(201);
      await ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/complete`,
        headers: ctx.auth,
        payload: { status: 'DONE', result: 'ok' },
      });
      expect((await report(ctx, task.id, [TOOL_EVENT])).statusCode).toBe(409);

      const foreign = await createTask(ctx, 'other-events-env');
      await claimTask(ctx, 'other-events-env');
      expect((await report(ctx, foreign.id, [TOOL_EVENT])).statusCode).toBe(201);

      const tokenResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/agents/guard-env/token',
        headers: ctx.auth,
      });
      const agentAuth = { authorization: `Bearer ${tokenResponse.json().token}` };
      expect((await readEvents(ctx, foreign.id, '', agentAuth)).statusCode).toBe(403);
    } finally {
      await ctx.close();
    }
  });

  it('rejects a malformed batch and an unsafe session id', async () => {
    const ctx = await createTestContext();
    try {
      const task = await createTask(ctx, 'reject-env');
      await claimTask(ctx, 'reject-env');

      expect((await report(ctx, task.id, [])).statusCode).toBe(400);
      expect(
        (await report(ctx, task.id, Array.from({ length: 51 }, () => TOOL_EVENT))).statusCode,
      ).toBe(400);
      // A tool call without a tool name is not an event the hub can file.
      expect((await report(ctx, task.id, [{ kind: 'tool_call' }])).statusCode).toBe(400);
      expect(
        (await report(ctx, task.id, [{ kind: 'session', sessionId: '--rfc / tmp' }])).statusCode,
      ).toBe(400);

      const shown = await ctx.app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}`,
        headers: ctx.auth,
      });
      expect(shown.json().task.sessionId).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it('re-derives the workspace verdict instead of trusting the node', async () => {
    const ctx = await createTestContext();
    try {
      const task = await createTask(ctx, 'action-env');
      await claimTask(ctx, 'action-env');
      const stored = await report(ctx, task.id, [
        {
          kind: 'permission_required',
          tool: 'Write',
          action: {
            kind: 'file_change',
            paths: ['/Users/me/other/x.ts'],
            workspaceRoot: '/Users/me/repo',
            outsideWorkspace: false,
          },
        },
      ]);
      expect(stored.statusCode).toBe(201);

      const page = (await readEvents(ctx, task.id)).json() as { events: TaskEvent[] };
      expect(page.events[0]?.action).toMatchObject({
        kind: 'file_change',
        paths: ['/Users/me/other/x.ts'],
        outsideWorkspace: true,
      });
    } finally {
      await ctx.close();
    }
  });

  it('keeps only the most recent events for a task', async () => {
    const ctx = await createTestContext();
    try {
      const task = await createTask(ctx, 'cap-env');
      await claimTask(ctx, 'cap-env');

      for (let index = 0; index < 12; index += 1) {
        const events = Array.from({ length: 50 }, (_, n) => ({
          kind: 'tool_call' as const,
          tool: `T${index}-${n}`,
        }));
        expect((await report(ctx, task.id, events)).statusCode).toBe(201);
      }

      const page = (await readEvents(ctx, task.id, '?limit=500')).json() as {
        events: TaskEvent[];
      };
      expect(page.events).toHaveLength(500);
      expect(page.events.at(-1)?.tool).toBe('T11-49');
      // The oldest 100 are gone, so the newest round trip is intact.
      expect(page.events[0]?.tool).toBe('T2-0');
    } finally {
      await ctx.close();
    }
  });

  it('adds the table to a database that predates it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhunzou-events-legacy-'));
    const path = join(dir, 'hub.db');

    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE agent_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        env TEXT NOT NULL,
        project_name TEXT,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        claimed_at INTEGER,
        completed_at INTEGER,
        result TEXT,
        lease_at INTEGER
      );
    `);
    legacy
      .prepare(
        `INSERT INTO agent_tasks (env, title, instruction, status, attempts, created_at, updated_at, claimed_at)
         VALUES ('old-env', '升级前的任务', '继续', 'CLAIMED', 1, 1, 2, 2)`,
      )
      .run();
    legacy.close();

    const upgraded = createDatabase(path);
    try {
      const tables = upgraded.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).toContain('task_events');

      const repo = new TicketRepository(upgraded.db);
      expect(repo.reportTaskEvents(1, [SESSION_EVENT], 2)).toBe(1);
      const listed = repo.listTaskEvents(1, { after: 0, limit: 10 });
      expect(listed.events[0]).toMatchObject({
        taskId: '1',
        kind: 'session',
        sessionId: 'abc-123',
      });
      expect(repo.getTask(1)?.sessionId).toBe('abc-123');
    } finally {
      upgraded.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
