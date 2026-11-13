import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/client.js';
import { TicketRepository } from '../src/repository.js';

/**
 * A log row is not only text: the supervisor stores the normalised error
 * signature, its own diagnosis and the diff hash it judged, because those are
 * what the circuit breaker compares between retries.
 */
describe('task log diagnostics', () => {
  let dir = '';
  let handle: ReturnType<typeof createDatabase>;
  let repo: TicketRepository;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhunzou-logdiag-'));
    handle = createDatabase(join(dir, 'hub.db'));
    repo = new TicketRepository(handle.db);
  });

  afterAll(() => {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the signature, diagnosis and diff hash beside the chunk', () => {
    const task = repo.createTask(
      {
        env: 'mac-mini-1',
        title: '接入分页查询',
        instruction: '按现有 hook 风格实现。',
        repoName: 'pte-dojo',
        engine: 'opencode',
      },
      1_700_000_000_000,
    );

    const log = repo.appendTaskLog(
      Number(task.id),
      {
        stream: 'stderr',
        chunk: 'src/pages/list.ts(24,7): error TS2322: Type "string" is not assignable to type "number".',
        errorSignature: 'TS2322 src/pages/list.ts',
        diagnosis: '分页页码是数字，这里传了字符串',
        diffHash: 'b1a9c4d',
      },
      1_700_000_001_000,
    );

    expect(log).toMatchObject({
      taskId: task.id,
      stream: 'stderr',
      errorSignature: 'TS2322 src/pages/list.ts',
      diagnosis: '分页页码是数字，这里传了字符串',
      diffHash: 'b1a9c4d',
      createdAt: 1_700_000_001_000,
    });

    const listed = repo.listTaskLogs(Number(task.id), { after: 0, limit: 50 });
    expect(listed.logs[0]).toMatchObject({ errorSignature: 'TS2322 src/pages/list.ts' });
  });

  it('leaves the diagnostic fields absent for a plain progress line', () => {
    const task = repo.createTask(
      { env: 'mac-mini-1', title: '整理 CHANGELOG', instruction: '按提交汇总。' },
      1_700_000_002_000,
    );

    const log = repo.appendTaskLog(
      Number(task.id),
      { stream: 'stdout', chunk: 'pnpm test: 603 passed' },
      1_700_000_003_000,
    );
    expect(log.errorSignature).toBeUndefined();
    expect(log.diagnosis).toBeUndefined();
    expect(log.diffHash).toBeUndefined();
  });

  it('upgrades a log table that predates the diagnostics', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'zhunzou-logdiag-legacy-'));
    const path = join(legacyDir, 'hub.db');

    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE task_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        stream TEXT NOT NULL,
        chunk TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO task_logs (task_id, stream, chunk, created_at)
         VALUES (1, 'stderr', '旧版本只存文本', 1)`,
      )
      .run();
    legacy.close();

    const upgraded = createDatabase(path);
    const columns = upgraded.sqlite
      .prepare('PRAGMA table_info(task_logs)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['error_signature', 'diagnosis', 'diff_hash']),
    );

    const upgradedRepo = new TicketRepository(upgraded.db);
    const legacyLog = upgraded.sqlite
      .prepare('SELECT * FROM task_logs WHERE id = 1')
      .get() as { chunk: string };
    expect(legacyLog.chunk).toBe('旧版本只存文本');
    expect(upgradedRepo.listTaskLogs(1, { after: 0, limit: 10 }).logs[0]).toMatchObject({
      stream: 'stderr',
    });

    upgraded.sqlite.close();
    rmSync(legacyDir, { recursive: true, force: true });
  });
});
