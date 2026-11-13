import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/client.js';
import { TicketRepository } from '../src/repository.js';

/**
 * The inbox is a projection, not a copy: every card is one task row plus the
 * last line the supervisor wrote about it, read out of `task_logs` where 3.3
 * put it. These tests pin the join, the ordering and the "no second voice" rule.
 */
describe('supervisor inbox read-model', () => {
  let dir = '';
  let handle: ReturnType<typeof createDatabase>;
  let repo: TicketRepository;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhunzou-inbox-'));
    handle = createDatabase(join(dir, 'hub.db'));
    repo = new TicketRepository(handle.db);
  });

  afterAll(() => {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const clock = (offset: number): number => 1_700_000_000_000 + offset;

  /** Run a task to FAILED and let the breaker park it, as 3.3 does. */
  function blockedTask(
    env: string,
    notes: string[],
    overrides: { at?: number; workspacePath?: string } = {},
  ) {
    const created = repo.createTask(
      { env, title: `任务 ${env}`, instruction: '照原样跑。' },
      overrides.at ?? clock(0),
    );
    const id = Number(created.id);
    repo.claimNextTask(env, clock(1_000));
    repo.completeTask(
      id,
      {
        status: 'FAILED',
        result: '编译不过',
        ...(overrides.workspacePath ? { workspacePath: overrides.workspacePath } : {}),
      },
      clock(2_000),
    );
    for (const [index, note] of notes.entries()) {
      repo.appendTaskLog(
        id,
        { stream: 'system', chunk: `总管：${note}`, diagnosis: note },
        clock(3_000 + index),
      );
    }
    repo.blockTask(id, clock(9_000));
    return created;
  }

  function doneTask(env: string, at: number, overrides: { workspacePath?: string } = {}) {
    const created = repo.createTask(
      { env, title: `完成 ${env}`, instruction: '照原样跑。' },
      at,
    );
    const id = Number(created.id);
    repo.claimNextTask(env, at + 1_000);
    return repo.completeTask(
      id,
      {
        status: 'DONE',
        result: '改完并跑过测试',
        ...(overrides.workspacePath ? { workspacePath: overrides.workspacePath } : {}),
      },
      at + 2_000,
    );
  }

  it('R1: takes the last diagnosis written, with the time it was written', () => {
    const task = blockedTask('inbox-r1', ['第一次的说法', '最后一次的判决'], {
      at: clock(10_000),
    });
    const item = repo
      .listSupervisorInbox({ limit: 20 })
      .find((entry) => entry.task.id === task.id);

    expect(item?.diagnosis).toBe('最后一次的判决');
    expect(item?.diagnosisAt).toBe(clock(3_001));
  });

  it('R2: blocked cards lead, each status newest first', () => {
    const older = blockedTask('inbox-r2a', ['旧卡住'], { at: clock(20_000) });
    const finished = doneTask('inbox-r2b', clock(30_000));
    const fresher = blockedTask('inbox-r2c', ['新卡住'], { at: clock(100_000) });

    const ids = repo.listSupervisorInbox({ limit: 20 }).map((item) => item.task.id);
    expect(ids.indexOf(fresher.id)).toBeLessThan(ids.indexOf(older.id));
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(finished.id));
  });

  it('R3: a pile of finished work cannot push a stuck task off the page', () => {
    const stuck = blockedTask('inbox-r3-stuck', ['被挤不掉'], { at: clock(200_000) });
    for (let index = 0; index < 40; index += 1) {
      doneTask(`inbox-r3-done-${index}`, clock(300_000 + index * 10));
    }

    const items = repo.listSupervisorInbox({ limit: 20 });
    expect(items).toHaveLength(20);
    expect(items.some((item) => item.task.id === stuck.id)).toBe(true);
    expect(items[0]?.task.status).toBe('BLOCKED');
  });

  it('R4: running and failed work is not an inbox item', () => {
    const env = 'inbox-r4';
    const queued = repo.createTask(
      { env: 'inbox-r4-queue', title: '排队中', instruction: '一。' },
      clock(400_000),
    );
    const running = repo.createTask({ env, title: '在跑', instruction: '二。' }, clock(400_001));
    expect(repo.claimNextTask(env, clock(401_000))?.id).toBe(running.id);
    const failed = repo.createTask({ env, title: '已失败', instruction: '三。' }, clock(400_002));
    expect(repo.claimNextTask(env, clock(401_100))?.id).toBe(failed.id);
    repo.completeTask(Number(failed.id), { status: 'FAILED', result: '不过' }, clock(402_000));

    const ids = repo.listSupervisorInbox({ limit: 50 }).map((item) => item.task.id);
    expect(ids).not.toContain(running.id);
    expect(ids).not.toContain(failed.id);
    expect(ids).not.toContain(queued.id);
  });

  it('R5: a finished task carries no diagnosis keys at all', () => {
    const task = doneTask('inbox-r5', clock(500_000));
    const item = repo
      .listSupervisorInbox({ limit: 20 })
      .find((entry) => entry.task.id === task.id);

    expect(Object.keys(item ?? {})).toEqual(['task']);
    expect(item?.task.result).toBe('改完并跑过测试');
  });

  it('R6: only isolated work gets a branch, named from the shared convention', () => {
    const isolated = blockedTask('inbox-r6a', ['同一个错'], {
      at: clock(600_000),
      workspacePath: '/repo/.zhunzou/wt/9',
    });
    const plain = blockedTask('inbox-r6b', ['另一个错'], { at: clock(610_000) });

    const items = repo.listSupervisorInbox({ limit: 20 });
    const isolatedItem = items.find((item) => item.task.id === isolated.id);
    const plainItem = items.find((item) => item.task.id === plain.id);

    expect(isolatedItem?.branch).toBe(`wip/zz-${isolated.id}`);
    expect(plainItem).not.toHaveProperty('branch');
  });

  it('R7: the fault name comes from the latest signed line, not the first', () => {
    const task = blockedTask('inbox-r7', ['熔断'], { at: clock(700_000) });
    const id = Number(task.id);
    repo.appendTaskLog(
      id,
      { stream: 'stderr', chunk: '旧错误', errorSignature: 'TS2304 src/old.ts' },
      clock(701_000),
    );
    repo.appendTaskLog(
      id,
      { stream: 'stderr', chunk: '新错误', errorSignature: 'TS2322 src/new.ts' },
      clock(702_000),
    );

    const item = repo
      .listSupervisorInbox({ limit: 20 })
      .find((entry) => entry.task.id === task.id);
    expect(item?.errorSignature).toBe('TS2322 src/new.ts');
    // The diagnosis join is unaffected by which row carried the signature.
    expect(item?.diagnosis).toBe('熔断');
  });

  it('R8: a database without the diagnostic columns upgrades into a readable inbox', () => {
    const path = join(dir, 'legacy.db');
    const first = createDatabase(path);
    const legacy = new TicketRepository(first.db);
    const task = blockedTaskVia(legacy, 'inbox-r8', ['熔断于旧库']);
    first.sqlite
      .prepare('ALTER TABLE task_logs DROP COLUMN diagnosis')
      .run();
    first.sqlite
      .prepare('ALTER TABLE task_logs DROP COLUMN error_signature')
      .run();
    expect(
      (
        first.sqlite.prepare('PRAGMA table_info(task_logs)').all() as Array<{ name: string }>
      ).map((column) => column.name),
    ).not.toContain('diagnosis');
    first.sqlite.close();

    const second = createDatabase(path);
    const columns = second.sqlite
      .prepare('PRAGMA table_info(task_logs)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('diagnosis');

    const upgraded = new TicketRepository(second.db);
    const items = upgraded.listSupervisorInbox({ limit: 20 });
    expect(items).toHaveLength(1);
    expect(items[0]?.task.id).toBe(task.id);
    // The rows written before the upgrade are gone with the column; the card
    // still renders, it just has nothing to quote.
    expect(items[0]).not.toHaveProperty('diagnosis');

    second.sqlite.close();
  });
});

function blockedTaskVia(repo: TicketRepository, env: string, notes: string[]) {
  const created = repo.createTask(
    { env, title: `任务 ${env}`, instruction: '照原样跑。' },
    1_700_000_900_000,
  );
  const id = Number(created.id);
  repo.claimNextTask(env, 1_700_000_901_000);
  repo.completeTask(id, { status: 'FAILED', result: '编译不过' }, 1_700_000_902_000);
  for (const [index, note] of notes.entries()) {
    repo.appendTaskLog(
      id,
      { stream: 'system', chunk: `总管：${note}`, diagnosis: note },
      1_700_000_903_000 + index,
    );
  }
  repo.blockTask(id, 1_700_000_909_000);
  return created;
}
