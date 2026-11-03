import { describe, expect, it } from 'vitest';

import type { AgentTask, DecisionTicket } from '@zhunzou/shared';

import type { BridgeConfig } from '../src/config.js';

export function makeTicket(overrides: Partial<DecisionTicket> = {}): DecisionTicket {
  return {
    id: '104',
    env: 'company-cursor',
    projectName: 'yikuaomed-erp',
    status: 'PENDING_HUMAN',
    doneSummary: '完成登录页表单校验',
    blockerQuestion: '错误提示用 Toast 还是行内文案？',
    nextStepPlan: '确定后接入统一错误处理',
    options: [
      { key: 'A', label: 'Toast 提示' },
      { key: 'B', label: '行内文案' },
    ],
    recommendedOption: 'A',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: '12',
    env: 'company-cursor',
    projectName: 'yikuaomed-erp',
    title: '给登录页补错误提示',
    instruction: '错误提示统一使用行内文案，并补一条测试。',
    status: 'CLAIMED',
    attempts: 1,
    createdAt: 1,
    updatedAt: 2,
    claimedAt: 2,
    ...overrides,
  };
}

export function testConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    hubUrl: 'http://127.0.0.1:9999',
    token: 'test-token',
    agentEnv: 'company-cursor',
    fallback: 'cli',
    waitTimeoutMs: 40_000,
    cliCommand: 'npx zhunzou-bridge',
    heartbeatIntervalMs: 30_000,
    ...overrides,
  };
}
