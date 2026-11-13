import { describe, expect, it } from 'vitest';

import {
  NODE_HEARTBEAT_REPORT_MS,
  NODE_HEARTBEAT_TIMEOUT_MS,
  ROUTE_MIN_FREE_MEMORY_MB,
  SUPERVISOR_DECISIONS,
  learnedRuleSchema,
  permissionActionSchema,
  supervisorDecisionSchema,
  supervisorDiagnosisSchema,
} from '../src/index.js';

describe('permissionActionSchema', () => {
  it('describes a shell command the agent wants to run', () => {
    const parsed = permissionActionSchema.parse({
      kind: 'command',
      command: 'pnpm test',
      cwd: '/Users/qiliu/code/pte-dojo',
      workspaceRoot: '/Users/qiliu/code/pte-dojo',
    });
    expect(parsed.kind).toBe('command');
    expect(parsed.outsideWorkspace).toBe(false);
  });

  it('detects a path that escapes the workspace instead of trusting the client', () => {
    const parsed = permissionActionSchema.parse({
      kind: 'file_change',
      paths: ['/Users/qiliu/code/pte-dojo/src/App.vue', '~/.ssh/id_rsa'],
      workspaceRoot: '/Users/qiliu/code/pte-dojo',
    });
    expect(parsed.outsideWorkspace).toBe(true);
  });

  it('keeps an explicit outsideWorkspace claim when it is stricter', () => {
    const parsed = permissionActionSchema.parse({
      kind: 'delete',
      paths: ['/Users/qiliu/code/pte-dojo/tmp'],
      workspaceRoot: '/Users/qiliu/code/pte-dojo',
      outsideWorkspace: true,
    });
    expect(parsed.outsideWorkspace).toBe(true);
  });

  it('will not let a node talk itself out of an escaping path', () => {
    const parsed = permissionActionSchema.parse({
      kind: 'file_change',
      paths: ['/Users/qiliu/.ssh/id_rsa'],
      workspaceRoot: '/Users/qiliu/code/pte-dojo',
      outsideWorkspace: false,
    });
    expect(parsed.outsideWorkspace).toBe(true);
  });

  it('rejects an action with nothing to guard', () => {
    expect(permissionActionSchema.safeParse({ kind: 'command' }).success).toBe(false);
  });

  it('rejects unknown kinds and an unbounded path list', () => {
    expect(
      permissionActionSchema.safeParse({ kind: 'vibes', command: 'ls' }).success,
    ).toBe(false);
    const paths = Array.from({ length: 51 }, (_, i) => `/tmp/f${i}`);
    expect(permissionActionSchema.safeParse({ kind: 'delete', paths }).success).toBe(false);
  });
});

describe('supervisorDiagnosisSchema', () => {
  it('accepts the exact three-field JSON the L2 prompt asks for', () => {
    const parsed = supervisorDiagnosisSchema.parse({
      decision: 'RETRY_WITH_FIX',
      diagnosisSummary: 'TS2322：把 string 赋给了 number，缺少一次转换',
      fixPrompt: '修复 src/lib/format.ts 的类型不匹配并补一条单测',
    });
    expect(SUPERVISOR_DECISIONS).toContain(parsed.decision);
  });

  it('refuses fields the model invented', () => {
    const result = supervisorDiagnosisSchema.safeParse({
      decision: 'APPROVE',
      diagnosisSummary: '安全',
      confidence: 0.9,
    });
    expect(result.success).toBe(false);
  });

  it('requires a fix prompt before it can order a retry', () => {
    expect(
      supervisorDiagnosisSchema.safeParse({
        decision: 'RETRY_WITH_FIX',
        diagnosisSummary: '单测断言失败',
      }).success,
    ).toBe(false);
  });

  it('keeps the one-line diagnosis short', () => {
    expect(
      supervisorDiagnosisSchema.safeParse({
        decision: 'ESCALATE_TO_HUMAN',
        diagnosisSummary: '这'.repeat(60),
      }).success,
    ).toBe(false);
  });
});

describe('supervisorDecisionSchema', () => {
  it('records which layer answered and why', () => {
    const parsed = supervisorDecisionSchema.parse({
      decision: 'APPROVE',
      layer: 'L1',
      reason: '只读命令命中白名单',
      ruleId: '12',
    });
    expect(parsed.layer).toBe('L1');
    expect(parsed.ruleId).toBe('12');
  });

  it('refuses a deterministic L1 approval that carries a fix prompt', () => {
    expect(
      supervisorDecisionSchema.safeParse({
        decision: 'RETRY_WITH_FIX',
        layer: 'L1',
        reason: '不该发生',
        fixPrompt: '再试一次',
      }).success,
    ).toBe(false);
  });

  it('refuses a retry decision with no prompt to hand the engine', () => {
    expect(
      supervisorDecisionSchema.safeParse({
        decision: 'RETRY_WITH_FIX',
        layer: 'L2',
        reason: '编译失败',
      }).success,
    ).toBe(false);
  });
});

describe('learnedRuleSchema', () => {
  it('stores a human-approved allowance', () => {
    const parsed = learnedRuleSchema.parse({
      id: 'lr-1',
      pattern: 'git ${"*"}',
      patternType: 'glob',
      action: 'ALLOW',
      source: 'HUMAN_APPROVAL',
      createdAt: 1,
      updatedAt: 2,
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.hits).toBe(0);
  });

  it('rejects a regex that cannot compile', () => {
    expect(
      learnedRuleSchema.safeParse({
        id: 'lr-2',
        pattern: 'rm -rf (',
        patternType: 'regex',
        action: 'DENY',
        source: 'SEED',
        createdAt: 1,
        updatedAt: 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a rule with no pattern', () => {
    expect(
      learnedRuleSchema.safeParse({
        id: 'lr-3',
        pattern: '',
        patternType: 'exact',
        action: 'ALLOW',
        source: 'SEED',
        createdAt: 1,
        updatedAt: 1,
      }).success,
    ).toBe(false);
  });
});

describe('supervisor timing constants', () => {
  it('matches the blueprint heartbeat, timeout and memory floor', () => {
    expect(NODE_HEARTBEAT_REPORT_MS).toBe(15_000);
    expect(NODE_HEARTBEAT_TIMEOUT_MS).toBe(30_000);
    expect(ROUTE_MIN_FREE_MEMORY_MB).toBe(2048);
  });
});
