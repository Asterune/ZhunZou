import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';

import type { NodeProfile } from '@zhunzou/shared';

import { createTestContext, sleep } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

async function waitUntil(
  probe: () => Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await sleep(25);
  }
}

interface RouteNode {
  env: string;
  role: string;
  engines: string[];
  tags: string[];
  repos: Array<{ name: string }>;
  maxConcurrency: number;
  activeCount: number;
  freeMemoryMB?: number;
  online: boolean;
}

async function nodes(ctx: Ctx): Promise<RouteNode[]> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/nodes',
    headers: ctx.auth,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { nodes: RouteNode[] }).nodes;
}

/** Attach a node the way `zz join` does: a WS device socket that reports a profile. */
async function joinNode(
  ctx: Ctx,
  env: string,
  profile: NodeProfile,
): Promise<WebSocket> {
  // A WS device needs a real listener; /api/* still works through inject().
  if (!ctx.app.server.address()) {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  }
  const address = ctx.app.server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');

  const socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/ws/device?env=${env}`,
    { headers: ctx.auth },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  socket.send(
    JSON.stringify({
      type: 'hello',
      protocol: 1,
      env,
      capabilities: {
        protocol: 1,
        os: 'darwin',
        arch: 'arm64',
        hostname: profile.hostname,
        machineId: `machine-${env}`,
        tools: [],
        features: ['ws', 'heartbeat'],
      },
      profile,
    }),
  );

  await waitUntil(async () =>
    (await nodes(ctx)).some((item) => item.env === env),
  );
  return socket;
}

function profile(overrides: Partial<NodeProfile> = {}): NodeProfile {
  return {
    nodeId: 'ignored-by-the-hub',
    hostname: 'studio-mini',
    role: 'worker',
    tags: [],
    maxConcurrency: 1,
    repos: [{ name: 'pte-dojo', path: '/Users/qiliu/code/pte-dojo' }],
    freeMemoryMB: 8192,
    ...overrides,
  };
}

async function dispatch(
  ctx: Ctx,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/tasks/dispatch',
    headers: ctx.auth,
    payload,
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

describe('GET /api/nodes', () => {
  it('shows the machine facts a dispatch routes on', async () => {
    const ctx = await createTestContext();
    const socket = await joinNode(
      ctx,
      'mini-1',
      profile({ tags: ['office'], maxConcurrency: 3, freeMemoryMB: 6144 }),
    );

    try {
      const [node] = await nodes(ctx);
      expect(node).toMatchObject({
        env: 'mini-1',
        role: 'worker',
        engines: ['other'],
        tags: ['office'],
        maxConcurrency: 3,
        activeCount: 0,
        freeMemoryMB: 6144,
        online: true,
      });
      expect(node?.repos[0]?.name).toBe('pte-dojo');
    } finally {
      socket.close();
      await ctx.close();
    }
  });

  it('is admin-only', async () => {
    const ctx = await createTestContext();
    try {
      const response = await ctx.app.inject({ method: 'GET', url: '/api/nodes' });
      expect(response.statusCode).toBe(401);
    } finally {
      await ctx.close();
    }
  });
});

describe('POST /api/tasks/dispatch', () => {
  it('picks the node that has the checkout instead of asking the human', async () => {
    const ctx = await createTestContext();
    const crawler = await joinNode(
      ctx,
      'mini-crawler',
      profile({ hostname: 'crawler-box', repos: [{ name: 'pte-crawler', path: '/srv/pte-crawler' }] }),
    );
    const dojo = await joinNode(
      ctx,
      'mini-dojo',
      profile({ hostname: 'dojo-box', repos: [{ name: 'pte-dojo', path: '/srv/pte-dojo' }] }),
    );

    try {
      const result = await dispatch(ctx, {
        repoName: 'pte-dojo',
        title: '把题库列表接上分页',
        instruction: '沿用现有 hook 风格，补一条单测。',
      });

      expect(result.status).toBe(201);
      const task = result.body.task as {
        id: string;
        env: string;
        repoName: string;
        origin: string;
      };
      expect(task).toMatchObject({
        env: 'mini-dojo',
        repoName: 'pte-dojo',
        origin: 'HUB_DISPATCH',
      });
      expect(result.body.route).toMatchObject({ env: 'mini-dojo' });

      // The routed task is now the one the winning node will be handed.
      const claimed = await ctx.app.inject({
        method: 'GET',
        url: '/api/tasks/next?env=mini-dojo&timeout=100',
        headers: ctx.auth,
      });
      expect((claimed.json() as { task: { id: string } }).task?.id).toBe(task.id);
    } finally {
      crawler.close();
      dojo.close();
      await ctx.close();
    }
  });

  it('refuses when no node can run it and says why', async () => {
    const ctx = await createTestContext();
    const socket = await joinNode(
      ctx,
      'mini-1',
      profile({ freeMemoryMB: 1024, repos: [] }),
    );

    try {
      const result = await dispatch(ctx, {
        repoName: 'pte-dojo',
        title: '整理 CHANGELOG',
        instruction: '按提交汇总。',
      });

      expect(result.status).toBe(409);
      expect((result.body.error as { message: string }).message).toContain('no node fits');
    } finally {
      socket.close();
      await ctx.close();
    }
  });

  it('honours an explicit env pin and records the caller decided it', async () => {
    const ctx = await createTestContext();
    const socket = await joinNode(ctx, 'mini-1', profile());

    try {
      const result = await dispatch(ctx, {
        env: 'mini-1',
        repoName: 'pte-dojo',
        title: '修复导出乱码',
        instruction: '定位编码问题并修复。',
        managedBySupervisor: true,
      });

      expect(result.status).toBe(201);
      const task = result.body.task as { env: string; managedBySupervisor: boolean };
      expect(task).toMatchObject({ env: 'mini-1', managedBySupervisor: true });
      expect(result.body.route).toMatchObject({ env: 'mini-1', pinned: true });
    } finally {
      socket.close();
      await ctx.close();
    }
  });

  it('will not pin a task to an identity the hub has never seen', async () => {
    const ctx = await createTestContext();
    try {
      const result = await dispatch(ctx, {
        env: 'ghost-box',
        title: '任何工作',
        instruction: '派给一台不存在的机器。',
      });

      expect(result.status).toBe(409);
      expect((result.body.error as { message: string }).message).toContain('ghost-box');
    } finally {
      await ctx.close();
    }
  });

  it('asks for a repo or an env instead of guessing', async () => {
    const ctx = await createTestContext();
    try {
      const result = await dispatch(ctx, {
        title: '任何工作',
        instruction: '既没有仓库也没有指定节点。',
      });

      expect(result.status).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it('does not hand work to a node that is full', async () => {
    const ctx = await createTestContext();
    const socket = await joinNode(ctx, 'busy-mini', profile({ maxConcurrency: 1 }));

    try {
      const first = await dispatch(ctx, {
        env: 'busy-mini',
        repoName: 'pte-dojo',
        title: '接入统一错误处理',
        instruction: '先做拦截层。',
      });
      expect(first.status).toBe(201);

      const second = await dispatch(ctx, {
        repoName: 'pte-dojo',
        title: '补全埋点',
        instruction: '在页面挂载处上报。',
      });

      expect(second.status).toBe(409);
      expect((second.body.error as { message: string }).message).toContain('at capacity');
    } finally {
      socket.close();
      await ctx.close();
    }
  });
});
