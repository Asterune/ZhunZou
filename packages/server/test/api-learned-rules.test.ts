import { describe, expect, it } from 'vitest';

import { createTestContext } from './helpers.js';

type Rule = {
  id: string;
  pattern: string;
  patternType: string;
  action: string;
  kind?: string;
  source: string;
  enabled: boolean;
  hits: number;
  note?: string;
};

async function list(ctx: Awaited<ReturnType<typeof createTestContext>>, query = ''): Promise<Rule[]> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/learned-rules${query}`,
    headers: ctx.auth,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { rules: Rule[] }).rules;
}

describe('learned rule routes', () => {
  it('grants an allowance with nothing but the pattern', async () => {
    const ctx = await createTestContext();
    try {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/learned-rules',
        headers: ctx.auth,
        payload: { pattern: 'pnpm deploy:*', note: '预发部署，只碰 staging' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json() as Rule).toMatchObject({
        pattern: 'pnpm deploy:*',
        patternType: 'glob',
        action: 'ALLOW',
        source: 'HUMAN_APPROVAL',
        enabled: true,
        hits: 0,
        note: '预发部署，只碰 staging',
      });
    } finally {
      await ctx.close();
    }
  });

  it('updates the same allowance instead of stacking copies', async () => {
    const ctx = await createTestContext();
    try {
      for (const source of ['HUMAN_APPROVAL', 'RULE_DISTILLER']) {
        const response = await ctx.app.inject({
          method: 'POST',
          url: '/api/learned-rules',
          headers: ctx.auth,
          payload: { pattern: 'terraform plan', patternType: 'exact', action: 'ALLOW', source },
        });
        expect(response.statusCode).toBe(201);
      }
      const stored = await list(ctx, '?action=ALLOW');
      expect(stored.filter((rule) => rule.pattern === 'terraform plan')).toHaveLength(1);
      expect(stored.find((rule) => rule.pattern === 'terraform plan')?.source).toBe('RULE_DISTILLER');
    } finally {
      await ctx.close();
    }
  });

  it('refuses a rule the engine could never apply', async () => {
    const ctx = await createTestContext();
    try {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/learned-rules',
        headers: ctx.auth,
        payload: { pattern: 'rm (', patternType: 'regex', action: 'ALLOW', source: 'SEED' },
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it('filters the list by what is still in force', async () => {
    const ctx = await createTestContext();
    try {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/learned-rules',
        headers: ctx.auth,
        payload: { pattern: 'git push*', action: 'DENY', source: 'SEED' },
      });
      const allowed = await ctx.app.inject({
        method: 'POST',
        url: '/api/learned-rules',
        headers: ctx.auth,
        payload: { pattern: 'ls *', action: 'ALLOW', source: 'SEED' },
      });
      expect(allowed.statusCode).toBe(201);

      expect((await list(ctx)).map((rule) => rule.action)).toEqual(
        expect.arrayContaining(['ALLOW', 'DENY']),
      );
      expect((await list(ctx, '?action=DENY')).map((rule) => rule.pattern)).toEqual(['git push*']);

      const id = (allowed.json() as { id: string }).id;
      await ctx.app.inject({
        method: 'PATCH',
        url: `/api/learned-rules/${id}`,
        headers: ctx.auth,
        payload: { enabled: false },
      });
      expect((await list(ctx, '?enabledOnly=true')).map((rule) => rule.id)).not.toContain(id);
      // The switch has to read the way it is spelled: `false` means "show me
      // everything", not "the same thing again".
      expect((await list(ctx, '?enabledOnly=false')).length).toBe((await list(ctx)).length);
      expect((await list(ctx)).find((rule) => rule.id === id)).toMatchObject({ enabled: false });
    } finally {
      await ctx.close();
    }
  });

  it('switches a single rule and reports one it has never heard of', async () => {
    const ctx = await createTestContext();
    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/learned-rules',
        headers: ctx.auth,
        payload: { pattern: 'docker compose up*', action: 'ALLOW', kind: 'command', source: 'SEED' },
      });
      const id = (created.json() as { id: string }).id;

      const patched = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/learned-rules/${id}`,
        headers: ctx.auth,
        payload: { enabled: false },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json() as Rule).toMatchObject({ id, enabled: false, kind: 'command' });

      const missing = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/learned-rules/lr-nope',
        headers: ctx.auth,
        payload: { enabled: false },
      });
      expect(missing.statusCode).toBe(404);

      const bad = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/learned-rules/${id}`,
        headers: ctx.auth,
        payload: {},
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it('keeps the allowance table out of agent hands', async () => {
    const ctx = await createTestContext();
    try {
      const issued = await ctx.app.inject({
        method: 'POST',
        url: '/api/agents/rule-writer/token',
        headers: ctx.auth,
      });
      const agent = { authorization: `Bearer ${(issued.json() as { token: string }).token}` };

      for (const call of [
        { method: 'GET' as const, url: '/api/learned-rules' },
        { method: 'POST' as const, url: '/api/learned-rules', payload: { pattern: 'ls *' } },
        { method: 'PATCH' as const, url: '/api/learned-rules/lr-x', payload: { enabled: false } },
      ]) {
        const response = await ctx.app.inject({ ...call, headers: agent });
        expect(response.statusCode, call.url).toBe(403);
      }
    } finally {
      await ctx.close();
    }
  });
});
