import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';

import type { AgentTask } from '@zhunzou/shared';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { NotificationMessage, Notifier } from '../src/notifications.js';
import type {
  SupervisorDiagnosis,
  SupervisorHealer,
} from '../src/supervisor/healer.js';

const ENV = 'notify-env';
const TEST_TOKEN = 'test-secret-token';
const BASE = 'https://hub.example.com';

interface Ctx {
  app: FastifyInstance;
  auth: { authorization: string };
  sent: NotificationMessage[];
  close: () => Promise<void>;
}

function captureNotifier(messages: NotificationMessage[]): Notifier {
  return {
    name: 'capture',
    send: async (message) => {
      messages.push(message);
    },
  };
}

async function createCtx(options: {
  healer?: SupervisorHealer;
  publicBaseUrl?: string;
  /** No notifier at all, which is its own case (U7). */
  silent?: boolean;
} = {}): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-notify-api-'));
  const sent: NotificationMessage[] = [];
  const config = loadConfig({
    NODE_ENV: 'test',
    HUB_SECRET_TOKEN: TEST_TOKEN,
    DATABASE_PATH: join(dir, 'test.db'),
    GLOBAL_RULES_PATH: join(dir, 'GLOBAL_RULES.md'),
    META_AGENT_ENABLED: 'false',
    WAIT_TIMEOUT_MS: '1000',
    SERVE_WEB: 'false',
    LOG_LEVEL: 'silent',
    ...(options.publicBaseUrl ? { PUBLIC_BASE_URL: options.publicBaseUrl } : {}),
  });
  const app = await buildApp({
    config,
    logger: false,
    notifiers: options.silent ? [] : [captureNotifier(sent)],
    ...(options.healer ? { healer: options.healer } : {}),
  });

  return {
    app,
    dir,
    sent,
    auth: { authorization: `Bearer ${TEST_TOKEN}` },
    close: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function until(
  probe: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() > deadline) throw new Error('the announcement did not land');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The push runs after the response, so "nothing was sent" still needs a beat. */
async function settle(passes = 6): Promise<void> {
  for (let index = 0; index < passes; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function stubHealer(verdict: SupervisorDiagnosis | undefined): SupervisorHealer {
  return {
    async diagnose() {
      return verdict;
    },
  };
}

const ESCALATE: SupervisorDiagnosis = {
  decision: 'ESCALATE_TO_HUMAN',
  diagnosisSummary: '依赖装不上，需要人看一眼网络',
  errorSignature: 'ERR_NETWORK',
};

const RETRY: SupervisorDiagnosis = {
  decision: 'RETRY_WITH_FIX',
  diagnosisSummary: '页码传成了字符串',
  fixPrompt: '把 page 转成数字再传',
};

async function createTask(
  ctx: Ctx,
  url = '/api/tasks',
  payload: Record<string, unknown> = {},
): Promise<AgentTask> {
  const response = await ctx.app.inject({
    method: 'POST',
    url,
    headers: ctx.auth,
    payload: {
      env: ENV,
      projectName: 'pte-dojo',
      title: '接入分页查询',
      instruction: '按现有 hook 风格实现，跑通 pnpm test。',
      ...payload,
    },
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

async function complete(
  ctx: Ctx,
  task: AgentTask,
  status: 'FAILED' | 'DONE',
  result: string,
  workspacePath?: string,
): Promise<void> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/tasks/${task.id}/complete`,
    headers: ctx.auth,
    payload: {
      status,
      result,
      ...(workspacePath ? { workspacePath } : {}),
    },
  });
  expect(response.statusCode).toBe(200);
}

async function statusOf(ctx: Ctx, id: string): Promise<string> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/tasks/${id}`,
    headers: ctx.auth,
  });
  return (response.json() as { task: AgentTask }).task.status;
}

async function untilStatus(ctx: Ctx, id: string, status: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    if ((await statusOf(ctx, id)) === status) return;
    if (Date.now() > deadline) throw new Error(`task did not become ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('task pushes', () => {
  it('U1: a breaker block pushes one 批准继续 with a signed task link', async () => {
    const ctx = await createCtx({
      healer: stubHealer(RETRY),
      publicBaseUrl: BASE,
    });
    try {
      const task = await createTask(ctx);
      const id = Number(task.id);
      await claim(ctx);
      await complete(ctx, task, 'FAILED', '第一次也不过');

      // The ceiling is reached on the run that fails for the fourth time.
      for (let round = 1; round <= 2; round += 1) {
        ctx.app.repo.retryTask(id, `第 ${round} 次建议`);
        await claim(ctx);
        await complete(ctx, task, 'FAILED', `第 ${round} 次还是不过`);
      }
      ctx.app.repo.retryTask(id, '第 3 次建议');
      await claim(ctx);
      await complete(ctx, task, 'FAILED', '第四次也不过');

      await until(() => ctx.sent.length === 1);
      const [message] = ctx.sent;
      expect(message.kind).toBe('blocked');
      expect(message.title).toContain('卡住');
      expect(message.text).toContain('已自愈 3 次');
      expect(message.task).toMatchObject({ id: task.id, status: 'BLOCKED' });
      const link = message.actions?.[0]?.url ?? '';
      expect(link.startsWith(`${BASE}/t/task.`)).toBe(true);
      expect(link).toBe(message.approvalUrl);
      // The token the push carries really does open the page.
      const page = await ctx.app.inject({ method: 'GET', url: link });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('接入分页查询');
    } finally {
      await ctx.close();
    }
  });

  it('U2: an escalation push quotes the supervisor, not the engine', async () => {
    const ctx = await createCtx({ healer: stubHealer(ESCALATE) });
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      await complete(ctx, task, 'FAILED', 'npm i 失败');

      await until(() => ctx.sent.length === 1);
      expect(ctx.sent[0]?.text).toContain(
        '管家诊断：依赖装不上，需要人看一眼网络',
      );
      expect(ctx.sent[0]?.text).not.toContain('引擎结论');
    } finally {
      await ctx.close();
    }
  });

  it('U3: a self-healing retry pushes nothing', async () => {
    const ctx = await createCtx({ healer: stubHealer(RETRY) });
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      await complete(ctx, task, 'FAILED', '编译不过');

      await untilStatus(ctx, task.id, 'HEALING');
      await settle();
      expect(ctx.sent).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  it('U4: a finished task pushes the engine word and no approval link', async () => {
    const ctx = await createCtx({ publicBaseUrl: BASE });
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      await complete(ctx, task, 'DONE', '分页查询已上线，测试全绿');

      await until(() => ctx.sent.length === 1);
      const [message] = ctx.sent;
      expect(message.kind).toBe('done');
      expect(message.title).toContain('完工');
      expect(message.text).toContain('引擎结论：分页查询已上线，测试全绿');
      expect(message.approvalUrl).toBeUndefined();
      expect(message.actions?.map((action) => action.url)).toEqual([
        `${BASE}/?tab=inbox`,
      ]);
    } finally {
      await ctx.close();
    }
  });

  it('U4b: a locally wrapped run that ends is nobody else’s news', async () => {
    const ctx = await createCtx({ publicBaseUrl: BASE });
    try {
      const task = await createTask(ctx, '/api/tasks/local');
      expect(task.origin).toBe('LOCAL_WRAP');
      await claim(ctx);
      await complete(ctx, task, 'DONE', '我自己看完了');

      await settle();
      expect(ctx.sent).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  it('U5: a completion over the socket pushes what the HTTP one does', async () => {
    const ctx = await createCtx({ publicBaseUrl: BASE });
    try {
      await ctx.app.listen({ port: 0, host: '127.0.0.1' });
      const address = ctx.app.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('test server is not listening');
      }

      const task = await createTask(ctx);
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/ws/bridge?env=${ENV}`,
        { headers: ctx.auth },
      );
      const frames: Array<Record<string, unknown>> = [];
      socket.on('message', (data) => {
        frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });

      const claimed = await claim(ctx);
      expect(claimed?.id).toBe(task.id);
      socket.send(
        JSON.stringify({
          type: 'task.complete',
          requestId: 'r-1',
          taskId: task.id,
          status: 'DONE',
          result: 'socket 上跑完了',
        }),
      );
      await until(() =>
        frames.some((frame) => frame.type === 'task.completed'),
      );
      await until(() => ctx.sent.length === 1);

      expect(ctx.sent[0]?.kind).toBe('done');
      expect(ctx.sent[0]?.text).toContain('引擎结论：socket 上跑完了');
      socket.close();
    } finally {
      await ctx.close();
    }
  });

  it('U6: without a public origin the block still reaches a human', async () => {
    const ctx = await createCtx({ healer: stubHealer(ESCALATE) });
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      await complete(ctx, task, 'FAILED', 'npm i 失败');

      await until(() => ctx.sent.length === 1);
      expect(ctx.sent[0]?.kind).toBe('blocked');
      expect('approvalUrl' in (ctx.sent[0] ?? {})).toBe(false);
      expect('actions' in (ctx.sent[0] ?? {})).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it('U7: no notification channel changes nothing about the task', async () => {
    const ctx = await createCtx({ healer: stubHealer(ESCALATE), silent: true });
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      await complete(ctx, task, 'FAILED', 'npm i 失败');

      await untilStatus(ctx, task.id, 'BLOCKED');
      await settle();
      expect(ctx.sent).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  it('U8: only a path the node reported turns into branch information', async () => {
    const ctx = await createCtx({
      healer: stubHealer(ESCALATE),
      publicBaseUrl: BASE,
    });
    try {
      const task = await createTask(ctx);
      await claim(ctx);
      await complete(
        ctx,
        task,
        'FAILED',
        'npm i 失败',
        '/repo/.zhunzou/wt/77',
      );

      await until(() => ctx.sent.length === 1);
      expect(ctx.sent[0]?.text).toContain('分支：wip/zz-');
      expect(ctx.sent[0]?.text).toContain('工作区：/repo/.zhunzou/wt/77');
      expect(ctx.sent[0]?.actions?.map((action) => action.label)).toEqual([
        '批准继续',
        '打开看板',
      ]);
    } finally {
      await ctx.close();
    }
  });
});
