import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SyncResponse } from '@zhunzou/shared';

import {
  createTestContext,
  sleep,
  ticketInput,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

async function sync(
  after: number,
  timeout: number,
): Promise<SyncResponse> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/sync?after=${after}&timeout=${timeout}`,
    headers: ctx.auth,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as SyncResponse;
}

describe('GET /api/sync', () => {
  it('returns a full dashboard snapshot for a new client', async () => {
    const body = await sync(0, 0);

    expect(body.changed).toBe(true);
    expect(body.rev).toBeGreaterThan(0);
    expect(body.state).toBeDefined();
    expect(Array.isArray(body.state?.tickets)).toBe(true);
    expect(Array.isArray(body.state?.tasks)).toBe(true);
    expect(Array.isArray(body.state?.envs)).toBe(true);
    expect(Array.isArray(body.state?.agents)).toBe(true);
    expect(Array.isArray(body.state?.projects)).toBe(true);
    expect(Array.isArray(body.state?.exchanges)).toBe(true);
  });

  it('reports "unchanged" on a clean timeout', async () => {
    const first = await sync(0, 0);
    const second = await sync(first.rev, 80);

    expect(second.changed).toBe(false);
    expect(second.state).toBeUndefined();
    expect(second.rev).toBe(first.rev);
  });

  it('wakes a waiting client when dashboard data changes', async () => {
    const first = await sync(0, 0);
    const ticketCount = first.state?.tickets.length ?? 0;

    // Start the long poll first, then mutate while it is held open. The
    // server-side fingerprint ticker should wake it within ~1s.
    const polling = sync(first.rev, 5_000);
    await sleep(200);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: ctx.auth,
      payload: ticketInput({ env: 'sync-env', projectName: 'sync-project' }),
    });
    expect(created.statusCode).toBe(201);

    const body = await polling;
    expect(body.changed).toBe(true);
    expect(body.rev).toBeGreaterThan(first.rev);
    expect((body.state?.tickets.length ?? 0)).toBe(ticketCount + 1);
  });

  it('requires the admin token', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/sync?after=0&timeout=0',
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a timeout above the proxy budget', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/sync?after=0&timeout=999999',
      headers: ctx.auth,
    });
    expect(response.statusCode).toBe(400);
  });
});
