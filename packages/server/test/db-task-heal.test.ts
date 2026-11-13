import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/client.js';
import { TicketRepository } from '../src/repository.js';

/**
 * Step 3.3 gives the hub three new edges out of FAILED. The engine's verdict
 * stays in the row; what the supervisor decides about it is a status change
 * plus one log row, and the fix prompt lives only until the next claim reads it.
 */
describe('task healing transitions', () => {
  let dir = '';
  let handle: ReturnType<typeof createDatabase>;
  let repo: TicketRepository;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhunzou-heal-'));
    handle = createDatabase(join(dir, 'hub.db'));
    repo = new TicketRepository(handle.db);
  });

  afterAll(() => {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A task already reported FAILED by its engine, with the resume credential set. */
  function failedTask(env: string, title = '接入分页查询') {
    const task = repo.createTask(
      { env, title, instruction: '按现有 hook 风格实现。', engine: 'opencode' },
      1_700_000_000_000,
    );
    const id = Number(task.id);
    repo.claimNextTask(env, 1_700_000_001_000);
    handle.sqlite
      .prepare('UPDATE agent_tasks SET session_id = ? WHERE id = ?')
      .run('sess-abc', id);
    return repo.completeTask(
      id,
      { status: 'FAILED', result: '编译不过：TS2322' },
      1_700_000_002_000,
    );
  }

  it('R1: a retry reopens the task and carries one fix prompt', () => {
    const before = failedTask('heal-r1');
    const after = repo.retryTask(Number(before.id), '把页码改成 number 再跑一次', 1_700_000_003_000);

    expect(after).toMatchObject({
      status: 'HEALING',
      retryCount: 1,
      fixPrompt: '把页码改成 number 再跑一次',
      result: '编译不过：TS2322',
      sessionId: 'sess-abc',
    });
    expect(after?.completedAt).toBeUndefined();
    expect(after?.claimedAt).toBeUndefined();
    expect(after?.leaseAt).toBeUndefined();
  });

  it('R2: only a FAILED task can be retried', () => {
    const task = repo.createTask(
      { env: 'heal-r2', title: '还在跑', instruction: '等着。' },
      1_700_000_000_000,
    );
    const id = Number(task.id);
    repo.claimNextTask('heal-r2', 1_700_000_001_000);

    expect(repo.retryTask(id, '别急')).toBeNull();
    expect(repo.getTask(id)?.status).toBe('CLAIMED');

    repo.completeTask(id, { status: 'FAILED', result: '炸了' }, 1_700_000_002_000);
    expect(repo.retryTask(id, '冷静一下')?.status).toBe('HEALING');
    expect(repo.retryTask(id, '再来一次')).toBeNull();
  });

  it('R3: a healing task is claimable, and the claim hands over the prompt', () => {
    const failed = failedTask('heal-r3');
    repo.retryTask(Number(failed.id), '先看 uploads 权限', 1_700_000_003_000);

    const claimed = repo.claimNextTask('heal-r3', 1_700_000_004_000);
    expect(claimed).toMatchObject({
      status: 'CLAIMED',
      fixPrompt: '先看 uploads 权限',
      attempts: 2,
    });
  });

  it('R4: the prompt is spent on that one claim', () => {
    const failed = failedTask('heal-r4');
    const id = Number(failed.id);
    repo.retryTask(id, '先装依赖', 1_700_000_003_000);
    repo.claimNextTask('heal-r4', 1_700_000_004_000);

    expect(repo.getTask(id)?.fixPrompt).toBeUndefined();

    repo.completeTask(id, { status: 'FAILED', result: '还是不过' }, 1_700_000_005_000);
    repo.retryTask(id, '第二次的说法', 1_700_000_006_000);
    const second = repo.claimNextTask('heal-r4', 1_700_000_007_000);
    expect(second).toMatchObject({ fixPrompt: '第二次的说法' });
  });

  it('R5: claims by age, whether the candidate waits or heals', () => {
    const env = 'heal-r5';
    const first = repo.createTask(
      { env, title: '早到的', instruction: '一。' },
      1_700_000_000_000,
    );
    repo.createTask({ env, title: '晚到的', instruction: '二。' }, 1_700_000_001_000);

    // Nothing healed yet: the plain queue keeps its existing semantics.
    const plain = repo.claimNextTask(env, 1_700_000_002_000);
    expect(plain).toMatchObject({ title: '早到的', attempts: 1 });
    expect(plain?.fixPrompt).toBeUndefined();

    const id = Number(first.id);
    repo.completeTask(id, { status: 'FAILED', result: '不过' }, 1_700_000_003_000);
    repo.retryTask(id, '换个写法', 1_700_000_004_000);

    // The healed task is the oldest claimable one, so it goes first.
    const healed = repo.claimNextTask(env, 1_700_000_005_000);
    expect(healed).toMatchObject({ id: first.id, title: '早到的', attempts: 2 });
    expect(healed?.fixPrompt).toBe('换个写法');

    repo.completeTask(id, { status: 'DONE', result: '好了' }, 1_700_000_006_000);
    expect(repo.claimNextTask(env, 1_700_000_007_000)?.title).toBe('晚到的');
  });

  it('R6: blocking keeps the engine’s own words and spends no retry', () => {
    const before = failedTask('heal-r6');
    const blocked = repo.blockTask(Number(before.id), 1_700_000_003_000);

    expect(blocked).toMatchObject({
      status: 'BLOCKED',
      retryCount: 0,
      result: '编译不过：TS2322',
    });
    expect(blocked?.completedAt).toBe(1_700_000_002_000);
  });

  it('R7: a human reopening resets only the retry budget', () => {
    const failed = failedTask('heal-r7');
    const id = Number(failed.id);
    repo.retryTask(id, '第一次建议', 1_700_000_003_000);
    // The retry ran, failed again, and this time the breaker stopped it.
    repo.claimNextTask('heal-r7', 1_700_000_004_000);
    repo.completeTask(id, { status: 'FAILED', result: '还是不过' }, 1_700_000_005_000);
    repo.blockTask(id, 1_700_000_006_000);
    expect(repo.getTask(id)).toMatchObject({ status: 'BLOCKED', retryCount: 1 });

    expect(repo.reopenTask(id, 1_700_000_007_000)).toMatchObject({
      status: 'PENDING',
      retryCount: 0,
    });
    const reopened = repo.getTask(id);
    expect(reopened?.fixPrompt).toBeUndefined();
    expect(reopened?.completedAt).toBeUndefined();
    expect(reopened?.result).toBe('还是不过');
    // Blocked tasks are not claimable, reopened ones are.
    expect(repo.claimNextTask('heal-r7')?.id).toBe(reopened?.id);
  });

  it('R8: only a BLOCKED task can be reopened', () => {
    const failed = failedTask('heal-r8');
    const id = Number(failed.id);
    expect(repo.reopenTask(id)).toBeNull();
    repo.blockTask(id, 1_700_000_003_000);
    expect(repo.reopenTask(id)?.status).toBe('PENDING');
    expect(repo.reopenTask(id)).toBeNull();
  });

  it('R10: healing work still occupies the node, blocked work does not', () => {
    const env = 'heal-r10';
    const started = repo.createTask(
      { env, title: '在跑', instruction: '一。' },
      1_700_000_000_000,
    );
    const healing = repo.createTask(
      { env, title: '自愈中', instruction: '二。' },
      1_700_000_000_000,
    );
    const parked = repo.createTask(
      { env, title: '已熔断', instruction: '三。' },
      1_700_000_000_000,
    );

    // Three claims in age order: the first one keeps running.
    expect(repo.claimNextTask(env, 1_700_000_001_000)?.id).toBe(started.id);
    expect(repo.claimNextTask(env, 1_700_000_001_010)?.id).toBe(healing.id);
    expect(repo.claimNextTask(env, 1_700_000_001_020)?.id).toBe(parked.id);
    for (const task of [healing, parked]) {
      repo.completeTask(
        Number(task.id),
        { status: 'FAILED', result: '不过' },
        1_700_000_001_030,
      );
    }
    repo.retryTask(Number(healing.id), '再看一次', 1_700_000_002_000);
    repo.blockTask(Number(parked.id), 1_700_000_002_010);

    // CLAIMED + HEALING: the hub still holds that node's session.
    expect(repo.activeTaskCountsByEnv()[env]).toBe(2);

    repo.reopenTask(Number(parked.id), 1_700_000_003_000);
    expect(repo.activeTaskCountsByEnv()[env]).toBe(3);
  });
});

describe('upgrading a database that predates the fix prompt', () => {
  it('R9: adds the column and leaves old rows without one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhunzou-heal-migrate-'));
    const path = join(dir, 'hub.db');
    const now = 1_700_000_000_000;

    const first = createDatabase(path);
    const older = new TicketRepository(first.db);
    const task = older.createTask(
      { env: 'office-cursor', title: '旧任务', instruction: '升级前创建。' },
      now,
    );
    older.claimNextTask('office-cursor', now + 1);
    older.completeTask(Number(task.id), { status: 'FAILED', result: '旧结论' }, now + 2);
    first.sqlite
      .prepare('ALTER TABLE agent_tasks DROP COLUMN fix_prompt')
      .run();
    expect(
      (first.sqlite.prepare('PRAGMA table_info(agent_tasks)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    ).not.toContain('fix_prompt');
    first.sqlite.close();

    const second = createDatabase(path);
    const columns = second.sqlite
      .prepare('PRAGMA table_info(agent_tasks)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('fix_prompt');

    const upgraded = new TicketRepository(second.db);
    const row = upgraded.getTask(Number(task.id));
    expect(row).toMatchObject({ status: 'FAILED', result: '旧结论', retryCount: 0 });
    expect(row?.fixPrompt).toBeUndefined();
    expect(upgraded.listTasks({ limit: 10 }).tasks).toHaveLength(1);

    second.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
