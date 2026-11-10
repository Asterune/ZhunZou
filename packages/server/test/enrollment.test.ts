import { describe, expect, it } from 'vitest';

import type {
  Agent,
  EnrollResponse,
  EnrollmentResponse,
} from '@zhunzou/shared';

import { createTestContext } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

async function createCode(
  ctx: Ctx,
  payload: Record<string, unknown> = {},
): Promise<EnrollmentResponse> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/enrollments',
    headers: ctx.auth,
    payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as EnrollmentResponse;
}

async function redeem(ctx: Ctx, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/enroll',
    payload,
  });
}

describe('one-click enrollment', () => {
  it('creates a code and a matching one-line command', async () => {
    const ctx = await createTestContext();
    try {
      const created = await createCode(ctx, { label: '公司的 Windows' });
      expect(created.enrollment.code).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
      expect(created.enrollment.expiresAt).toBeGreaterThan(Date.now());
      expect(created.commands.unix).toContain(
        `/install.sh?code=${created.enrollment.code}`,
      );
      expect(created.commands.windows).toContain(
        `/install.ps1?code=${created.enrollment.code}`,
      );
    } finally {
      await ctx.close();
    }
  });

  it('exchanges a code for a scoped token exactly once when maxUses is 1', async () => {
    const ctx = await createTestContext();
    try {
      const created = await createCode(ctx, { maxUses: 1 });
      const response = await redeem(ctx, {
        code: created.enrollment.code,
        host: 'lq-desktop',
        os: 'win32-x64',
        kind: 'cursor',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as EnrollResponse;
      expect(body.token.startsWith('zz_')).toBe(true);
      expect(body.env).toBe('cursor-lq-desktop');
      expect(body.agent).toMatchObject({
        env: 'cursor-lq-desktop',
        kind: 'cursor',
        host: 'lq-desktop',
        os: 'win32-x64',
      });

      // The scoped token works for its own env but cannot administer agents.
      const agentAuth = { authorization: `Bearer ${body.token}` };
      const beat = await ctx.app.inject({
        method: 'POST',
        url: '/api/status/heartbeat',
        headers: agentAuth,
        payload: { env: body.env, status: 'Idle' },
      });
      expect(beat.statusCode).toBe(200);

      const forbidden = await ctx.app.inject({
        method: 'GET',
        url: '/api/agents',
        headers: agentAuth,
      });
      expect(forbidden.statusCode).toBe(403);

      // maxUses:1 keeps this code strictly single-use.
      const replay = await redeem(ctx, { code: created.enrollment.code });
      expect(replay.statusCode).toBe(410);
      expect(replay.json().error.code).toBe('ENROLLMENT_USED');
    } finally {
      await ctx.close();
    }
  });

  it('enrolls several clients on one machine from a single code', async () => {
    const ctx = await createTestContext();
    try {
      const created = await createCode(ctx, { maxUses: 6 });
      const kinds = [
        ['cursor', 'cursor-win'],
        ['opencode', 'opencode-win'],
        ['claude-code', 'claude-win'],
        ['codex', 'codex-win'],
        ['qoder', 'qoder-win'],
      ] as const;

      const envs: string[] = [];
      for (const [kind, env] of kinds) {
        const response = await redeem(ctx, {
          code: created.enrollment.code,
          host: 'lq-desktop',
          os: 'win32-x64',
          kind,
          env,
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as EnrollResponse;
        expect(body.env).toBe(env);
        expect(body.agent.kind).toBe(kind);
        expect(body.token.startsWith('zz_')).toBe(true);
        envs.push(body.env);
      }
      expect(new Set(envs).size).toBe(5);

      // Host comparison is case-insensitive: macOS reports
      // `QideMacBook-Pro.local`, a shell may send `qidemacbook-pro.local`.
      const sameHost = await redeem(ctx, {
        code: created.enrollment.code,
        host: 'LQ-DESKTOP',
        kind: 'gemini',
        env: 'gemini-win',
      });
      expect(sameHost.statusCode).toBe(200);

      // The budget is per code, and the code stays bound to the first host.
      const extra = await redeem(ctx, {
        code: created.enrollment.code,
        host: 'lq-desktop',
        kind: 'windsurf',
        env: 'windsurf-win',
      });
      expect(extra.statusCode).toBe(410);
      expect(extra.json().error.code).toBe('ENROLLMENT_USED');

      const otherHost = await createCode(ctx, { maxUses: 4 });
      await redeem(ctx, {
        code: otherHost.enrollment.code,
        host: 'lq-desktop',
        kind: 'cursor',
        env: 'cursor-lq',
      });
      const hijack = await redeem(ctx, {
        code: otherHost.enrollment.code,
        host: 'someone-else',
        kind: 'opencode',
        env: 'opencode-lq',
      });
      expect(hijack.statusCode).toBe(403);
      expect(hijack.json().error.code).toBe('ENROLLMENT_HOST_MISMATCH');
    } finally {
      await ctx.close();
    }
  });

  it('re-running the installer refreshes the same envs without spending slots', async () => {
    const ctx = await createTestContext();
    try {
      const created = await createCode(ctx, { maxUses: 2 });
      const enroll = async (env: string) => {
        const response = await redeem(ctx, {
          code: created.enrollment.code,
          host: 'lq-desktop',
          kind: 'cursor',
          env,
        });
        expect(response.statusCode).toBe(200);
        return response.json() as EnrollResponse;
      };

      const first = await enroll('cursor-lq');
      const again = await enroll('cursor-lq');
      expect(again.env).toBe(first.env);
      expect(again.token).not.toBe(first.token);

      // A repeat does not burn the budget: one slot is still available.
      const second = await enroll('cursor-lq-two');
      expect(second.env).toBe('cursor-lq-two');

      const agents = await ctx.app.inject({
        method: 'GET',
        url: '/api/agents',
        headers: ctx.auth,
      });
      expect(
        (agents.json().agents as Agent[]).map((agent) => agent.env).sort(),
      ).toEqual(['cursor-lq', 'cursor-lq-two']);
    } finally {
      await ctx.close();
    }
  });

  it('splits a bound env per client when the code has several slots', async () => {
    const ctx = await createTestContext();
    try {
      const created = await createCode(ctx, { env: '公司', maxUses: 6 });
      const enroll = async (kind: string) => {
        const response = await redeem(ctx, {
          code: created.enrollment.code,
          host: 'lq-desktop',
          kind,
        });
        expect(response.statusCode).toBe(200);
        return (response.json() as EnrollResponse).env;
      };

      expect(await enroll('cursor')).toBe('公司-cursor');
      expect(await enroll('opencode')).toBe('公司-opencode');
      expect(await enroll('claude-code')).toBe('公司-claude');
      expect(await enroll('codex')).toBe('公司-codex');
      expect(await enroll('qoder')).toBe('公司-qoder');
      // Same client again: same env, not `公司-cursor-2`.
      expect(await enroll('cursor')).toBe('公司-cursor');
    } finally {
      await ctx.close();
    }
  });

  it('respects the env bound to the code and suffixes collisions', async () => {
    const ctx = await createTestContext();
    try {
      const first = await createCode(ctx, { env: 'company-windows', maxUses: 1 });
      const one = await redeem(ctx, {
        code: first.enrollment.code,
        env: 'ignored-by-server',
        host: 'lq',
        kind: 'other',
      });
      expect(one.statusCode).toBe(200);
      expect((one.json() as EnrollResponse).env).toBe('company-windows');

      const second = await createCode(ctx, { env: 'company-windows', maxUses: 1 });
      const two = await redeem(ctx, {
        code: second.enrollment.code,
        host: 'lq',
        kind: 'other',
      });
      expect(two.statusCode).toBe(200);
      expect((two.json() as EnrollResponse).env).toBe('company-windows-2');

      const agents = await ctx.app.inject({
        method: 'GET',
        url: '/api/agents',
        headers: ctx.auth,
      });
      expect(
        (agents.json().agents as Agent[]).map((agent) => agent.env).sort(),
      ).toEqual(['company-windows', 'company-windows-2']);
    } finally {
      await ctx.close();
    }
  });

  it('rejects unknown codes and codes that are already used up', async () => {
    const ctx = await createTestContext();
    try {
      const invalid = await redeem(ctx, { code: 'AAAAA-BBBBB' });
      expect(invalid.statusCode).toBe(404);
      expect(invalid.json().error.code).toBe('ENROLLMENT_INVALID');

      const created = await createCode(ctx, { ttlMinutes: 1, maxUses: 1 });
      const code = created.enrollment.code;
      const response = await redeem(ctx, { code });
      expect(response.statusCode).toBe(200);
      const replay = await redeem(ctx, { code });
      expect(replay.statusCode).toBe(410);
    } finally {
      await ctx.close();
    }
  });

  it('serves install scripts that embed the hub origin and code', async () => {
    const ctx = await createTestContext();
    try {
      const sh = await ctx.app.inject({
        method: 'GET',
        url: '/install.sh?code=ABCDE-FGHIJ',
      });
      expect(sh.statusCode).toBe(200);
      expect(sh.headers['content-type']).toContain('application/x-sh');
      expect(sh.body).toContain('ABCDE-FGHIJ');
      expect(sh.body).toContain('/api/bridge/latest');

      const ps1 = await ctx.app.inject({
        method: 'GET',
        url: '/install.ps1?code=ABCDE-FGHIJ',
      });
      expect(ps1.statusCode).toBe(200);
      expect(ps1.body).toContain('ABCDE-FGHIJ');
      expect(ps1.body).toContain('Invoke-RestMethod');
    } finally {
      await ctx.close();
    }
  });
});
