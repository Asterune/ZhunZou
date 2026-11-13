import { describe, expect, it } from 'vitest';

import type { AgentTask, DecisionTicket } from '@zhunzou/shared';

import type { MetaAgent } from '../src/meta-agent.js';
import { createTestContext, ticketInput } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

/** Records whether the expensive layer was reached at all. */
function spyAgent(): MetaAgent & { calls: number } {
  const agent: MetaAgent & { calls: number } = {
    calls: 0,
    async review() {
      agent.calls += 1;
      return { canResolve: false, reason: '间谍模型不拍板' };
    },
  };
  return agent;
}

const PARK_OPTIONS = [
  { key: 'approve', label: '批准续跑', prosCons: '继续', risk: 'caution' as const },
  { key: 'reject', label: '拒绝', prosCons: '挂起', risk: 'safe' as const },
];

/** A wrapped local run: claimed, and the hub knows its checkout. */
async function registerTask(ctx: Ctx, env: string, workspacePath = '/repo'): Promise<AgentTask> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tasks/local',
    headers: ctx.auth,
    payload: {
      env,
      projectName: 'yikuaomed-erp',
      title: 'cursor-agent -p 修登录页校验',
      instruction: 'cursor-agent -p 修登录页校验',
      engine: 'cursor',
      workspacePath,
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { task: AgentTask }).task;
}

async function reportPermission(ctx: Ctx, taskId: string, action: unknown): Promise<void> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/events`,
    headers: ctx.auth,
    payload: { events: [{ kind: 'permission_required', tool: 'Bash', action }] },
  });
  expect(response.statusCode).toBe(201);
}

async function raiseTicket(
  ctx: Ctx,
  env: string,
  overrides: Partial<Parameters<typeof ticketInput>[0]> = {},
): Promise<DecisionTicket> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tickets',
    headers: ctx.auth,
    payload: ticketInput({ env, options: PARK_OPTIONS, recommendedOption: 'reject', ...overrides }),
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { ticket: DecisionTicket }).ticket;
}

async function readTicket(ctx: Ctx, id: string): Promise<DecisionTicket> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/tickets/${id}`,
    headers: ctx.auth,
  });
  return (response.json() as { ticket: DecisionTicket }).ticket;
}

/** The review runs off the create response, so the caller has to catch up. */
async function settle(ctx: Ctx, id: string): Promise<DecisionTicket> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const ticket = await readTicket(ctx, id);
    if (ticket.status !== 'PENDING_META') return ticket;
    if (Date.now() > deadline) throw new Error(`ticket ${id} never settled`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function addRule(
  ctx: Ctx,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/learned-rules',
    headers: ctx.auth,
    payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

async function rules(ctx: Ctx): Promise<Array<Record<string, unknown>>> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/learned-rules',
    headers: ctx.auth,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { rules: Array<Record<string, unknown>> }).rules;
}

describe('L1 in front of the meta review', () => {
  it('S1 parks a destructive request without waking the model', async () => {
    const agent = spyAgent();
    const ctx = await createTestContext(agent);
    try {
      const task = await registerTask(ctx, 's1-env');
      await reportPermission(ctx, task.id, { kind: 'command', command: 'rm -rf dist' });
      const ticket = await raiseTicket(ctx, 's1-env');

      const settled = await settle(ctx, ticket.id);
      expect(settled.status).toBe('PENDING_HUMAN');
      expect(settled.resolutionReason).toMatch(/^\[L1\]/);
      expect(agent.calls).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it('S2 resolves a read-only request at zero cost', async () => {
    const agent = spyAgent();
    const ctx = await createTestContext(agent);
    try {
      const task = await registerTask(ctx, 's2-env');
      await reportPermission(ctx, task.id, { kind: 'command', command: 'git status --porcelain' });
      const ticket = await raiseTicket(ctx, 's2-env');

      const settled = await settle(ctx, ticket.id);
      expect(settled.status).toBe('AUTO_RESOLVED');
      expect(settled.selectedOption).toBe('approve');
      expect(settled.resolutionReason).toMatch(/^\[L1\]/);
      expect(agent.calls).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it('S3 spends an allowance a human granted and counts the spend', async () => {
    const agent = spyAgent();
    const ctx = await createTestContext(agent);
    try {
      const rule = await addRule(ctx, { pattern: 'pnpm deploy:*', action: 'ALLOW' });
      const task = await registerTask(ctx, 's3-env');
      await reportPermission(ctx, task.id, { kind: 'command', command: 'pnpm deploy:staging' });
      const ticket = await raiseTicket(ctx, 's3-env');

      const settled = await settle(ctx, ticket.id);
      expect(settled.status).toBe('AUTO_RESOLVED');
      expect(agent.calls).toBe(0);

      const [stored] = await rules(ctx);
      expect(stored).toMatchObject({ id: rule.id, hits: 1 });
    } finally {
      await ctx.close();
    }
  });

  it('S4 stops honouring a rule the moment it is switched off', async () => {
    const agent = spyAgent();
    const ctx = await createTestContext(agent);
    try {
      const rule = await addRule(ctx, { pattern: 'pnpm deploy:*', action: 'ALLOW' });
      const off = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/learned-rules/${rule.id}`,
        headers: ctx.auth,
        payload: { enabled: false },
      });
      expect(off.statusCode).toBe(200);

      const task = await registerTask(ctx, 's4-env');
      await reportPermission(ctx, task.id, { kind: 'command', command: 'pnpm deploy:staging' });
      const ticket = await raiseTicket(ctx, 's4-env');

      const settled = await settle(ctx, ticket.id);
      expect(settled.status).toBe('PENDING_HUMAN');
      expect(settled.resolutionReason).not.toMatch(/^\[L1\]/);
      expect(agent.calls).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it('S5 leaves a ticket that no task raised alone', async () => {
    const agent = spyAgent();
    const ctx = await createTestContext(agent);
    try {
      const task = await registerTask(ctx, 's5-env');
      await reportPermission(ctx, task.id, { kind: 'command', command: 'rm -rf dist' });
      await ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/release`,
        headers: ctx.auth,
        payload: { requeue: true, reason: '挂起' },
      });

      const ticket = await raiseTicket(ctx, 's5-env');
      expect(ticket.taskId).toBeUndefined();

      const settled = await settle(ctx, ticket.id);
      expect(settled.status).toBe('PENDING_HUMAN');
      expect(settled.resolutionReason).not.toMatch(/^\[L1\]/);
      expect(agent.calls).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it('S6 will not answer a request that arrived after the ticket was already open', async () => {
    const agent = spyAgent();
    const ctx = await createTestContext(agent);
    try {
      const task = await registerTask(ctx, 's6-env');
      const ticket = await raiseTicket(ctx, 's6-env');
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await reportPermission(ctx, task.id, { kind: 'command', command: 'rm -rf dist' });

      const settled = await settle(ctx, ticket.id);
      expect(settled.resolutionReason).not.toMatch(/^\[L1\]/);
      expect(agent.calls).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it('S7 trusts the workspace on the task over the one the node reports', async () => {
    const agent = spyAgent();
    const ctx = await createTestContext(agent);
    try {
      const task = await registerTask(ctx, 's7-env', '/repo');
      await reportPermission(ctx, task.id, {
        kind: 'command',
        command: 'ls',
        workspaceRoot: '/elsewhere',
      });
      const ticket = await raiseTicket(ctx, 's7-env');

      const settled = await settle(ctx, ticket.id);
      expect(settled.status).toBe('PENDING_HUMAN');
      expect(settled.resolutionReason).toMatch(/^\[L1\]/);
      expect(agent.calls).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it('S8 answers an unrecognised ticket shape with the model, not with a guess', async () => {
    const agent = spyAgent();
    const ctx = await createTestContext(agent);
    try {
      const task = await registerTask(ctx, 's8-env');
      await reportPermission(ctx, task.id, { kind: 'command', command: 'git status' });
      const ticket = await raiseTicket(ctx, 's8-env', {
        options: [
          { key: 'left', label: '走左边' },
          { key: 'right', label: '走右边' },
        ],
        recommendedOption: 'left',
      });

      const settled = await settle(ctx, ticket.id);
      expect(settled.status).toBe('PENDING_HUMAN');
      expect(settled.resolutionReason).not.toMatch(/^\[L1\]/);
      expect(agent.calls).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it('S9 keeps the prose route exactly as it was', async () => {
    const agent = spyAgent();
    const ctx = await createTestContext(agent);
    try {
      const task = await registerTask(ctx, 's9-env');
      await reportPermission(ctx, task.id, { kind: 'command', command: 'rm -rf dist' });

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/decisions',
        headers: ctx.auth,
        payload: {
          env: 's9-env',
          projectName: 'yikuaomed-erp',
          kind: 'action',
          proposal: '删掉 dist 目录重新构建',
        },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json() as { verdict: string; reason: string };
      expect(body.verdict).toBe('PENDING');
      expect(body.reason).not.toMatch(/^\[L1\]/);
    } finally {
      await ctx.close();
    }
  });
});
