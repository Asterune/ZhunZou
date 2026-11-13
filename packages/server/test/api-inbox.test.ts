import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import type {
  AgentTask,
  AgentTokenResponse,
  SupervisorDiagnosis,
  SupervisorInboxItem,
} from '@zhunzou/shared';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FailureEvidence, SupervisorHealer } from '../src/supervisor/healer.js';

const ENV = 'inbox-api-env';
const TEST_TOKEN = 'test-secret-token';

interface Ctx {
  app: FastifyInstance;
  auth: { authorization: string };
  dir: string;
  close: () => Promise<void>;
}

async function createCtx(healer?: SupervisorHealer): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-inbox-api-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    HUB_SECRET_TOKEN: TEST_TOKEN,
    DATABASE_PATH: join(dir, 'test.db'),
    GLOBAL_RULES_PATH: join(dir, 'GLOBAL_RULES.md'),
    META_AGENT_ENABLED: 'false',
    WAIT_TIMEOUT_MS: '1000',
    SERVE_WEB: 'false',
    LOG_LEVEL: 'silent',
  });
  const app = await buildApp({ config, logger: false, ...(healer ? { healer } : {}) });

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

/** Verdicts are handed out one at a time, so a task can be ruled on twice. */
function stubHealer(verdicts: SupervisorDiagnosis[]): SupervisorHealer & { asked: FailureEvidence[] } {
  const asked: FailureEvidence[] = [];
  return {
    asked,
    async diagnose(evidence) {
      asked.push(evidence);
      return verdicts.shift();
    },
  };
}

const ESCALATE = (summary: string): SupervisorDiagnosis => ({
  decision: 'ESCALATE_TO_HUMAN',
  diagnosisSummary: summary,
});

async function createTask(ctx: Ctx): Promise<AgentTask> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: ctx.auth,
    payload: { env: ENV, title: '接入分页查询', instruction: '跑通 pnpm test。' },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { task: AgentTask }).task;
}

async function claim(ctx: Ctx): Promise<AgentTask | null> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/tasks/next?env=${ENV}&timeout=20`,
    headers: ctx.auth,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { task: AgentTask | null }).task;
}

async function reportFailure(
  ctx: Ctx,
  task: AgentTask,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/tasks/${task.id}/complete`,
    headers: ctx.auth,
    payload: { status: 'FAILED', result: '编译不过', ...overrides },
  });
  expect(response.statusCode).toBe(200);
}

async function getTask(ctx: Ctx, id: string): Promise<AgentTask> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/tasks/${id}`,
    headers: ctx.auth,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { task: AgentTask }).task;
}

async function inbox(ctx: Ctx, headers = ctx.auth, query = ''): Promise<SupervisorInboxItem[]> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/supervisor/inbox${query}`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { items: SupervisorInboxItem[] }).items;
}

/** The healing pass runs after the response, so the caller has to catch up. */
async function until(probe: () => Promise<AgentTask | null>, timeoutMs = 3_000): Promise<AgentTask> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('healing pass did not land');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('supervisor inbox over HTTP', () => {
  it('H1: an agent token is refused; the inbox is a human view', async () => {
    const ctx = await createCtx();
    try {
      const issued = await ctx.app.inject({
        method: 'POST',
        url: `/api/agents/${ENV}/token`,
        headers: ctx.auth,
      });
      expect(issued.statusCode).toBe(200);
      const agentAuth = {
        authorization: `Bearer ${(issued.json() as AgentTokenResponse).token}`,
      };

      const denied = await ctx.app.inject({
        method: 'GET',
        url: '/api/supervisor/inbox',
        headers: agentAuth,
      });
      expect(denied.statusCode).toBe(403);
    } finally {
      await ctx.close();
    }
  });

  it('H2: a task the breaker parked shows up with its ruling and its branch', async () => {
    const healer = stubHealer([ESCALATE('要不要清库需要人决定')]);
    const ctx = await createCtx(healer);
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      await reportFailure(ctx, task, { workspacePath: '/repo/.zhunzou/wt/1' });

      await until(async () => {
        const current = await getTask(ctx, task.id);
        return current.status === 'BLOCKED' ? current : null;
      });

      const items = await inbox(ctx);
      expect(items).toHaveLength(1);
      expect(items[0]?.task.id).toBe(task.id);
      expect(items[0]?.diagnosis).toBe('要不要清库需要人决定');
      expect(items[0]?.branch).toBe(`wip/zz-${task.id}`);
    } finally {
      await ctx.close();
    }
  });

  it('H3: a nonsense limit is rejected instead of ignored', async () => {
    const ctx = await createCtx();
    try {
      for (const query of ['?limit=abc', '?limit=999', '?limit=0']) {
        const response = await ctx.app.inject({
          method: 'GET',
          url: `/api/supervisor/inbox${query}`,
          headers: ctx.auth,
        });
        expect(response.statusCode, query).toBe(400);
      }
    } finally {
      await ctx.close();
    }
  });

  it('H4: an empty hub answers with an empty inbox, not an error', async () => {
    const ctx = await createCtx();
    try {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/supervisor/inbox',
        headers: ctx.auth,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items: [] });
    } finally {
      await ctx.close();
    }
  });

  it('H5: two rulings on one task leave one card, quoting the later one', async () => {
    const healer = stubHealer([ESCALATE('第一次的说法'), ESCALATE('放行后又卡住了')]);
    const ctx = await createCtx(healer);
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      await reportFailure(ctx, task);
      await until(async () => {
        const current = await getTask(ctx, task.id);
        return current.status === 'BLOCKED' ? current : null;
      });

      const released = await ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/retry`,
        headers: ctx.auth,
        payload: { reason: '人看了，再跑一次' },
      });
      expect(released.statusCode).toBe(200);

      await claim(ctx);
      await reportFailure(ctx, task);
      await until(async () => {
        const current = await getTask(ctx, task.id);
        return current.status === 'BLOCKED' ? current : null;
      });

      const items = await inbox(ctx);
      expect(items).toHaveLength(1);
      expect(items[0]?.diagnosis).toBe('放行后又卡住了');
    } finally {
      await ctx.close();
    }
  });

  it('H6: finished work is readable without inventing a diagnosis', async () => {
    const ctx = await createCtx();
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      const done = await ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/complete`,
        headers: ctx.auth,
        payload: { status: 'DONE', result: '改完并跑过测试' },
      });
      expect(done.statusCode).toBe(200);

      const items = await inbox(ctx);
      expect(items).toHaveLength(1);
      expect(Object.keys(items[0] ?? {})).toEqual(['task']);
      expect(items[0]?.task.result).toBe('改完并跑过测试');
    } finally {
      await ctx.close();
    }
  });
});
