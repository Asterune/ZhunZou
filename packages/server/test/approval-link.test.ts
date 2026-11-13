import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentTask, DecisionTicket } from '@zhunzou/shared';

import {
  buildApprovalToken,
  buildApprovalUrl,
  buildTaskApprovalToken,
  buildTaskApprovalUrl,
  renderApprovalPage,
  renderTaskApprovalPage,
  verifyApprovalToken,
  verifyTaskApprovalToken,
} from '../src/approval-link.js';
import {
  createTestContext,
  ticketInput,
  type TestContext,
} from './helpers.js';

const SECRET = 'link-secret';
const BASE = 'https://hub.example.com';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext(undefined, undefined, {
    APPROVAL_LINK_SECRET: SECRET,
    PUBLIC_BASE_URL: BASE,
    AUTO_RESOLVE_TIMEOUT_MS: '0',
  });
});

afterAll(async () => {
  await ctx.close();
});

function tokenFor(ticketId: string, ttlMs = 60_000): string {
  return buildApprovalToken(ticketId, Date.now() + ttlMs, SECRET);
}

async function createTicket(
  overrides: Parameters<typeof ticketInput>[0] = {},
): Promise<DecisionTicket> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tickets',
    headers: ctx.auth,
    payload: ticketInput(overrides),
  });
  expect(response.statusCode).toBe(201);
  return response.json().ticket as DecisionTicket;
}

describe('approval token', () => {
  it('round-trips and rejects tampering or expiry', () => {
    const token = buildApprovalToken('104', 10_000, SECRET);
    expect(verifyApprovalToken(token, SECRET, 9_000)).toMatchObject({
      ticketId: '104',
      expiresAt: 10_000,
    });
    expect(verifyApprovalToken(token, SECRET, 10_001)).toBeNull();
    expect(verifyApprovalToken(token, 'wrong-secret', 9_000)).toBeNull();
    expect(verifyApprovalToken(`${token}x`, SECRET, 9_000)).toBeNull();
    expect(verifyApprovalToken('not-a-token', SECRET, 9_000)).toBeNull();
  });

  it('builds an absolute URL without duplicate slashes', () => {
    expect(buildApprovalUrl('https://hub.example.com/', 'abc')).toBe(
      'https://hub.example.com/a/abc',
    );
  });

  it('escapes ticket content in the rendered page', () => {
    const ticket = createTicketFixture();
    const html = renderApprovalPage(ticket, 'tok', BASE);

    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain(`${BASE}/a/tok/resolve`);
    expect(html).toContain('高风险');
  });
});

function createTicketFixture(): DecisionTicket {
  return {
    id: '104',
    env: 'company-cursor',
    projectName: 'yikuaomed-erp',
    status: 'PENDING_HUMAN',
    doneSummary: '完成登录页',
    blockerQuestion: '<script>alert(1)</script> Toast 还是行内？',
    nextStepPlan: '接入错误处理',
    options: [
      { key: 'A', label: 'Toast', risk: 'safe' },
      { key: 'B', label: '删除数据', risk: 'destructive' },
    ],
    recommendedOption: 'A',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('signed approval page', () => {
  it('renders the ticket and resolves it from a plain HTML form', async () => {
    const ticket = await createTicket({ projectName: 'approval-page' });
    const token = tokenFor(ticket.id);

    const page = await ctx.app.inject({
      method: 'GET',
      url: `/a/${token}`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('approval-page');
    expect(page.body).toContain('Toast 提示');

    const resolved = await ctx.app.inject({
      method: 'POST',
      url: `/a/${token}/resolve`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'selectedOption=B&customInstruction=%E5%85%88%E5%8F%AA%E6%94%B9%E7%99%BB%E5%BD%95%E9%A1%B5',
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.body).toContain('已准奏');

    const current = ctx.app.repo.get(Number(ticket.id));
    expect(current).toMatchObject({
      status: 'HUMAN_RESOLVED',
      selectedOption: 'B',
      customInstruction: '先只改登录页',
      resolvedBy: 'HUMAN',
    });
  });

  it('rejects expired and tampered links', async () => {
    const ticket = await createTicket({ projectName: 'approval-expired' });

    const expired = await ctx.app.inject({
      method: 'GET',
      url: `/a/${tokenFor(ticket.id, -1)}`,
    });
    expect(expired.statusCode).toBe(410);
    expect(expired.body).toContain('链接已失效');

    const tampered = await ctx.app.inject({
      method: 'GET',
      url: `/a/${tokenFor(ticket.id)}x`,
    });
    expect(tampered.statusCode).toBe(410);
  });

  it('requires the destructive confirmation checkbox', async () => {
    const ticket = await createTicket({
      projectName: 'approval-destructive',
      options: [
        { key: 'A', label: '安全方案' },
        { key: 'B', label: '清空数据', risk: 'destructive' },
      ],
      recommendedOption: 'A',
    });
    const token = tokenFor(ticket.id);

    const refused = await ctx.app.inject({
      method: 'POST',
      url: `/a/${token}/resolve`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'selectedOption=B',
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('高风险');

    const accepted = await ctx.app.inject({
      method: 'POST',
      url: `/a/${token}/resolve`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'selectedOption=B&confirmDestructive=true',
    });
    expect(accepted.statusCode).toBe(200);
    expect(ctx.app.repo.get(Number(ticket.id))?.selectedOption).toBe('B');
  });

  it('cannot be used twice after the ticket is finalized', async () => {
    const ticket = await createTicket({ projectName: 'approval-twice' });
    const token = tokenFor(ticket.id);

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/a/${token}/resolve`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'selectedOption=A',
    });
    expect(first.statusCode).toBe(200);

    const second = await ctx.app.inject({
      method: 'POST',
      url: `/a/${token}/resolve`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'selectedOption=A',
    });
    expect(second.statusCode).toBe(409);
  });
});

const stoppedTask: AgentTask = {
  id: '77',
  env: 'desk-b',
  projectName: 'pte-dojo',
  title: '修好登录页的单测',
  instruction: '跑测试并修',
  status: 'BLOCKED',
  attempts: 2,
  origin: 'HUB_DISPATCH',
  managedBySupervisor: true,
  retryCount: 3,
  workspacePath: '/repo/.zhunzou/wt/77',
  createdAt: 1,
  updatedAt: 2,
};

describe('signed task link', () => {
  it('round-trips inside its own namespace', () => {
    const token = buildTaskApprovalToken('77', 10_000, SECRET);
    expect(token.split('.')).toHaveLength(4);
    expect(token.split('.')[0]).toBe('task');
    expect(verifyTaskApprovalToken(token, SECRET, 9_000)).toMatchObject({
      taskId: '77',
      expiresAt: 10_000,
    });
    expect(verifyTaskApprovalToken(token, SECRET, 10_001)).toBeNull();
    expect(verifyTaskApprovalToken(token, 'wrong-secret', 9_000)).toBeNull();
    expect(verifyTaskApprovalToken(`${token.slice(0, -1)}x`, SECRET, 9_000)).toBeNull();
    expect(buildTaskApprovalUrl(`${BASE}/`, token)).toBe(`${BASE}/t/${token}`);
  });

  it('cannot be replayed as a ticket link, or the other way round', () => {
    expect(
      verifyApprovalToken(
        buildTaskApprovalToken('77', 10_000, SECRET),
        SECRET,
        9_000,
      ),
    ).toBeNull();
    expect(
      verifyTaskApprovalToken(
        buildApprovalToken('104', 10_000, SECRET),
        SECRET,
        9_000,
      ),
    ).toBeNull();
  });

  it('leaves the ticket token byte-for-byte the format it always was', () => {
    const payload = '104.10000';
    expect(buildApprovalToken('104', 10_000, SECRET)).toBe(
      `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`,
    );
  });

  it('escapes task content and points the form at the release route', () => {
    const html = renderTaskApprovalPage(
      stoppedTask,
      {
        diagnosis: '<script>alert(1)</script> 三轮都在同一个用例上打转',
        errorSignature: 'TS2345',
        branch: 'wip/zz-77',
        workspacePath: '/repo/.zhunzou/wt/<b>77</b>',
      },
      'tok',
      BASE,
    );

    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('/repo/.zhunzou/wt/<b>');
    expect(html).toContain(`${BASE}/t/tok/release`);
    expect(html).toContain('wip/zz-77');
    expect(html).toContain('批 准 继 续');
  });

  it('does not offer a merge action the hub cannot honestly take', () => {
    const html = renderTaskApprovalPage(
      stoppedTask,
      { branch: 'wip/zz-77', workspacePath: '/repo/.zhunzou/wt/77' },
      'tok',
      BASE,
    );

    expect(html).toContain('Hub 不代为执行');
    // One form, and the only thing it can submit is the release.
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).not.toContain('/merge');
    expect(html).not.toContain('/squash');
  });
});
