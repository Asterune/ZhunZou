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

  it('exchanges a code for a scoped token exactly once', async () => {
    const ctx = await createTestContext();
    try {
      const created = await createCode(ctx);
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

      // A code is single-use.
      const replay = await redeem(ctx, { code: created.enrollment.code });
      expect(replay.statusCode).toBe(404);
    } finally {
      await ctx.close();
    }
  });

  it('respects the env bound to the code and suffixes collisions', async () => {
    const ctx = await createTestContext();
    try {
      const first = await createCode(ctx, { env: 'company-windows' });
      const one = await redeem(ctx, {
        code: first.enrollment.code,
        env: 'ignored-by-server',
        host: 'lq',
        kind: 'other',
      });
      expect(one.statusCode).toBe(200);
      expect((one.json() as EnrollResponse).env).toBe('company-windows');

      const second = await createCode(ctx, { env: 'company-windows' });
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

  it('rejects unknown and expired codes', async () => {
    const ctx = await createTestContext();
    try {
      const invalid = await redeem(ctx, { code: 'AAAAA-BBBBB' });
      expect(invalid.statusCode).toBe(404);
      expect(invalid.json().error.code).toBe('ENROLLMENT_INVALID');

      const created = await createCode(ctx, { ttlMinutes: 1 });
      const code = created.enrollment.code;
      const response = await redeem(ctx, { code });
      expect(response.statusCode).toBe(200);
      const replay = await redeem(ctx, { code });
      expect(replay.statusCode).toBe(404);
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
