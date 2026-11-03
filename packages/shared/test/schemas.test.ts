import { describe, expect, it } from 'vitest';

import {
  batchResolveTicketsSchema,
  bindWorkspaceProjectSchema,
  completeTaskSchema,
  createTaskSchema,
  createTicketSchema,
  decisionTicketSchema,
  extendTicketSchema,
  isActiveTaskStatus,
  isAwaitingDecision,
  isResolvedStatus,
  isTerminalStatus,
  isTerminalTaskStatus,
  listRuleCandidatesQuerySchema,
  listTasksQuerySchema,
  listTicketsQuerySchema,
  listWorkspaceProjectsQuerySchema,
  nextTaskQuerySchema,
  resolveTicketSchema,
  ruleCandidateSchema,
  waitQuerySchema,
  workspaceProjectSchema,
} from '../src/index.js';

const validTicketInput = {
  env: 'company-cursor',
  projectName: 'yikuaomed-erp',
  doneSummary: '完成了登录页表单校验',
  blockerQuestion: '校验失败提示应该用 Toast 还是行内文案？',
  nextStepPlan: '选定后接入统一错误处理并补测试',
  options: [
    { key: 'A', label: 'Toast 提示', prosCons: '统一、实现快' },
    { key: 'B', label: '行内文案', prosCons: '更贴近字段' },
  ],
  recommendedOption: 'A',
} as const;

describe('createTicketSchema', () => {
  it('accepts a well-formed three-line brief', () => {
    const parsed = createTicketSchema.parse(validTicketInput);
    expect(parsed.recommendedOption).toBe('A');
    expect(parsed.options).toHaveLength(2);
  });

  it('rejects duplicate option keys', () => {
    const result = createTicketSchema.safeParse({
      ...validTicketInput,
      options: [
        { key: 'A', label: '方案一' },
        { key: 'A', label: '方案二' },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('unique');
    }
  });

  it('rejects a recommendation that is not one of the options', () => {
    const result = createTicketSchema.safeParse({
      ...validTicketInput,
      recommendedOption: 'C',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('recommendedOption'))).toBe(
        true,
      );
    }
  });

  it('requires at least two closed-form options', () => {
    const result = createTicketSchema.safeParse({
      ...validTicketInput,
      options: [{ key: 'A', label: '只有一个方案' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty doneSummary', () => {
    const result = createTicketSchema.safeParse({ ...validTicketInput, doneSummary: '   ' });
    expect(result.success).toBe(false);
  });
});

describe('resolveTicketSchema', () => {
  it('requires a selected option', () => {
    expect(resolveTicketSchema.safeParse({}).success).toBe(false);
    expect(resolveTicketSchema.safeParse({ selectedOption: 'B' }).success).toBe(true);
  });

  it('keeps an optional custom instruction', () => {
    const parsed = resolveTicketSchema.parse({
      selectedOption: 'A',
      customInstruction: '先只改登录页，其他页面下个迭代再做',
    });
    expect(parsed.customInstruction).toContain('登录页');
  });

  it('accepts an explicit destructive confirmation', () => {
    expect(
      resolveTicketSchema.parse({
        selectedOption: 'B',
        confirmDestructive: true,
      }).confirmDestructive,
    ).toBe(true);
  });
});

describe('batch and extend schemas', () => {
  it('limits a batch to 50 tickets', () => {
    expect(
      batchResolveTicketsSchema.safeParse({
        ticketIds: ['1', '2'],
      }).success,
    ).toBe(true);
    expect(
      batchResolveTicketsSchema.safeParse({
        ticketIds: Array.from({ length: 51 }, (_, index) => String(index + 1)),
      }).success,
    ).toBe(false);
  });

  it('defaults the snooze to 10 minutes', () => {
    expect(extendTicketSchema.parse({}).minutes).toBe(10);
    expect(extendTicketSchema.parse({ minutes: '30' }).minutes).toBe(30);
    expect(extendTicketSchema.safeParse({ minutes: 0 }).success).toBe(false);
  });
});

describe('query schemas', () => {
  it('coerces the long-poll timeout from a query string', () => {
    expect(waitQuerySchema.parse({ timeout: '12000' }).timeout).toBe(12_000);
    expect(waitQuerySchema.parse({}).timeout).toBe(40_000);
  });

  it('rejects a timeout beyond the proxy-safe ceiling', () => {
    expect(waitQuerySchema.safeParse({ timeout: '60000' }).success).toBe(false);
  });

  it('defaults the ticket list limit', () => {
    expect(listTicketsQuerySchema.parse({}).limit).toBe(50);
  });

  it('rejects an unknown status filter', () => {
    expect(listTicketsQuerySchema.safeParse({ status: 'DONE' }).success).toBe(false);
  });
});

describe('task schemas', () => {
  it('accepts a dispatched task', () => {
    const parsed = createTaskSchema.parse({
      env: 'company-windows',
      projectName: 'yikuaomed-erp',
      title: '给登录页补错误提示',
      instruction: '统一使用行内文案，并补一条测试。',
    });
    expect(parsed.title).toContain('登录页');
  });

  it('rejects an empty task instruction', () => {
    expect(
      createTaskSchema.safeParse({
        env: 'company-windows',
        title: '空指令',
        instruction: '   ',
      }).success,
    ).toBe(false);
  });

  it('defaults the next-task timeout and list limit', () => {
    expect(nextTaskQuerySchema.parse({ env: 'company-windows' }).timeout).toBe(40_000);
    expect(listTasksQuerySchema.parse({}).limit).toBe(100);
  });

  it('limits completion to DONE or FAILED', () => {
    expect(completeTaskSchema.safeParse({ status: 'DONE' }).success).toBe(true);
    expect(completeTaskSchema.safeParse({ status: 'CANCELLED' }).success).toBe(false);
  });

  it('classifies task statuses', () => {
    expect(isActiveTaskStatus('PENDING')).toBe(true);
    expect(isActiveTaskStatus('CLAIMED')).toBe(true);
    expect(isActiveTaskStatus('DONE')).toBe(false);
    expect(isTerminalTaskStatus('FAILED')).toBe(true);
    expect(isTerminalTaskStatus('PENDING')).toBe(false);
  });
});

describe('decisionTicketSchema', () => {
  it('parses a persisted resolved ticket', () => {
    const parsed = decisionTicketSchema.parse({
      ...validTicketInput,
      id: '104',
      status: 'HUMAN_RESOLVED',
      selectedOption: 'B',
      customInstruction: '用行内文案',
      resolvedBy: 'HUMAN',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
    });

    expect(parsed.id).toBe('104');
    expect(parsed.resolvedBy).toBe('HUMAN');
  });

  it('rejects a non-numeric id', () => {
    const result = decisionTicketSchema.safeParse({
      ...validTicketInput,
      id: '#104',
      status: 'PENDING_HUMAN',
      createdAt: 0,
      updatedAt: 0,
    });
    expect(result.success).toBe(false);
  });

  it('accepts option risk, expiry and timeout resolution metadata', () => {
    const parsed = decisionTicketSchema.parse({
      ...validTicketInput,
      id: '104',
      status: 'AUTO_RESOLVED',
      selectedOption: 'A',
      resolvedBy: 'TIMEOUT',
      expiresAt: 1_700_000_010_000,
      options: [
        { key: 'A', label: 'Toast', risk: 'safe' },
        { key: 'B', label: '删除数据', risk: 'destructive' },
      ],
      createdAt: 0,
      updatedAt: 1,
    });

    expect(parsed.resolvedBy).toBe('TIMEOUT');
    expect(parsed.options[1]?.risk).toBe('destructive');
    expect(parsed.expiresAt).toBe(1_700_000_010_000);
  });
});

describe('rule candidates', () => {
  it('parses a pending candidate and its list query', () => {
    const candidate = ruleCandidateSchema.parse({
      id: '7',
      ticketId: '104',
      content: '- 表单错误优先使用行内文案。',
      status: 'PENDING',
      createdAt: 1,
      updatedAt: 1,
    });
    expect(candidate.status).toBe('PENDING');

    expect(listRuleCandidatesQuerySchema.parse({}).limit).toBe(50);
    expect(
      listRuleCandidatesQuerySchema.parse({ status: 'ACCEPTED' }).status,
    ).toBe('ACCEPTED');
  });

  it('rejects an unknown candidate status', () => {
    const result = ruleCandidateSchema.safeParse({
      id: '7',
      ticketId: '104',
      content: '- x',
      status: 'MAYBE',
      createdAt: 1,
      updatedAt: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('workspace project bindings', () => {
  it('parses a binding and trims whitespace', () => {
    const parsed = bindWorkspaceProjectSchema.parse({
      env: '  home-mac-opencode ',
      projectName: ' agent-hub ',
    });
    expect(parsed).toEqual({
      env: 'home-mac-opencode',
      projectName: 'agent-hub',
    });
  });

  it('rejects an empty project name', () => {
    const result = bindWorkspaceProjectSchema.safeParse({
      env: 'home-mac-opencode',
      projectName: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('parses a persisted binding and list query', () => {
    const project = workspaceProjectSchema.parse({
      id: '3',
      env: 'home-mac-opencode',
      projectName: 'agent-hub',
      createdAt: 1,
      updatedAt: 2,
    });
    expect(project.projectName).toBe('agent-hub');
    expect(listWorkspaceProjectsQuerySchema.parse({}).env).toBeUndefined();
    expect(
      listWorkspaceProjectsQuerySchema.parse({ env: 'home-mac-opencode' }).env,
    ).toBe('home-mac-opencode');
  });
});

describe('state machine helpers', () => {
  it('classifies statuses', () => {
    expect(isTerminalStatus('AUTO_RESOLVED')).toBe(true);
    expect(isTerminalStatus('CANCELLED')).toBe(true);
    expect(isTerminalStatus('PENDING_HUMAN')).toBe(false);
    expect(isResolvedStatus('HUMAN_RESOLVED')).toBe(true);
    expect(isResolvedStatus('CANCELLED')).toBe(false);
    expect(isAwaitingDecision('PENDING_META')).toBe(true);
  });
});
