import { describe, expect, it } from 'vitest';

import type { Agent, AgentTokenResponse } from '@zhunzou/shared';

import { createTestContext, ticketInput } from './helpers.js';

const ENV = 'home-opencode';
const OTHER = 'company-cursor';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

async function heartbeat(
  ctx: Ctx,
  env: string,
  headers = ctx.auth,
  agent?: Record<string, string>,
) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/status/heartbeat',
    headers,
    payload: { env, status: 'Idle', ...(agent ? { agent } : {}) },
  });
}

async function issueToken(ctx: Ctx, env: string): Promise<string> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/agents/${env}/token`,
    headers: ctx.auth,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as AgentTokenResponse).token;
}

describe('agent registry', () => {
  it('auto-registers an agent from heartbeat metadata', async () => {
    const ctx = await createTestContext();
    try {
      const beat = await heartbeat(ctx, ENV, ctx.auth, {
        kind: 'opencode',
        version: '0.1.0',
        host: 'macbook',
        os: 'darwin-arm64',
      });
      expect(beat.statusCode).toBe(200);

      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/agents',
        headers: ctx.auth,
      });
      expect(response.statusCode).toBe(200);
      const [agent] = response.json().agents as Agent[];
      expect(agent).toMatchObject({
        env: ENV,
        name: ENV,
        kind: 'opencode',
        status: 'active',
        version: '0.1.0',
        host: 'macbook',
        os: 'darwin-arm64',
        online: true,
        hasToken: false,
      });
    } finally {
      await ctx.close();
    }
  });

  it('keeps a specific kind when an older client reports "other"', async () => {
    const ctx = await createTestContext();
    try {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/agents',
        headers: ctx.auth,
        payload: { env: ENV, kind: 'opencode' },
      });

      await heartbeat(ctx, ENV, ctx.auth, { kind: 'other', host: 'macbook' });

      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/agents?status=active`,
        headers: ctx.auth,
      });
      const agent = (response.json().agents as Agent[]).find(
        (item) => item.env === ENV,
      );
      expect(agent?.kind).toBe('opencode');
    } finally {
      await ctx.close();
    }
  });

  it('registers, renames and deletes an agent from the console', async () => {
    const ctx = await createTestContext();
    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/agents',
        headers: ctx.auth,
        payload: {
          env: ENV,
          name: '家里的 OpenCode',
          kind: 'opencode',
          host: 'macbook',
          os: 'darwin-x64',
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().agent).toMatchObject({
        env: ENV,
        name: '家里的 OpenCode',
        kind: 'opencode',
        host: 'macbook',
        os: 'darwin-x64',
      });

      const patched = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/agents/${ENV}`,
        headers: ctx.auth,
        payload: { name: 'Home OpenCode' },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().agent.name).toBe('Home OpenCode');

      const deleted = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/agents/${ENV}`,
        headers: ctx.auth,
      });
      expect(deleted.statusCode).toBe(200);

      const missing = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/agents/${ENV}`,
        headers: ctx.auth,
        payload: { name: 'gone' },
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await ctx.close();
    }
  });

  it('clears presence when an agent is deleted so it leaves the status list', async () => {
    const ctx = await createTestContext();
    try {
      const token = await issueToken(ctx, ENV);
      const agentAuth = { authorization: `Bearer ${token}` };
      expect((await heartbeat(ctx, ENV, agentAuth)).statusCode).toBe(200);

      const before = await ctx.app.inject({
        method: 'GET',
        url: '/api/status',
        headers: ctx.auth,
      });
      expect(
        (before.json().envs as Array<{ env: string }>).map((env) => env.env),
      ).toContain(ENV);

      const deleted = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/agents/${ENV}`,
        headers: ctx.auth,
      });
      expect(deleted.statusCode).toBe(200);

      const after = await ctx.app.inject({
        method: 'GET',
        url: '/api/status',
        headers: ctx.auth,
      });
      expect(
        (after.json().envs as Array<{ env: string }>).some(
          (env) => env.env === ENV,
        ),
      ).toBe(false);

      // The revoked token cannot revive the env with a leftover heartbeat.
      expect((await heartbeat(ctx, ENV, agentAuth)).statusCode).toBe(401);
      const final = await ctx.app.inject({
        method: 'GET',
        url: '/api/status',
        headers: ctx.auth,
      });
      expect(
        (final.json().envs as Array<{ env: string }>).some(
          (env) => env.env === ENV,
        ),
      ).toBe(false);
    } finally {
      await ctx.close();
    }
  });
});

describe('per-agent tokens', () => {
  it('scopes an agent token to its own env', async () => {
    const ctx = await createTestContext();
    try {
      const token = await issueToken(ctx, ENV);
      const agentAuth = { authorization: `Bearer ${token}` };

      // Own env is allowed.
      expect((await heartbeat(ctx, ENV, agentAuth)).statusCode).toBe(200);
      const ownTicket = await ctx.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: agentAuth,
        payload: ticketInput({ env: ENV }),
      });
      expect(ownTicket.statusCode).toBe(201);

      // Any other env is forbidden.
      expect((await heartbeat(ctx, OTHER, agentAuth)).statusCode).toBe(403);
      const foreignTicket = await ctx.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: agentAuth,
        payload: ticketInput({ env: OTHER }),
      });
      expect(foreignTicket.statusCode).toBe(403);

      // Listing is filtered to the agent's own tickets.
      await ctx.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: ctx.auth,
        payload: ticketInput({ env: OTHER }),
      });
      const list = await ctx.app.inject({
        method: 'GET',
        url: '/api/tickets',
        headers: agentAuth,
      });
      expect(list.statusCode).toBe(200);
      expect(
        (list.json().tickets as Array<{ env: string }>).every(
          (ticket) => ticket.env === ENV,
        ),
      ).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it('cannot approve tickets, read other envs, or access admin routes', async () => {
    const ctx = await createTestContext();
    try {
      const token = await issueToken(ctx, ENV);
      const agentAuth = { authorization: `Bearer ${token}` };

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: ctx.auth,
        payload: ticketInput({ env: OTHER }),
      });
      const ticket = created.json().ticket;

      const resolve = await ctx.app.inject({
        method: 'POST',
        url: `/api/tickets/${ticket.id}/resolve`,
        headers: agentAuth,
        payload: { selectedOption: 'A' },
      });
      expect(resolve.statusCode).toBe(403);

      const readForeign = await ctx.app.inject({
        method: 'GET',
        url: `/api/tickets/${ticket.id}`,
        headers: agentAuth,
      });
      expect(readForeign.statusCode).toBe(403);

      for (const [method, url] of [
        ['GET', '/api/status'],
        ['GET', '/api/rules'],
        ['GET', '/api/agents'],
        ['POST', '/api/tasks'],
        ['GET', '/api/tasks'],
      ] as const) {
        const response = await ctx.app.inject({
          method,
          url,
          headers: agentAuth,
          ...(method === 'POST' ? { payload: {} } : {}),
        });
        expect(response.statusCode, `${method} ${url}`).toBe(403);
      }
    } finally {
      await ctx.close();
    }
  });

  it('scopes task claim and completion to the token env', async () => {
    const ctx = await createTestContext();
    try {
      const token = await issueToken(ctx, ENV);
      const agentAuth = { authorization: `Bearer ${token}` };

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: ctx.auth,
        payload: {
          env: ENV,
          projectName: 'zhunzou',
          title: '补充测试',
          instruction: '完成后回报。',
        },
      });
      expect(created.statusCode).toBe(201);

      const wrongEnv = await ctx.app.inject({
        method: 'GET',
        url: `/api/tasks/next?env=${OTHER}&timeout=10`,
        headers: agentAuth,
      });
      expect(wrongEnv.statusCode).toBe(403);

      const claimed = await ctx.app.inject({
        method: 'GET',
        url: `/api/tasks/next?env=${ENV}&timeout=10`,
        headers: agentAuth,
      });
      expect(claimed.statusCode).toBe(200);

      const task = claimed.json().task;
      const done = await ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/complete`,
        headers: agentAuth,
        payload: { status: 'DONE', result: 'ok' },
      });
      expect(done.statusCode).toBe(200);
      expect(done.json().task.status).toBe('DONE');
    } finally {
      await ctx.close();
    }
  });

  it('rotates and revokes tokens; disabled agents are rejected', async () => {
    const ctx = await createTestContext();
    try {
      const first = await issueToken(ctx, ENV);
      expect(first.startsWith('zz_')).toBe(true);

      const second = await issueToken(ctx, ENV);
      expect(second).not.toBe(first);

      const oldToken = await heartbeat(ctx, ENV, {
        authorization: `Bearer ${first}`,
      });
      expect(oldToken.statusCode).toBe(401);

      const newToken = await heartbeat(ctx, ENV, {
        authorization: `Bearer ${second}`,
      });
      expect(newToken.statusCode).toBe(200);

      const disabled = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/agents/${ENV}`,
        headers: ctx.auth,
        payload: { status: 'disabled' },
      });
      expect(disabled.statusCode).toBe(200);

      const rejected = await heartbeat(ctx, ENV, {
        authorization: `Bearer ${second}`,
      });
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json().error.code).toBe('AGENT_DISABLED');

      await ctx.app.inject({
        method: 'PATCH',
        url: `/api/agents/${ENV}`,
        headers: ctx.auth,
        payload: { status: 'active' },
      });

      const revoked = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/agents/${ENV}/token`,
        headers: ctx.auth,
      });
      expect(revoked.statusCode).toBe(200);

      const afterRevoke = await heartbeat(ctx, ENV, {
        authorization: `Bearer ${second}`,
      });
      expect(afterRevoke.statusCode).toBe(401);
    } finally {
      await ctx.close();
    }
  });
});

describe('task lease renewal', () => {
  it('refreshes the lease while the agent reports an active status', async () => {
    const ctx = await createTestContext();
    try {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: ctx.auth,
        payload: {
          env: ENV,
          projectName: 'zhunzou',
          title: '长时间任务',
          instruction: '慢慢做。',
        },
      });

      const claimed = await ctx.app.inject({
        method: 'GET',
        url: `/api/tasks/next?env=${ENV}&timeout=10`,
        headers: ctx.auth,
      });
      const task = claimed.json().task as { id: string; leaseAt: number };
      expect(task.leaseAt).toBeGreaterThan(0);

      await new Promise((resolve) => setTimeout(resolve, 15));
      await ctx.app.inject({
        method: 'POST',
        url: '/api/status/heartbeat',
        headers: ctx.auth,
        payload: { env: ENV, status: 'Running', currentTask: '执行中' },
      });

      const refreshed = ctx.app.repo.getTask(Number(task.id));
      expect(refreshed?.leaseAt).toBeGreaterThan(task.leaseAt);

      // Idle heartbeats must not keep a lost task alive.
      const before = refreshed!.leaseAt!;
      await new Promise((resolve) => setTimeout(resolve, 15));
      await ctx.app.inject({
        method: 'POST',
        url: '/api/status/heartbeat',
        headers: ctx.auth,
        payload: { env: ENV, status: 'Idle' },
      });
      expect(ctx.app.repo.getTask(Number(task.id))?.leaseAt).toBe(before);
    } finally {
      await ctx.close();
    }
  });
});
