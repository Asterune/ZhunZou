import { describe, expect, it } from 'vitest';

import {
  WS_EVENTS,
  parseRealtimeClientFrame,
  parseRealtimeServerFrame,
  realtimeClientFrameSchema,
  realtimeServerFrameSchema,
} from '../src/index.js';

const hello = {
  type: 'hello',
  env: 'studio-mini',
  capabilities: { protocol: 1, os: 'darwin', arch: 'arm64', hostname: 'studio-mini' },
  profile: {
    nodeId: 'mac-mini-2',
    hostname: 'studio-mini',
    role: 'worker',
    tags: ['office', 'mac-mini'],
    freeMemoryMB: 8192,
    maxConcurrency: 2,
    repos: [{ name: 'pte-dojo', path: '/Users/qiliu/code/pte-dojo' }],
  },
} as const;

describe('NODE_REGISTER / NODE_HEARTBEAT frames', () => {
  it('carries the node profile in the hello frame', () => {
    const parsed = parseRealtimeClientFrame(hello);
    expect(parsed?.type).toBe(WS_EVENTS.NODE_REGISTER);
    if (parsed?.type !== 'hello') throw new Error('unreachable');
    expect(parsed.profile?.role).toBe('worker');
    expect(parsed.profile?.repos[0]?.name).toBe('pte-dojo');
  });

  it('keeps heartbeats valid without a profile', () => {
    const parsed = parseRealtimeClientFrame({
      type: 'heartbeat',
      at: 1_700_000_000_000,
      stats: { freeMemBytes: 3 * 1024 * 1024 * 1024 },
    });
    expect(parsed?.type).toBe(WS_EVENTS.NODE_HEARTBEAT);
  });
});

describe('PERMISSION_REQUEST frame', () => {
  it('asks the hub to rule on a concrete action', () => {
    const parsed = parseRealtimeClientFrame({
      type: 'permission.request',
      requestId: 'req-1',
      taskId: '42',
      action: {
        kind: 'git_operation',
        command: 'git push -f origin main',
        workspaceRoot: '/Users/qiliu/code/pte-dojo',
        cwd: '/Users/qiliu/code/pte-dojo',
      },
      timeoutMs: 40_000,
    });
    expect(parsed?.type).toBe(WS_EVENTS.PERMISSION_REQUEST);
    if (parsed?.type !== 'permission.request') throw new Error('unreachable');
    expect(parsed.taskId).toBe('42');
    expect(parsed.action.command).toBe('git push -f origin main');
  });

  it('rejects a request whose action has nothing to guard', () => {
    expect(
      realtimeClientFrameSchema.safeParse({
        type: 'permission.request',
        requestId: 'req-2',
        action: { kind: 'command' },
      }).success,
    ).toBe(false);
  });
});

describe('SUPERVISOR_DECISION frame', () => {
  it('answers a parked request with the layer that decided', () => {
    const parsed = parseRealtimeServerFrame({
      type: 'supervisor.decision',
      requestId: 'req-1',
      taskId: '42',
      decision: {
        decision: 'DENY',
        layer: 'L1',
        reason: '命中破坏性命令黑名单',
      },
    });
    expect(parsed?.type).toBe(WS_EVENTS.SUPERVISOR_DECISION);
    if (parsed?.type !== 'supervisor.decision') throw new Error('unreachable');
    expect(parsed.decision.layer).toBe('L1');
  });

  it('refuses an unknown decision layer', () => {
    expect(
      realtimeServerFrameSchema.safeParse({
        type: 'supervisor.decision',
        decision: { decision: 'APPROVE', layer: 'L0', reason: 'x' },
      }).success,
    ).toBe(false);
  });
});

describe('WS_EVENTS', () => {
  it('names every blueprint event with a frame that actually exists', () => {
    const clientTypes = realtimeClientFrameSchema.options.map((frame) =>
      frame.shape.type.value
    );
    const serverTypes = realtimeServerFrameSchema.options.map((frame) =>
      frame.shape.type.value
    );
    const all = [...clientTypes, ...serverTypes];

    expect(WS_EVENTS).toMatchObject({
      NODE_REGISTER: 'hello',
      NODE_HEARTBEAT: 'heartbeat',
      TASK_DISPATCH: 'task.assigned',
      TASK_LOG_STREAM: 'task.log',
      PERMISSION_REQUEST: 'permission.request',
      SUPERVISOR_DECISION: 'supervisor.decision',
    });
    for (const frameType of Object.values(WS_EVENTS)) {
      expect(all).toContain(frameType);
    }
  });

  it('parses an unknown frame type as invalid instead of throwing', () => {
    expect(parseRealtimeClientFrame({ type: 'node.register' })).toBeNull();
    expect(parseRealtimeServerFrame({ type: 'task.dispatch' })).toBeNull();
  });
});
