import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import type { AgentTask, TaskLog } from '@zhunzou/shared';

import { buildApprovalToken, buildTaskApprovalToken } from '../src/approval-link.js';
import {
  createTestContext,
  type TestContext,
} from './helpers.js';

const ENV = 'task-approval-env';
const SECRET = 'link-secret';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext(undefined, undefined, {
    APPROVAL_LINK_SECRET: SECRET,
    PUBLIC_BASE_URL: 'https://hub.example.com',
    META_AGENT_ENABLED: 'false',
  });
});

afterAll(async () => {
  await ctx.close();
});

/**
 * A task a human has to release: claimed, failed once, parked by the hub.
 * Each one gets its own env — `claimNextTask` is oldest-first, so sharing an
 * env would have a test claim a task left PENDING by the previous one.
 */
async function blockedTask(title: string): Promise<AgentTask> {
  const env = `${ENV}-${title}`;
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: ctx.auth,
    payload: {
      env,
      projectName: 'pte-dojo',
      title,
      instruction: '按现有 hook 风格实现。',
    },
  });
  const task = (created.json() as { task: AgentTask }).task;
  const id = Number(task.id);

  expect(ctx.app.repo.claimNextTask(env)?.id).toBe(task.id);
  ctx.app.repo.completeTask(id, { status: 'FAILED', result: '编译不过' });
  const blocked = ctx.app.repo.blockTask(id);
  expect(blocked?.status).toBe('BLOCKED');
  return blocked!;
}

async function logsFor(id: string): Promise<TaskLog[]> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/tasks/${id}/logs`,
    headers: ctx.auth,
  });
  return (response.json() as { logs: TaskLog[] }).logs;
}

function tokenFor(taskId: string, ttlMs = 60_000): string {
  return buildTaskApprovalToken(taskId, Date.now() + ttlMs, SECRET);
}

describe('signed task page', () => {
  it('P1: shows the stuck task and the one action it offers', async () => {
    const task = await blockedTask('P1 任务');
    ctx.app.repo.appendTaskLog(Number(task.id), {
      stream: 'system',
      chunk: '总管：三轮都在同一个用例上打转',
      diagnosis: '三轮都在同一个用例上打转',
      errorSignature: 'TS2322 src/page.ts',
    });

    const page = await ctx.app.inject({
      method: 'GET',
      url: `/t/${tokenFor(task.id)}`,
    });

    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('P1 任务');
    expect(page.body).toContain('三轮都在同一个用例上打转');
    expect(page.body).toContain('TS2322 src/page.ts');
    expect(page.body).toContain('批 准 继 续');
  });

  it('P2: an expired link says so and changes nothing', async () => {
    const task = await blockedTask('P2 任务');

    const page = await ctx.app.inject({
      method: 'GET',
      url: `/t/${tokenFor(task.id, -1)}`,
    });
    expect(page.statusCode).toBe(410);
    expect(page.body).toContain('链接已失效');
    expect(ctx.app.repo.getTask(Number(task.id))?.status).toBe('BLOCKED');
  });

  it('P3: releasing re-queues the task and writes the human line', async () => {
    const task = await blockedTask('P3 任务');

    const released = await ctx.app.inject({
      method: 'POST',
      url: `/t/${tokenFor(task.id)}/release`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(released.statusCode).toBe(200);
    expect(released.body).toContain('已放行');

    expect(ctx.app.repo.getTask(Number(task.id))).toMatchObject({
      status: 'PENDING',
      retryCount: 0,
    });
    expect((await logsFor(task.id)).at(-1)?.chunk).toBe(
      '人工放行：重新排队，自愈次数归零',
    );
  });

  it('P4: the same link cannot release twice', async () => {
    const task = await blockedTask('P4 任务');
    const token = tokenFor(task.id);

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/t/${token}/release`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(first.statusCode).toBe(200);

    const second = await ctx.app.inject({
      method: 'POST',
      url: `/t/${token}/release`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(second.statusCode).toBe(409);
    expect(second.body).toContain('这桩活已处理');
    // The second visit must not undo the first one.
    expect(ctx.app.repo.getTask(Number(task.id))?.status).toBe('PENDING');

    const page = await ctx.app.inject({ method: 'GET', url: `/t/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('这桩活不用放行');
  });

  it('P5: a ticket link is not a task link, either way round', async () => {
    const task = await blockedTask('P5 任务');

    const asTask = await ctx.app.inject({
      method: 'GET',
      url: `/t/${buildApprovalToken('900', Date.now() + 60_000, SECRET)}`,
    });
    expect(asTask.statusCode).toBe(410);
    expect(ctx.app.repo.getTask(Number(task.id))?.status).toBe('BLOCKED');

    const asTicket = await ctx.app.inject({
      method: 'GET',
      url: `/a/${tokenFor(task.id)}`,
    });
    expect(asTicket.statusCode).toBe(410);
  });

  it('P6: a release note is kept verbatim in the log line', async () => {
    const task = await blockedTask('P6 任务');

    const released = await ctx.app.inject({
      method: 'POST',
      url: `/t/${tokenFor(task.id)}/release`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'customInstruction=%E5%85%88%E5%8F%AA%E9%87%8D%E8%B7%91%20e2e',
    });
    expect(released.statusCode).toBe(200);
    expect((await logsFor(task.id)).at(-1)?.chunk).toBe(
      '人工放行：先只重跑 e2e',
    );
  });

  it('P7: the signature is the whole credential — no API token is asked for', async () => {
    const task = await blockedTask('P7 任务');

    const page = await ctx.app.inject({
      method: 'GET',
      url: `/t/${tokenFor(task.id)}`,
    });
    expect(page.statusCode).toBe(200);

    const released = await ctx.app.inject({
      method: 'POST',
      url: `/t/${tokenFor(task.id)}/release`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(released.statusCode).toBe(200);
    expect(ctx.app.repo.getTask(Number(task.id))?.status).toBe('PENDING');
  });

  it('P8: a forged token is refused and a missing task is named', async () => {
    const task = await blockedTask('P8 任务');
    const token = tokenFor(task.id);
    const tampered = `${token.slice(0, -2)}xx`;

    const refused = await ctx.app.inject({
      method: 'POST',
      url: `/t/${tampered}/release`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(refused.statusCode).toBe(410);
    expect(ctx.app.repo.getTask(Number(task.id))?.status).toBe('BLOCKED');

    const gone = await ctx.app.inject({
      method: 'GET',
      url: `/t/${tokenFor('99999')}`,
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.body).toContain('任务不存在');
  });
});
