import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/client.js';
import { TicketRepository } from '../src/repository.js';

/**
 * Where the model plumbing lives in the row: the model a dispatch asked for,
 * the reason a CLI gave for refusing to think, and the model a node says it
 * runs by default. All three are optional, so a hub that upgrades under an old
 * bridge keeps working.
 */
describe('model plumbing', () => {
  let dir = '';
  let handle: ReturnType<typeof createDatabase>;
  let repo: TicketRepository;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhunzou-model-'));
    handle = createDatabase(join(dir, 'hub.db'));
    repo = new TicketRepository(handle.db);
  });

  afterAll(() => {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the requested model on the task a node claims', () => {
    const task = repo.createTask(
      {
        env: 'mac-mini-1',
        title: '修登录校验',
        instruction: '按现有 hook 风格实现。',
        model: 'opencode-go',
      },
      1_700_000_000_000,
    );
    expect(task.model).toBe('opencode-go');

    const claimed = repo.claimNextTask('mac-mini-1');
    expect(claimed).toMatchObject({ id: task.id, model: 'opencode-go' });
  });

  it('leaves the model off a task nobody named one for', () => {
    const task = repo.createTask(
      { env: 'mac-mini-2', title: '补文档', instruction: '写 README。' },
      1_700_000_000_000,
    );
    expect(task.model).toBeUndefined();
  });

  it('files the failure kind a node reports and clears it on the next report', () => {
    const task = repo.createTask(
      { env: 'mac-mini-3', title: '跑测试', instruction: 'pnpm test。' },
      1_700_000_000_000,
    );
    const id = Number(task.id);
    repo.claimNextTask('mac-mini-3');

    const failed = repo.completeTask(id, {
      status: 'FAILED',
      result: 'Free usage limit reached.',
      failureKind: 'quota_exhausted',
    });
    expect(failed.failureKind).toBe('quota_exhausted');

    // A retry that gets as far as the code must not inherit the old label.
    repo.retryTask(id, '换个模型再跑');
    repo.claimNextTask('mac-mini-3');
    const done = repo.completeTask(id, { status: 'DONE', result: '测试全绿' });
    expect(done.failureKind).toBeUndefined();
  });

  it('labels a chat turn the same way', () => {
    const session = repo.createChatSession(
      { env: 'mac-mini-4', projectName: 'pte-dojo' },
      1_700_000_000_000,
    );
    const message = repo.sendChatMessage(
      Number(session.id),
      { content: '把首页标题改一下' },
      1_700_000_000_001,
    );
    repo.claimNextChatMessage('mac-mini-4', 1_700_000_000_002);

    const response = repo.completeChatMessage(
      Number(session.id),
      Number(message.id),
      { status: 'FAILED', error: 'No credits remaining', failureKind: 'quota_exhausted' },
      1_700_000_000_003,
    );
    expect(response.message).toMatchObject({
      status: 'FAILED',
      failureKind: 'quota_exhausted',
    });
  });

  it('records the model a heartbeat says the node runs', () => {
    repo.recordAgentPresence(
      'mac-mini-5',
      { kind: 'opencode', model: 'claude-opus' },
      1_700_000_000_000,
    );
    expect(repo.getAgent('mac-mini-5')?.model).toBe('claude-opus');

    // Silence keeps the last report, exactly as `version` does: a bridge built
    // before this field exists cannot say the machine has no model, it can only
    // not say — and it would otherwise blank every card on the next beat.
    repo.recordAgentPresence('mac-mini-5', { kind: 'opencode' }, 1_700_000_000_001);
    expect(repo.getAgent('mac-mini-5')?.model).toBe('claude-opus');

    repo.recordAgentPresence(
      'mac-mini-5',
      { kind: 'opencode', model: 'gpt-5-mini' },
      1_700_000_000_002,
    );
    expect(repo.getAgent('mac-mini-5')?.model).toBe('gpt-5-mini');
  });

  it('adds the columns to a hub written before they existed', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'zhunzou-model-legacy-'));
    const legacyPath = join(legacyDir, 'hub.db');
    const first = createDatabase(legacyPath);
    const legacyRepo = new TicketRepository(first.db);
    const task = legacyRepo.createTask(
      { env: 'old-node', title: '老任务', instruction: '升级前建的。' },
      1_700_000_000_000,
    );
    first.sqlite.exec('ALTER TABLE agent_tasks DROP COLUMN model;');
    first.sqlite.exec('ALTER TABLE agent_tasks DROP COLUMN failure_kind;');
    first.sqlite.exec('ALTER TABLE chat_messages DROP COLUMN failure_kind;');
    first.sqlite.exec('ALTER TABLE agents DROP COLUMN model;');
    first.sqlite.close();

    const reopened = createDatabase(legacyPath);
    const reopenedRepo = new TicketRepository(reopened.db);
    expect(reopenedRepo.getTask(Number(task.id))).toMatchObject({
      id: task.id,
      title: '老任务',
    });
    expect(reopenedRepo.claimNextTask('old-node')).toMatchObject({ id: task.id });
    expect(
      reopenedRepo.completeTask(Number(task.id), {
        status: 'FAILED',
        result: '额度用尽',
        failureKind: 'quota_exhausted',
      }).failureKind,
    ).toBe('quota_exhausted');
    reopened.sqlite.close();
    rmSync(legacyDir, { recursive: true, force: true });
  });
});
