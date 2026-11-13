import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import type {
  AgentTask,
  AgentTokenResponse,
  AppendTaskLogInput,
  SupervisorDiagnosis,
  TaskLog,
} from '@zhunzou/shared';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FailureEvidence, SupervisorHealer } from '../src/supervisor/healer.js';

const ENV = 'heal-env';
const TEST_TOKEN = 'test-secret-token';

interface Ctx {
  app: FastifyInstance;
  auth: { authorization: string };
  dir: string;
  close: () => Promise<void>;
}

/**
 * The healing pass runs after the response, so every assertion here has to
 * wait for the hub to finish thinking. The probe itself is awaited: unlike the
 * shared `waitFor`, this one can make HTTP calls.
 */
async function createCtx(healer: SupervisorHealer): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-healer-api-'));
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
  const app = await buildApp({ config, logger: false, healer });

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

async function until<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('healing pass did not land');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function settle(passes = 6): Promise<void> {
  for (let index = 0; index < passes; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function stubHealer(
  verdict: SupervisorDiagnosis | undefined,
): SupervisorHealer & { asked: FailureEvidence[] } {
  const asked: FailureEvidence[] = [];
  return {
    asked,
    async diagnose(evidence) {
      asked.push(evidence);
      return verdict;
    },
  };
}

async function createTask(ctx: Ctx): Promise<AgentTask> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: ctx.auth,
    payload: {
      env: ENV,
      projectName: 'pte-dojo',
      title: '接入分页查询',
      instruction: '按现有 hook 风格实现，跑通 pnpm test。',
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { task: AgentTask }).task;
}

async function createWrappedTask(ctx: Ctx): Promise<AgentTask> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tasks/local',
    headers: ctx.auth,
    payload: { env: ENV, title: '本地陪跑', instruction: '在我这台机器上跑。' },
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
  overrides: Partial<AppendTaskLogInput> = {},
): Promise<{ status: number; body: { task: AgentTask } }> {
  if (overrides.chunk) {
    const log = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/log`,
      headers: ctx.auth,
      payload: { stream: 'stderr', ...overrides },
    });
    expect(log.statusCode).toBe(201);
  }

  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/tasks/${task.id}/complete`,
    headers: ctx.auth,
    payload: { status: 'FAILED', result: overrides.errorSignature ?? '编译不过' },
  });
  return { status: response.statusCode, body: response.json() as { task: AgentTask } };
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

async function logsOf(ctx: Ctx, id: string): Promise<TaskLog[]> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/tasks/${id}/logs`,
    headers: ctx.auth,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { logs: TaskLog[] }).logs;
}

const RETRY_VERDICT: SupervisorDiagnosis = {
  decision: 'RETRY_WITH_FIX',
  diagnosisSummary: '页码传成了字符串',
  fixPrompt: '把 page 改成 number 再跑一次测试',
};

describe('L2 healing pass', () => {
  it('H1: a retry verdict reopens the task without changing the engine’s answer', async () => {
    const healer = stubHealer(RETRY_VERDICT);
    const ctx = await createCtx(healer);
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      const report = await reportFailure(ctx, task, {
        chunk: 'src/pages/list.ts(24,7): error TS2322',
        errorSignature: 'TS2322 src/pages/list.ts',
      });

      // The response the bridge sees is still the engine's own verdict.
      expect(report.body.task).toMatchObject({ status: 'FAILED', result: 'TS2322 src/pages/list.ts' });

      const healed = await until(async () => {
        const current = await getTask(ctx, task.id);
        return current.status === 'HEALING' ? current : null;
      });
      expect(healed).toMatchObject({ retryCount: 1, fixPrompt: RETRY_VERDICT.fixPrompt });
      expect(healed.result).toBe('TS2322 src/pages/list.ts');

      expect(healer.asked).toHaveLength(1);
      expect(healer.asked[0]?.lastSignature).toBe('TS2322 src/pages/list.ts');
      expect(healer.asked[0]?.logTail).toContain('TS2322');
    } finally {
      await ctx.close();
    }
  });

  it('H2: escalating parks the task and keeps the engine’s words', async () => {
    const healer = stubHealer({
      decision: 'ESCALATE_TO_HUMAN',
      diagnosisSummary: '要不要清库需要人决定',
    });
    const ctx = await createCtx(healer);
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      await reportFailure(ctx, task, { chunk: 'drop table?' });

      const blocked = await until(async () => {
        const current = await getTask(ctx, task.id);
        return current.status === 'BLOCKED' ? current : null;
      });
      expect(blocked.result).toBe('编译不过');
      expect(blocked.retryCount).toBe(0);

      const list = await ctx.app.inject({
        method: 'GET',
        url: `/api/tasks?env=${ENV}&status=BLOCKED`,
        headers: ctx.auth,
      });
      expect((list.json() as { tasks: AgentTask[] }).tasks.map((item) => item.id)).toEqual([
        task.id,
      ]);
    } finally {
      await ctx.close();
    }
  });

  it('H3: approving a failure only leaves a note', async () => {
    const healer = stubHealer({
      decision: 'APPROVE',
      diagnosisSummary: '测试如实报错，失败是结果',
    });
    const ctx = await createCtx(healer);
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      await reportFailure(ctx, task, { chunk: '1 test failed' });
      const before = await logsOf(ctx, task.id);

      await settle();
      const after = await getTask(ctx, task.id);
      expect(after.status).toBe('FAILED');
      expect(after.retryCount).toBe(0);

      const rows = await logsOf(ctx, task.id);
      expect(rows).toHaveLength(before.length + 1);
      expect(rows.at(-1)).toMatchObject({
        diagnosis: '测试如实报错，失败是结果',
        stream: 'system',
      });
      expect(after.fixPrompt).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it('H4: no verdict from the model means nothing happens at all', async () => {
    const healer = stubHealer(undefined);
    const ctx = await createCtx(healer);
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      await reportFailure(ctx, task, { chunk: 'boom', errorSignature: 'TS2322 src/a.ts' });
      const before = await logsOf(ctx, task.id);

      await settle();
      expect(await getTask(ctx, task.id)).toMatchObject({
        status: 'FAILED',
        retryCount: 0,
      });
      expect(await logsOf(ctx, task.id)).toHaveLength(before.length);
      expect(healer.asked).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });

  it('H5: a run at the ceiling is blocked before the model is asked', async () => {
    const healer = stubHealer(RETRY_VERDICT);
    const ctx = await createCtx(healer);
    try {
      const task = await createTask(ctx);
      const id = Number(task.id);
      ctx.app.repo.claimNextTask(ENV);
      ctx.app.repo.completeTask(id, { status: 'FAILED', result: '第一次也不过' });

      // Two automatic retries already spent, each ending the same way.
      for (let round = 1; round <= 2; round += 1) {
        expect(ctx.app.repo.retryTask(id, `第 ${round} 次建议`)?.status).toBe('HEALING');
        expect(ctx.app.repo.claimNextTask(ENV)?.status).toBe('CLAIMED');
        ctx.app.repo.completeTask(id, { status: 'FAILED', result: `第 ${round} 次还是不过` });
      }

      // The third retry is the run that is about to fail over the ceiling.
      expect(ctx.app.repo.retryTask(id, '第 3 次建议')?.retryCount).toBe(3);
      expect(ctx.app.repo.claimNextTask(ENV)?.status).toBe('CLAIMED');
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/complete`,
        headers: ctx.auth,
        payload: { status: 'FAILED', result: '第四次也不过' },
      });
      expect(response.statusCode).toBe(200);

      const blocked = await until(async () => {
        const current = await getTask(ctx, task.id);
        return current.status === 'BLOCKED' ? current : null;
      });
      expect(healer.asked).toHaveLength(0);
      expect((await logsOf(ctx, task.id)).at(-1)?.diagnosis).toContain('已自愈 3 次');
      // The engine's words survive the hub's opinion about them.
      expect(blocked.result).toBe('第四次也不过');
    } finally {
      await ctx.close();
    }
  });

  it('H6: the same error twice in a row is stopped by the breaker, not the model', async () => {
    const healer = stubHealer(RETRY_VERDICT);
    const ctx = await createCtx(healer);
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      await reportFailure(ctx, task, {
        chunk: 'error TS2322 src/a.ts',
        errorSignature: 'TS2322 src/a.ts',
      });
      await until(async () => (await getTask(ctx, task.id)).status === 'HEALING');

      const again = await claim(ctx);
      expect(again?.fixPrompt).toBe(RETRY_VERDICT.fixPrompt);
      await reportFailure(ctx, again!, {
        chunk: 'error TS2322 src/a.ts again',
        errorSignature: 'TS2322 src/a.ts',
      });

      const blocked = await until(async () => {
        const current = await getTask(ctx, task.id);
        return current.status === 'BLOCKED' ? current : null;
      });
      expect(healer.asked).toHaveLength(1);
      expect(blocked.retryCount).toBe(1);
      expect((await logsOf(ctx, task.id)).at(-1)?.diagnosis).toContain('同一个错');
    } finally {
      await ctx.close();
    }
  });

  it('H7: the supervisor row carries the evidence it judged', async () => {
    const diffHash = 'd'.repeat(32);
    const healer = stubHealer(RETRY_VERDICT);
    const ctx = await createCtx(healer);
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      await reportFailure(ctx, task, {
        chunk: 'error TS2322 src/a.ts',
        errorSignature: 'TS2322 src/a.ts',
        diffHash,
      });

      await until(async () => (await getTask(ctx, task.id)).status === 'HEALING');
      const row = (await logsOf(ctx, task.id)).at(-1)!;
      expect(row).toMatchObject({
        stream: 'system',
        diagnosis: RETRY_VERDICT.diagnosisSummary,
        errorSignature: 'TS2322 src/a.ts',
        diffHash,
      });
      expect(row.chunk).toContain(RETRY_VERDICT.diagnosisSummary);
    } finally {
      await ctx.close();
    }
  });

  it('H8: a finished task never reaches the supervisor', async () => {
    const healer = stubHealer(RETRY_VERDICT);
    const ctx = await createCtx(healer);
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/complete`,
        headers: ctx.auth,
        payload: { status: 'DONE', result: '做完了' },
      });
      expect(response.statusCode).toBe(200);

      await settle();
      expect(healer.asked).toHaveLength(0);
      expect(await getTask(ctx, task.id)).toMatchObject({ status: 'DONE', retryCount: 0 });
    } finally {
      await ctx.close();
    }
  });

  it('H9: a run with a human at the terminal is left to that human', async () => {
    const healer = stubHealer(RETRY_VERDICT);
    const ctx = await createCtx(healer);
    try {
      const task = await createWrappedTask(ctx);
      expect(task).toMatchObject({ origin: 'LOCAL_WRAP', managedBySupervisor: false });

      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/complete`,
        headers: ctx.auth,
        payload: { status: 'FAILED', result: '本地跑挂了' },
      });
      expect(response.statusCode).toBe(200);

      await settle();
      expect(healer.asked).toHaveLength(0);
      expect(await getTask(ctx, task.id)).toMatchObject({ status: 'FAILED', retryCount: 0 });
    } finally {
      await ctx.close();
    }
  });

  it('H10: once the hub took the run over, it owns the failure too', async () => {
    const healer = stubHealer(RETRY_VERDICT);
    const ctx = await createCtx(healer);
    try {
      const task = await createWrappedTask(ctx);
      ctx.app.repo.markTaskManaged(Number(task.id), '人离开了终端');

      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/complete`,
        headers: ctx.auth,
        payload: { status: 'FAILED', result: '本地跑挂了' },
      });
      expect(response.statusCode).toBe(200);

      await until(async () => (await getTask(ctx, task.id)).status === 'HEALING');
      expect(healer.asked).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });

  it('H11: a human reopening does not buy three more automatic rounds', async () => {
    const healer = stubHealer(RETRY_VERDICT);
    const ctx = await createCtx(healer);
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      await reportFailure(ctx, task, {
        chunk: 'error TS2322',
        errorSignature: 'TS2322 src/a.ts',
      });
      await until(async () => (await getTask(ctx, task.id)).status === 'HEALING');

      const again = (await claim(ctx))!;
      await reportFailure(ctx, again, {
        chunk: 'error TS2322 still',
        errorSignature: 'TS2322 src/a.ts',
      });
      await until(async () => (await getTask(ctx, task.id)).status === 'BLOCKED');

      const reopened = await ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/retry`,
        headers: ctx.auth,
        payload: { reason: '我来看着跑一次' },
      });
      expect(reopened.statusCode).toBe(200);
      expect((reopened.json() as { task: AgentTask }).task).toMatchObject({
        status: 'PENDING',
        retryCount: 0,
      });

      const rows = await logsOf(ctx, task.id);
      expect(rows.at(-1)).toMatchObject({ stream: 'system' });
      expect(rows.at(-1)!.chunk).toContain('我来看着跑一次');

      // Same failure straight away: the evidence the human left behind still condemns it.
      const third = (await claim(ctx))!;
      await reportFailure(ctx, third, {
        chunk: 'error TS2322 again',
        errorSignature: 'TS2322 src/a.ts',
      });
      const blocked = await until(async () => {
        const current = await getTask(ctx, task.id);
        return current.status === 'BLOCKED' ? current : null;
      });
      expect(healer.asked).toHaveLength(1);
      expect(blocked.retryCount).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it('H12: an agent token cannot open a blocked task', async () => {
    const healer = stubHealer(undefined);
    const ctx = await createCtx(healer);
    try {
      const task = await createTask(ctx);
      const id = Number(task.id);
      await claim(ctx);
      ctx.app.repo.completeTask(id, { status: 'FAILED', result: '不过' });
      expect(ctx.app.repo.blockTask(id)?.status).toBe('BLOCKED');

      const issued = await ctx.app.inject({
        method: 'POST',
        url: `/api/agents/${ENV}/token`,
        headers: ctx.auth,
      });
      const token = (issued.json() as AgentTokenResponse).token;

      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/retry`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(403);
      expect(await getTask(ctx, task.id)).toMatchObject({ status: 'BLOCKED' });
    } finally {
      await ctx.close();
    }
  });

  it('H13: the retry prompt reaches the bridge exactly once', async () => {
    const healer = stubHealer(RETRY_VERDICT);
    const ctx = await createCtx(healer);
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      await reportFailure(ctx, task, { chunk: 'boom' });
      await until(async () => (await getTask(ctx, task.id)).status === 'HEALING');

      const claimed = await claim(ctx);
      expect(claimed).toMatchObject({ status: 'CLAIMED', fixPrompt: RETRY_VERDICT.fixPrompt });
      // Spending it means the row no longer holds it.
      expect((await getTask(ctx, task.id)).fixPrompt).toBeUndefined();
      expect(await claim(ctx)).toBeNull();
    } finally {
      await ctx.close();
    }
  });
});
