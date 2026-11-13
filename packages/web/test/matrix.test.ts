import { describe, expect, it } from 'vitest';

import type { Agent, AgentTask, Device, NodeProfile } from '@zhunzou/shared';

import { buildNodeMatrix } from '../src/lib/matrix';

const T0 = 1_700_000_000_000;
const GIB = 1024 * 1024 * 1024;

function device(id: string, overrides: Partial<Device> = {}): Device {
  return {
    id,
    host: id,
    online: true,
    envs: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  } as Device;
}

function agent(env: string, overrides: Partial<Agent> = {}): Agent {
  return {
    env,
    name: env,
    kind: 'cursor',
    status: 'active',
    online: true,
    deviceId: null,
    lastSeenAt: T0,
    ...overrides,
  } as Agent;
}

function task(env: string, overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: '1',
    env,
    title: '任务',
    instruction: '做点什么。',
    status: 'PENDING',
    attempts: 0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  } as AgentTask;
}

function profile(overrides: Partial<NodeProfile> = {}): NodeProfile {
  return {
    nodeId: 'node-1',
    hostname: 'node-1',
    role: 'worker',
    tags: [],
    maxConcurrency: 1,
    repos: [],
    ...overrides,
  } as NodeProfile;
}

describe('buildNodeMatrix grouping', () => {
  it('M1: keeps the agents-panel grouping intact', () => {
    const devices = [
      // Two boxes reporting one hostname — an image clone does exactly this.
      device('pc000001', { host: 'clone', envs: ['desk-one'] }),
      device('pc000002', { host: 'clone', envs: ['desk-two'] }),
      // A device row derived from a hostname never needs the disambiguation.
      device('host:clone', { host: 'clone', envs: ['desk-three'] }),
    ];
    const agents = [
      agent('desk-one', { deviceId: 'pc000001' }),
      agent('desk-two', { deviceId: 'pc000002' }),
      agent('desk-three', { deviceId: 'host:clone' }),
      agent('orphan-one', { host: 'solo' }),
      agent('orphan-two', { host: 'solo', online: false }),
      agent('nameless'),
    ];

    const cards = buildNodeMatrix(devices, agents, [], {
      unknownHost: '未上报主机',
    });
    const byHost = new Map(cards.map((card) => [card.host, card]));

    expect([...byHost.keys()].sort()).toEqual(
      [
        'clone',
        'clone · pc000001',
        'clone · pc000002',
        'solo',
        '未上报主机',
      ].sort(),
    );
    // One agent per machine, and every agent the hub cannot attribute to a
    // device still gets a card — bucketed by the hostname it reported.
    expect(byHost.get('clone · pc000001')?.total).toBe(1);
    expect(byHost.get('clone · pc000002')?.total).toBe(1);
    expect(byHost.get('clone')?.total).toBe(1);
    expect(byHost.get('solo')).toMatchObject({ total: 2, online: 1 });
    expect(byHost.get('未上报主机')?.total).toBe(1);
  });

  it('M1b: orders by online, then size, then name', () => {
    const cards = buildNodeMatrix(
      [
        device('pc-busy', { host: 'zeta', envs: ['b1', 'b2'] }),
        device('pc-quiet', { host: 'alpha', envs: ['a1'], }),
        device('pc-lone', { host: 'mike', online: false, envs: [] }),
      ],
      [
        agent('b1', { deviceId: 'pc-busy', online: false }),
        agent('b2', { deviceId: 'pc-busy', online: false }),
        agent('a1', { deviceId: 'pc-quiet' }),
      ],
      [],
    );

    expect(cards.map((card) => card.host)).toEqual(['alpha', 'zeta', 'mike']);
  });

  it('M2: still draws a card when the node never reported a profile', () => {
    const [card] = buildNodeMatrix([device('pc-old', { host: 'old-mac' })], [], []);

    expect(card).toMatchObject({
      host: 'old-mac',
      role: 'worker',
      tags: [],
      repoCount: 0,
      activeCount: 0,
      isolatedCount: 0,
    });
    expect(card?.maxConcurrency).toBeUndefined();
    expect(card?.freeMemoryMB).toBeUndefined();
    expect(card?.memoryRatio).toBeUndefined();
  });

  it('M2b: reads role, tags and repos off the profile', () => {
    const [card] = buildNodeMatrix(
      [
        device('pc-gpu', {
          host: 'gpu-box',
          profile: profile({
            role: 'hybrid',
            tags: ['gpu', 'home'],
            maxConcurrency: 4,
            repos: [{ name: 'agent-hub' }, { name: 'pte-dojo' }] as NodeProfile['repos'],
          }),
        }),
      ],
      [],
      [],
    );

    expect(card).toMatchObject({
      role: 'hybrid',
      tags: ['gpu', 'home'],
      repoCount: 2,
      maxConcurrency: 4,
    });
  });
});

describe('buildNodeMatrix tallies', () => {
  it('M3: counts only work the scheduler holds against the machine', () => {
    const devices = [device('pc-1', { host: 'desk', envs: ['desk-a'] })];
    const agents = [agent('desk-a', { deviceId: 'pc-1' })];

    const active = buildNodeMatrix(
      devices,
      agents,
      ['PENDING', 'CLAIMED', 'HEALING'].map((status, index) =>
        task('desk-a', { id: String(index + 1), status: status as AgentTask['status'] }),
      ),
    );
    expect(active[0]?.activeCount).toBe(3);

    const settled = buildNodeMatrix(
      devices,
      agents,
      ['BLOCKED', 'DONE', 'FAILED', 'CANCELLED'].map((status, index) =>
        task('desk-a', { id: String(index + 1), status: status as AgentTask['status'] }),
      ),
    );
    expect(settled[0]?.activeCount).toBe(0);
  });

  it('M4: counts isolated runs as the edge reported them', () => {
    // `workspace_path` is written by the completion report (Step 2.1), so this
    // figure lags a running task by design; it is not a live worktree count.
    const cards = buildNodeMatrix(
      [device('pc-1', { host: 'desk', envs: ['desk-a', 'desk-b'] })],
      [agent('desk-a', { deviceId: 'pc-1' }), agent('desk-b', { deviceId: 'pc-1' })],
      [
        task('desk-a', { id: '1', status: 'DONE', workspacePath: '/srv/wt/1' }),
        task('desk-a', { id: '2', status: 'CLAIMED' }),
        task('desk-b', { id: '3', status: 'FAILED', workspacePath: '/srv/wt/3' }),
        task('desk-z', { id: '4', workspacePath: '/srv/wt/4' }),
      ],
    );

    expect(cards[0]).toMatchObject({ activeCount: 1, isolatedCount: 2 });
  });

  it('M4b: ignores work on an env no card claims', () => {
    const cards = buildNodeMatrix(
      [device('pc-1', { host: 'desk', envs: ['desk-a'] })],
      [agent('desk-a', { deviceId: 'pc-1' })],
      [task('desk-ghost', { id: '1' })],
    );

    expect(cards[0]).toMatchObject({ activeCount: 0, isolatedCount: 0 });
  });
});

describe('buildNodeMatrix memory', () => {
  it('M5: ratios the node-reported free memory against total', () => {
    const [card] = buildNodeMatrix(
      [
        device('pc-1', {
          host: 'desk',
          profile: profile({ freeMemoryMB: 1_024 }),
          deviceStats: { totalMemBytes: 8 * GIB, freeMemBytes: 1 * GIB } as Device['deviceStats'],
        }),
      ],
      [],
      [],
    );

    expect(card?.freeMemoryMB).toBe(1_024);
    expect(card?.memoryRatio).toBeCloseTo(0.125, 6);
  });

  it('M5b: falls back to the heartbeat bytes when the profile is silent', () => {
    const [card] = buildNodeMatrix(
      [
        device('pc-1', {
          host: 'desk',
          deviceStats: {
            totalMemBytes: 16 * GIB,
            freeMemBytes: 4 * GIB,
          } as Device['deviceStats'],
        }),
      ],
      [],
      [],
    );

    expect(card?.freeMemoryMB).toBe(4 * 1024);
    expect(card?.memoryRatio).toBeCloseTo(0.25, 6);
  });

  it('M5c: draws no bar when either figure is missing', () => {
    const withoutTotal = buildNodeMatrix(
      [device('pc-1', { host: 'desk', profile: profile({ freeMemoryMB: 2_048 }) })],
      [],
      [],
    );
    expect(withoutTotal[0]?.freeMemoryMB).toBe(2_048);
    expect(withoutTotal[0]?.memoryRatio).toBeUndefined();

    const withoutFree = buildNodeMatrix(
      [
        device('pc-2', {
          host: 'desk',
          deviceStats: { totalMemBytes: 8 * GIB } as Device['deviceStats'],
        }),
      ],
      [],
      [],
    );
    expect(withoutFree[0]?.freeMemoryMB).toBeUndefined();
    expect(withoutFree[0]?.memoryRatio).toBeUndefined();
  });

  it('M5d: clamps a nonsense report into the bar', () => {
    const [card] = buildNodeMatrix(
      [
        device('pc-1', {
          host: 'desk',
          profile: profile({ freeMemoryMB: 32 * 1024 }),
          deviceStats: { totalMemBytes: 8 * GIB } as Device['deviceStats'],
        }),
      ],
      [],
      [],
    );

    expect(card?.memoryRatio).toBe(1);
  });
});
