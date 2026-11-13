import { describe, expect, it } from 'vitest';

import {
  NODE_HEARTBEAT_TIMEOUT_MS,
  ROUTE_MIN_FREE_MEMORY_MB,
  type Agent,
  type Device,
} from '@zhunzou/shared';

import { routeTask, toRouteCandidates, type RouteCandidate } from '../src/scheduler.js';

const NOW = 1_700_000_000_000;

function candidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    env: 'mac-mini',
    role: 'worker',
    engines: ['opencode'],
    tags: [],
    repos: [{ name: 'pte-dojo', path: '/Users/qiliu/code/pte-dojo' }],
    maxConcurrency: 1,
    activeCount: 0,
    freeMemoryMB: 8192,
    lastSeenAt: NOW - 5_000,
    ...overrides,
  };
}

describe('routeTask', () => {
  it('routes a repo task to the node that has the checkout', () => {
    const decision = routeTask(
      [
        candidate({ env: 'laptop', repos: [{ name: 'pte-crawler', path: '/srv/pte-crawler' }] }),
        candidate({ env: 'mac-mini' }),
      ],
      { repoName: 'pte-dojo' },
      NOW,
    );

    expect(decision.env).toBe('mac-mini');
    expect(decision.assessed.find((item) => item.env === 'laptop')?.rejection).toBe('REPO');
  });

  it('ignores a checkout the node marked as not ready', () => {
    const decision = routeTask(
      [candidate({ repos: [{ name: 'pte-dojo', path: '/srv/pte-dojo', ready: false }] })],
      { repoName: 'pte-dojo' },
      NOW,
    );

    expect(decision.env).toBeNull();
    expect(decision.assessed[0]?.rejection).toBe('REPO');
  });

  it('never spends compute on a portal', () => {
    const decision = routeTask(
      [candidate({ env: 'workbook', role: 'portal' }), candidate({ env: 'mac-mini' })],
      {},
      NOW,
    );

    expect(decision.env).toBe('mac-mini');
    expect(decision.assessed.find((item) => item.env === 'workbook')?.rejection).toBe('PORTAL');
  });

  it('drops a node at or below the free memory floor', () => {
    const decision = routeTask(
      [
        candidate({ env: 'tight', freeMemoryMB: ROUTE_MIN_FREE_MEMORY_MB }),
        candidate({ env: 'roomy', freeMemoryMB: ROUTE_MIN_FREE_MEMORY_MB + 1 }),
      ],
      {},
      NOW,
    );

    expect(decision.env).toBe('roomy');
    expect(decision.assessed.find((item) => item.env === 'tight')?.rejection).toBe('MEMORY');
  });

  it('drops a node already at its concurrency ceiling', () => {
    const decision = routeTask(
      [candidate({ env: 'busy', activeCount: 2, maxConcurrency: 2 }), candidate({ env: 'idle' })],
      {},
      NOW,
    );

    expect(decision.env).toBe('idle');
    expect(decision.assessed.find((item) => item.env === 'busy')?.rejection).toBe('CAPACITY');
  });

  it('drops a node whose last beat is older than the heartbeat timeout', () => {
    const decision = routeTask(
      [
        candidate({ env: 'silent', lastSeenAt: NOW - NODE_HEARTBEAT_TIMEOUT_MS - 1 }),
        candidate({ env: 'talking', lastSeenAt: NOW - NODE_HEARTBEAT_TIMEOUT_MS }),
      ],
      {},
      NOW,
    );

    expect(decision.env).toBe('talking');
    expect(decision.assessed.find((item) => item.env === 'silent')?.rejection).toBe('OFFLINE');
  });

  it('keeps a node that never reported memory but ranks it below a healthy one', () => {
    const decision = routeTask(
      [candidate({ env: 'unknown-box', freeMemoryMB: undefined }), candidate({ env: 'mini' })],
      {},
      NOW,
    );

    expect(decision.env).toBe('mini');
    expect(decision.assessed.find((item) => item.env === 'unknown-box')?.rejection).toBeUndefined();
  });

  it('prefers the idle machine over the loaded one', () => {
    const decision = routeTask(
      [
        candidate({ env: 'half-full', activeCount: 1, maxConcurrency: 4 }),
        candidate({ env: 'empty', activeCount: 0, maxConcurrency: 4 }),
      ],
      {},
      NOW,
    );

    expect(decision.env).toBe('empty');
  });

  it('requires every requested tag', () => {
    const decision = routeTask(
      [
        candidate({ env: 'office-box', tags: ['office'] }),
        candidate({ env: 'gpu-box', tags: ['office', 'gpu'] }),
      ],
      { tags: ['office', 'gpu'] },
      NOW,
    );

    expect(decision.env).toBe('gpu-box');
    expect(decision.assessed.find((item) => item.env === 'office-box')?.rejection).toBe('TAGS');
  });

  it('only considers nodes that run the requested engine', () => {
    const decision = routeTask(
      [
        candidate({ env: 'cursor-box', engines: ['cursor'] }),
        candidate({ env: 'opencode-box', engines: ['opencode'] }),
      ],
      { engine: 'cursor' },
      NOW,
    );

    expect(decision.env).toBe('cursor-box');
  });

  it('breaks a tie on the env name so a restart routes the same way', () => {
    const decision = routeTask(
      [candidate({ env: 'zeta' }), candidate({ env: 'alpha' })],
      {},
      NOW,
    );

    expect(decision.env).toBe('alpha');
  });

  it('explains that nothing matched instead of picking someone anyway', () => {
    const decision = routeTask(
      [
        candidate({ env: 'portal-1', role: 'portal' }),
        candidate({ env: 'portal-2', role: 'portal' }),
        candidate({ env: 'dry', freeMemoryMB: 512 }),
      ],
      {},
      NOW,
    );

    expect(decision.env).toBeNull();
    expect(decision.reason).toContain('portal');
    expect(decision.reason).toContain('memory');
  });

  it('says so when the hub has no nodes at all', () => {
    expect(routeTask([], {}, NOW).reason).toContain('no nodes');
  });
});

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    env: 'mac-mini',
    name: 'Mac mini opencode',
    kind: 'opencode',
    status: 'active',
    hasToken: true,
    online: true,
    deviceId: 'mm-1',
    lastSeenAt: NOW - 4_000,
    createdAt: 1,
    updatedAt: NOW,
    ...overrides,
  };
}

function device(overrides: Partial<Device> = {}): Device {
  return {
    id: 'mm-1',
    online: true,
    envs: ['mac-mini'],
    createdAt: 1,
    updatedAt: NOW,
    profile: {
      nodeId: 'mm-1',
      hostname: 'studio-mini',
      role: 'hybrid',
      tags: ['office'],
      maxConcurrency: 3,
      repos: [{ name: 'pte-dojo', path: '/Users/qiliu/code/pte-dojo' }],
      freeMemoryMB: 6144,
    },
    ...overrides,
  };
}

describe('toRouteCandidates', () => {
  it('joins the machine profile onto the identity that runs on it', () => {
    const [only] = toRouteCandidates([agent()], [device()], { 'mac-mini': 2 });

    expect(only).toMatchObject({
      env: 'mac-mini',
      role: 'hybrid',
      tags: ['office'],
      engines: ['opencode'],
      maxConcurrency: 3,
      activeCount: 2,
      freeMemoryMB: 6144,
      lastSeenAt: NOW - 4_000,
    });
    expect(only?.repos[0]?.name).toBe('pte-dojo');
  });

  it('falls back to worker defaults for a machine that never reported a profile', () => {
    const [only] = toRouteCandidates(
      [agent({ deviceId: undefined })],
      [device({ profile: undefined, envs: ['mac-mini'] })],
      {},
    );

    expect(only).toMatchObject({ role: 'worker', tags: [], maxConcurrency: 1, repos: [] });
    expect(only?.freeMemoryMB).toBeUndefined();
  });

  it('reads the memory figure off the freshest heartbeat when the profile has none', () => {
    const [only] = toRouteCandidates(
      [agent({ deviceStats: { freeMemBytes: 3 * 1024 * 1024 * 1024, cpuCount: 8 } })],
      [
        device({
          profile: {
            nodeId: 'mm-1',
            hostname: 'studio-mini',
            role: 'worker',
            tags: [],
            maxConcurrency: 1,
            repos: [],
          },
        }),
      ],
      {},
    );

    expect(only?.freeMemoryMB).toBe(3072);
  });

  it('routes an identity with no machine card on the facts it reported', () => {
    const [only] = toRouteCandidates([agent({ deviceId: 'ghost' })], [], {});

    expect(only).toMatchObject({
      env: 'mac-mini',
      role: 'worker',
      repos: [],
      maxConcurrency: 1,
      engines: ['opencode'],
      lastSeenAt: NOW - 4_000,
    });
  });
});
