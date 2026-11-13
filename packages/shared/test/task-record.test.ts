import { describe, expect, it } from 'vitest';

import {
  TASK_ORIGINS,
  TASK_STATUSES,
  agentTaskSchema,
  createTaskSchema,
  dispatchTaskSchema,
  isAttentionTaskStatus,
  isTerminalTaskStatus,
} from '../src/index.js';

const persistedTask = {
  id: '7',
  env: 'studio-mini',
  title: '把导出按钮接上真实接口',
  instruction: '替换 mock 数据并补一条集成测试',
  status: 'HEALING',
  attempts: 2,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  repoName: 'pte-dojo',
  engine: 'opencode',
  origin: 'LOCAL_WRAP',
  sessionId: 'oc-2f9c',
  managedBySupervisor: true,
  retryCount: 2,
} as const;

describe('TaskRecord', () => {
  it('parses the supervisor fields the blueprint asks for', () => {
    const parsed = agentTaskSchema.parse(persistedTask);
    expect(parsed.repoName).toBe('pte-dojo');
    expect(parsed.engine).toBe('opencode');
    expect(parsed.origin).toBe('LOCAL_WRAP');
    expect(parsed.sessionId).toBe('oc-2f9c');
    expect(parsed.managedBySupervisor).toBe(true);
    expect(parsed.retryCount).toBe(2);
  });

  it('keeps a legacy dispatch row valid and fills its defaults', () => {
    const parsed = agentTaskSchema.parse({
      id: '8',
      env: 'company-cursor',
      title: '修一个空指针',
      instruction: '定位并修复',
      status: 'PENDING',
      attempts: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(parsed.origin).toBe('HUB_DISPATCH');
    expect(parsed.managedBySupervisor).toBe(false);
    expect(parsed.retryCount).toBe(0);
    expect(parsed.engine).toBeUndefined();
    expect(parsed.sessionId).toBeUndefined();
  });

  it('blocks a task that is still healing', () => {
    expect(TASK_STATUSES).toContain('BLOCKED');
    expect(TASK_STATUSES).toContain('HEALING');
    expect(isTerminalTaskStatus('BLOCKED')).toBe(false);
    expect(isTerminalTaskStatus('HEALING')).toBe(false);
    expect(isAttentionTaskStatus('BLOCKED')).toBe(true);
    expect(isAttentionTaskStatus('HEALING')).toBe(true);
    expect(isAttentionTaskStatus('DONE')).toBe(false);
  });

  it('only allows the two dispatch origins', () => {
    expect(TASK_ORIGINS).toEqual(['HUB_DISPATCH', 'LOCAL_WRAP']);
    expect(
      agentTaskSchema.safeParse({ ...persistedTask, origin: 'SLACK' }).success,
    ).toBe(false);
  });

  it('refuses a negative retry count', () => {
    expect(agentTaskSchema.safeParse({ ...persistedTask, retryCount: -1 }).success).toBe(false);
  });
});

describe('dispatchTaskSchema', () => {
  it('routes by repository when no env was chosen', () => {
    const parsed = dispatchTaskSchema.parse({
      repoName: 'pte-dojo',
      title: '接入分页查询',
      instruction: '按现有 hook 风格实现',
      engine: 'cursor',
      tags: ['mac-mini'],
    });
    expect(parsed.repoName).toBe('pte-dojo');
    expect(parsed.engine).toBe('cursor');
    expect(parsed.tags).toEqual(['mac-mini']);
  });

  it('rejects a dispatch with neither a repo nor an env', () => {
    expect(
      dispatchTaskSchema.safeParse({ title: 'x', instruction: 'y' }).success,
    ).toBe(false);
  });
});

describe('createTaskSchema', () => {
  it('lets a dashboard dispatch name the engine and repo', () => {
    const parsed = createTaskSchema.parse({
      env: 'studio-mini',
      title: '整理 CHANGELOG',
      instruction: '按 0.1.15 之后的提交汇总',
      repoName: 'pte-dojo',
      engine: 'opencode',
    });
    expect(parsed.repoName).toBe('pte-dojo');
  });

  it('still refuses an empty instruction', () => {
    expect(
      createTaskSchema.safeParse({ env: 'a', title: 't', instruction: '' }).success,
    ).toBe(false);
  });
});
