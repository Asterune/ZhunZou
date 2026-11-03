import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import type { CreateTicketInput } from '@zhunzou/shared';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { MetaAgent } from '../src/meta-agent.js';
import type { HubPlugin } from '../src/plugins.js';

export const TEST_TOKEN = 'test-secret-token';

export interface TestContext {
  app: FastifyInstance;
  dir: string;
  auth: { authorization: string };
  close: () => Promise<void>;
}

export async function createTestContext(
  metaAgent?: MetaAgent,
  plugins?: HubPlugin[],
  env: NodeJS.ProcessEnv = {},
): Promise<TestContext> {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    HUB_SECRET_TOKEN: TEST_TOKEN,
    DATABASE_PATH: join(dir, 'test.db'),
    GLOBAL_RULES_PATH: join(dir, 'GLOBAL_RULES.md'),
    META_AGENT_ENABLED: 'false',
    WAIT_TIMEOUT_MS: '5000',
    SERVE_WEB: 'false',
    LOG_LEVEL: 'silent',
    ...env,
  });

  const app = await buildApp({
    config,
    logger: false,
    ...(metaAgent ? { metaAgent } : {}),
    ...(plugins ? { plugins } : {}),
  });

  return {
    app,
    dir,
    auth: { authorization: `Bearer ${TEST_TOKEN}` },
    close: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function ticketInput(overrides: Partial<CreateTicketInput> = {}): CreateTicketInput {
  return {
    env: 'company-cursor',
    projectName: 'yikuaomed-erp',
    doneSummary: '完成登录页表单校验',
    blockerQuestion: '错误提示用 Toast 还是行内文案？',
    nextStepPlan: '确定后接入统一错误处理并补测试',
    options: [
      { key: 'A', label: 'Toast 提示', prosCons: '统一、实现快' },
      { key: 'B', label: '行内文案', prosCons: '更贴近字段' },
    ],
    recommendedOption: 'A',
    ...overrides,
  };
}

export async function waitFor<T>(
  probe: () => T | null | undefined | false,
  { timeoutMs = 3000, intervalMs = 15 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
