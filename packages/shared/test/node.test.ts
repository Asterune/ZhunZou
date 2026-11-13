import { describe, expect, it } from 'vitest';

import {
  nodeFreeMemoryMB,
  nodeProfileSchema,
  sessionRecordSchema,
  taskEngineSchema,
} from '../src/index.js';

const validProfile = {
  nodeId: 'mac-mini-2',
  hostname: 'studio-mini',
  role: 'worker',
  tags: ['office', 'mac-mini', 'xcode'],
  freeMemoryMB: 8192,
  maxConcurrency: 2,
  repos: [
    { name: 'yikuaomed-erp', path: '/Users/qiliu/code/yikuaomed-erp' },
    { name: 'pte-dojo', path: '/Users/qiliu/code/pte-dojo', defaultBranch: 'main' },
  ],
} as const;

describe('nodeProfileSchema', () => {
  it('accepts a worker profile with a repo inventory', () => {
    const parsed = nodeProfileSchema.parse(validProfile);
    expect(parsed.role).toBe('worker');
    expect(parsed.tags).toEqual(['office', 'mac-mini', 'xcode']);
    expect(parsed.repos).toHaveLength(2);
    expect(parsed.repos[1]?.defaultBranch).toBe('main');
  });

  it('defaults a bare node to worker with one slot and no tags', () => {
    const parsed = nodeProfileSchema.parse({ nodeId: 'laptop', hostname: 'mbp' });
    expect(parsed.role).toBe('worker');
    expect(parsed.tags).toEqual([]);
    expect(parsed.maxConcurrency).toBe(1);
    expect(parsed.repos).toEqual([]);
    expect(parsed.freeMemoryMB).toBeUndefined();
  });

  it('rejects a role outside portal / worker / hybrid', () => {
    expect(
      nodeProfileSchema.safeParse({ ...validProfile, role: 'master' }).success,
    ).toBe(false);
  });

  it('requires repo paths to be absolute', () => {
    const result = nodeProfileSchema.safeParse({
      ...validProfile,
      repos: [{ name: 'pte-dojo', path: 'code/pte-dojo' }],
    });
    expect(result.success).toBe(false);
  });

  it('refuses a node with no identity or an oversized tag list', () => {
    expect(nodeProfileSchema.safeParse({ hostname: 'mbp' }).success).toBe(false);
    const tooManyTags = Array.from({ length: 11 }, (_, i) => `tag-${i}`);
    expect(nodeProfileSchema.safeParse({ ...validProfile, tags: tooManyTags }).success).toBe(
      false,
    );
  });
});

describe('nodeFreeMemoryMB', () => {
  it('converts the reported bytes snapshot to MB', () => {
    expect(nodeFreeMemoryMB({}, { freeMemBytes: 3 * 1024 * 1024 * 1024 })).toBe(3072);
  });

  it('prefers the profile value over a stale snapshot', () => {
    expect(
      nodeFreeMemoryMB(
        { freeMemoryMB: 6000 },
        { freeMemBytes: 512 * 1024 * 1024 },
      ),
    ).toBe(6000);
  });

  it('returns undefined when the node never reported memory', () => {
    expect(nodeFreeMemoryMB({}, { cpuCount: 8 })).toBeUndefined();
  });
});

describe('taskEngineSchema', () => {
  it('accepts the engines the blueprint names plus the ones the bridge adapts', () => {
    for (const engine of ['cursor', 'opencode', 'claude-code', 'qoder']) {
      expect(taskEngineSchema.parse(engine)).toBe(engine);
    }
  });

  it('rejects an unknown engine', () => {
    expect(taskEngineSchema.safeParse('vim').success).toBe(false);
  });
});

describe('sessionRecordSchema', () => {
  it('keeps the native session id needed to resume in place', () => {
    const parsed = sessionRecordSchema.parse({
      engine: 'cursor',
      sessionId: 'cs-9f3a',
      cwd: '/Users/qiliu/code/pte-dojo',
      resumable: true,
    });
    expect(parsed.resumeArgs).toBeUndefined();
    expect(parsed.resumable).toBe(true);
  });

  it('requires both engine and session id before a resume can be planned', () => {
    expect(
      sessionRecordSchema.safeParse({ engine: 'cursor', cwd: '/tmp' }).success,
    ).toBe(false);
    expect(
      sessionRecordSchema.safeParse({ sessionId: 'cs-1', cwd: '/tmp' }).success,
    ).toBe(false);
  });
});
