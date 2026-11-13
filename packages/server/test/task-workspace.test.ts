import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AgentTask } from '@zhunzou/shared';

import { createDatabase } from '../src/db/client.js';
import { TicketRepository } from '../src/repository.js';
import { createTestContext, type TestContext } from './helpers.js';

/**
 * Where a task ran is a fact only the edge knows: the hub stores the absolute
 * path it is told, so the console can point at a worktree without pretending
 * to be able to resolve it.
 */
describe('task workspace path', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function claim(env: string): Promise<AgentTask> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: ctx.auth,
      payload: { env, title: '修复分页', instruction: '按现有 hook 风格。' },
    });
    expect(created.statusCode).toBe(201);

    const claimed = await ctx.app.inject({
      method: 'GET',
      url: `/api/tasks/next?env=${env}&timeout=100`,
      headers: ctx.auth,
    });
    return claimed.json().task as AgentTask;
  }

  it('stores the reported workspace and reads it back', async () => {
    const task = await claim('ws-env');
    const workspacePath = '/Users/dev/pte-dojo/.zhunzou/wt/12';

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/complete`,
      headers: ctx.auth,
      payload: { status: 'DONE', result: '已合并', workspacePath },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().task.workspacePath).toBe(workspacePath);

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}`,
      headers: ctx.auth,
    });
    expect(read.json().task).toMatchObject({ id: task.id, workspacePath });
  });

  it('leaves the column null when the edge says nothing about it', async () => {
    const task = await claim('ws-plain-env');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/complete`,
      headers: ctx.auth,
      payload: { status: 'DONE' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().task).not.toHaveProperty('workspacePath');
  });

  it('refuses a path that is not absolute', async () => {
    const task = await claim('ws-relative-env');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/complete`,
      headers: ctx.auth,
      payload: { status: 'DONE', workspacePath: '.zhunzou/wt/12' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBeDefined();
  });
});

describe('task workspace on a pre-2.1 database', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds the column and keeps completing tasks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhunzou-ws-legacy-'));
    dirs.push(dir);
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
         VALUES ('mac-mini-1', '旧任务', '继续', 'CLAIMED', 1, 1, 2, 2)`,
      )
      .run();
    legacy.close();

    const upgraded = createDatabase(path);
    const columns = upgraded.sqlite
      .prepare('PRAGMA table_info(agent_tasks)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('workspace_path');

    const repo = new TicketRepository(upgraded.db);
    const task = repo.completeTask(1, {
      status: 'DONE',
      workspacePath: '/Volumes/work/pte-dojo/.zhunzou/wt/1',
    });
    expect(task).toMatchObject({
      id: '1',
      title: '旧任务',
      status: 'DONE',
      workspacePath: '/Volumes/work/pte-dojo/.zhunzou/wt/1',
    });

    expect(repo.getTask(1)?.workspacePath).toBe(
      '/Volumes/work/pte-dojo/.zhunzou/wt/1',
    );
    expect(repo.getTask(1)?.title).toBe('旧任务');
    upgraded.sqlite.close();
  });
});
