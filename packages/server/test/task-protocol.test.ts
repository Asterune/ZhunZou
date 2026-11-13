import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { AgentTask } from '@zhunzou/shared';

import { createDatabase } from '../src/db/client.js';
import { TicketRepository } from '../src/repository.js';
import { createTestContext } from './helpers.js';

/**
 * The blueprint names a task QUEUED/RUNNING/BLOCKED/HEALING and carries the
 * routing + resume fields the supervisor needs; these tests pin that contract
 * down through the HTTP shape and the storage layer, including the upgrade
 * path for a hub that recorded tasks before those columns existed.
 */
const LEGACY_AGENT_TASKS = `
CREATE TABLE agent_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  env TEXT NOT NULL,
  project_name TEXT,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claimed_at INTEGER,
  completed_at INTEGER,
  result TEXT
);
`;

describe('TaskRecord contract', () => {
  it('persists the routing, origin and supervisor fields on dispatch', async () => {
    const ctx = await createTestContext();
    try {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: ctx.auth,
        payload: {
          env: 'mac-mini-1',
          title: '接入分页查询',
          instruction: '按现有 hook 风格实现，并补一条单测。',
          repoName: 'pte-dojo',
          engine: 'opencode',
          managedBySupervisor: true,
        },
      });
      expect(response.statusCode).toBe(201);

      const task = response.json().task as AgentTask;
      expect(task).toMatchObject({
        status: 'PENDING',
        repoName: 'pte-dojo',
        engine: 'opencode',
        origin: 'HUB_DISPATCH',
        managedBySupervisor: true,
        retryCount: 0,
      });

      const listed = await ctx.app.inject({
        method: 'GET',
        url: '/api/tasks',
        headers: ctx.auth,
        query: { env: 'mac-mini-1' },
      });
      expect(listed.json().tasks[0]).toMatchObject({ id: task.id, repoName: 'pte-dojo' });
    } finally {
      await ctx.close();
    }
  });

  it('accepts a locally wrapped registration that carries its engine session', async () => {
    const ctx = await createTestContext();
    try {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: ctx.auth,
        payload: {
          env: 'office-cursor',
          title: '重构导出模块',
          instruction: '拆出适配器并跑通测试。',
          repoName: 'yikuaomed-erp',
          engine: 'cursor',
          origin: 'LOCAL_WRAP',
        },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().task).toMatchObject({ origin: 'LOCAL_WRAP', engine: 'cursor' });
    } finally {
      await ctx.close();
    }
  });

  it('upgrades a task table that predates the supervisor columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhunzou-task-protocol-'));
    const path = join(dir, 'hub.db');
    const now = Date.now();

    const legacy = new Database(path);
    legacy.exec(LEGACY_AGENT_TASKS);
    legacy
      .prepare(
        `INSERT INTO agent_tasks (env, project_name, title, instruction, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('office-cursor', 'yikuaomed-erp', '历史任务', '旧版本创建', 'PENDING', now, now);
    legacy.close();

    const { db, sqlite } = createDatabase(path);
    const columns = sqlite
      .prepare('PRAGMA table_info(agent_tasks)')
      .all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'repo_name',
        'engine',
        'origin',
        'session_id',
        'managed_by_supervisor',
        'retry_count',
      ]),
    );

    const repo = new TicketRepository(db);
    const task = repo.listTasks({ limit: 10 }).tasks.find((item) => item.title === '历史任务');
    expect(task).toMatchObject({
      origin: 'HUB_DISPATCH',
      managedBySupervisor: false,
      retryCount: 0,
    });
    expect(task?.repoName).toBeUndefined();

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
