import { describe, expect, it } from 'vitest';

import {
  listSupervisorInboxQuerySchema,
  supervisorInboxItemSchema,
  supervisorInboxResponseSchema,
  wipBranchName,
} from '../src/index.js';
import type { AgentTask } from '../src/index.js';

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: '41',
    env: 'desk-one',
    title: 'rename the flag',
    instruction: 'rename --dry to --dry-run',
    status: 'BLOCKED',
    attempts: 1,
    origin: 'HUB_DISPATCH',
    retryCount: 3,
    managedBySupervisor: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    ...overrides,
  };
}

describe('wipBranchName', () => {
  it('produces the string the node has always used', () => {
    expect(wipBranchName(41)).toBe('wip/zz-41');
    expect(wipBranchName('41')).toBe('wip/zz-41');
  });

  it('does not validate: the node owns the charset check', () => {
    // The hub renders a branch name it was given; rejecting odd ids here would
    // turn a display concern into a second, divergent rule.
    expect(wipBranchName('a/b')).toBe('wip/zz-a/b');
    expect(wipBranchName(''.padStart(200, 'x'))).toBe(`wip/zz-${''.padStart(200, 'x')}`);
  });
});

describe('supervisorInboxItemSchema', () => {
  it('accepts a bare task and injects no undefined keys', () => {
    const parsed = supervisorInboxItemSchema.parse({ task: task() });
    expect(Object.keys(parsed)).toEqual(['task']);
    expect(parsed.task.id).toBe('41');
  });

  it('carries the supervisor facts beside the task, not inside it', () => {
    const parsed = supervisorInboxItemSchema.parse({
      task: task({ workspacePath: '/repo/.zhunzou/wt/41' }),
      diagnosis: '连续两次失败是同一个错（相似度 0.93）：TS2322 src/a.ts',
      diagnosisAt: 1_700_000_000_400,
      errorSignature: 'TS2322 src/a.ts',
      branch: 'wip/zz-41',
    });
    expect(parsed.diagnosis).toContain('TS2322');
    expect(parsed.branch).toBe('wip/zz-41');
    expect(parsed.task.workspacePath).toBe('/repo/.zhunzou/wt/41');
  });

  it('strips unknown keys instead of passing the row through', () => {
    const parsed = supervisorInboxItemSchema.parse({
      task: { ...task(), leaked: 'x' },
    });
    expect(parsed.task).not.toHaveProperty('leaked');
  });

  it('rejects an over-long diagnosis line', () => {
    expect(() =>
      supervisorInboxItemSchema.parse({
        task: task(),
        diagnosis: 'x'.repeat(501),
      }),
    ).toThrow();
  });
});

describe('supervisorInboxResponseSchema / query', () => {
  it('answers with items only', () => {
    const parsed = supervisorInboxResponseSchema.parse({
      items: [{ task: task() }, { task: task({ id: '42', status: 'DONE' }) }],
    });
    expect(parsed.items).toHaveLength(2);
  });

  it('defaults the limit and refuses the silly ones', () => {
    expect(listSupervisorInboxQuerySchema.parse({}).limit).toBe(20);
    expect(() => listSupervisorInboxQuerySchema.parse({ limit: 'abc' })).toThrow();
    expect(() => listSupervisorInboxQuerySchema.parse({ limit: 0 })).toThrow();
    expect(() => listSupervisorInboxQuerySchema.parse({ limit: 51 })).toThrow();
    expect(listSupervisorInboxQuerySchema.parse({ limit: 50 }).limit).toBe(50);
  });
});
