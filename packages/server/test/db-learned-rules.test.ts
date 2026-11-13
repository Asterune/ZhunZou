import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/client.js';
import { TicketRepository } from '../src/repository.js';

/**
 * `learned_rules` is the allowance a human granted once and the hub may reuse
 * without spending a token or waking anybody up.
 */
describe('learned rules', () => {
  let dir = '';
  let handle: ReturnType<typeof createDatabase>;
  let repo: TicketRepository;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhunzou-learned-'));
    handle = createDatabase(join(dir, 'hub.db'));
    repo = new TicketRepository(handle.db);
  });

  afterAll(() => {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('remembers an allowance granted by a human', () => {
    const rule = repo.addLearnedRule(
      {
        pattern: 'git status *',
        patternType: 'glob',
        action: 'ALLOW',
        kind: 'git_operation',
        source: 'HUMAN_APPROVAL',
        note: '只读状态查询',
      },
      1_700_000_000_000,
    );

    expect(rule.id).toMatch(/^[A-Za-z0-9_-]{6,}$/);
    expect(rule).toMatchObject({
      pattern: 'git status *',
      patternType: 'glob',
      action: 'ALLOW',
      kind: 'git_operation',
      source: 'HUMAN_APPROVAL',
      enabled: true,
      hits: 0,
      createdAt: 1_700_000_000_000,
    });
  });

  it('folds a repeated approval into one rule instead of stacking copies', () => {
    repo.addLearnedRule(
      { pattern: 'pnpm test', patternType: 'exact', action: 'ALLOW', source: 'HUMAN_APPROVAL' },
      1_700_000_001_000,
    );
    const second = repo.addLearnedRule(
      { pattern: 'pnpm test', patternType: 'exact', action: 'ALLOW', source: 'RULE_DISTILLER' },
      1_700_000_002_000,
    );

    const matches = repo
      .listLearnedRules()
      .filter((rule) => rule.pattern === 'pnpm test');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ id: second.id, source: 'RULE_DISTILLER' });
  });

  it('counts the times a rule answered', () => {
    const rule = repo.addLearnedRule(
      { pattern: 'ls *', patternType: 'glob', action: 'ALLOW', source: 'SEED' },
      1_700_000_003_000,
    );

    expect(repo.recordLearnedRuleHit(rule.id, 1_700_000_004_000)?.hits).toBe(1);
    expect(repo.recordLearnedRuleHit(rule.id, 1_700_000_005_000)?.hits).toBe(2);
    expect(repo.recordLearnedRuleHit('lr-does-not-exist')).toBeNull();
  });

  it('keeps a refusal distinguishable from an allowance', () => {
    repo.addLearnedRule(
      { pattern: 'rm -rf *', patternType: 'glob', action: 'DENY', source: 'SEED' },
      1_700_000_006_000,
    );

    const denied = repo.listLearnedRules({ action: 'DENY' });
    expect(denied.map((rule) => rule.pattern)).toContain('rm -rf *');
    expect(repo.listLearnedRules({ action: 'ALLOW' }).map((rule) => rule.pattern)).not.toContain(
      'rm -rf *',
    );
  });

  it('disables a rule without losing the audit trail', () => {
    const rule = repo.addLearnedRule(
      { pattern: 'npm publish', patternType: 'exact', action: 'ALLOW', source: 'HUMAN_APPROVAL' },
      1_700_000_007_000,
    );
    repo.setEnabledLearnedRule(rule.id, false, 1_700_000_008_000);

    expect(repo.listLearnedRules({ enabledOnly: true })).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: rule.id })]),
    );
    expect(repo.listLearnedRules()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: rule.id, enabled: false })]),
    );
  });

  it('rejects a rule the shared contract refuses', () => {
    expect(() =>
      repo.addLearnedRule(
        { pattern: 'rm -rf (', patternType: 'regex', action: 'ALLOW', source: 'SEED' },
        1_700_000_009_000,
      ),
    ).toThrow(/regex/);
  });

  it('creates the table on a hub that predates the supervisor', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'zhunzou-learned-legacy-'));
    const path = join(legacyDir, 'hub.db');

    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        env TEXT NOT NULL,
        project_name TEXT NOT NULL,
        status TEXT NOT NULL,
        done_summary TEXT NOT NULL,
        blocker_question TEXT NOT NULL,
        next_step_plan TEXT NOT NULL,
        options TEXT NOT NULL,
        recommended_option TEXT NOT NULL,
        selected_option TEXT,
        custom_instruction TEXT,
        resolved_by TEXT,
        resolution_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy.close();

    const upgraded = createDatabase(path);
    const tables = upgraded.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toContain('learned_rules');

    const upgradedRepo = new TicketRepository(upgraded.db);
    expect(upgradedRepo.listLearnedRules()).toEqual([]);

    upgraded.sqlite.close();
    rmSync(legacyDir, { recursive: true, force: true });
  });
});
