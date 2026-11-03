import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EnvHeartbeat, HeartbeatInput } from '@zhunzou/shared';

import type { HubApi } from '../src/hub-client.js';
import { createPresenceReporter } from '../src/presence.js';

function heartbeat(input: HeartbeatInput): EnvHeartbeat {
  return {
    env: 'company-windows',
    status: input.status,
    lastSeenAt: Date.now(),
    online: true,
    ...(input.projectName ? { projectName: input.projectName } : {}),
    ...(input.currentTask ? { currentTask: input.currentTask } : {}),
  };
}

function fakeClient() {
  const calls: HeartbeatInput[] = [];
  const client = {
    heartbeat: vi.fn(async (input: HeartbeatInput) => {
      calls.push(input);
      return heartbeat(input);
    }),
  } as unknown as HubApi;
  return { client, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('presence reporter', () => {
  it('sends an initial heartbeat and keeps the env online', async () => {
    vi.useFakeTimers();
    const { client, calls } = fakeClient();
    const presence = createPresenceReporter(client, { intervalMs: 30_000 });

    presence.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: 'Idle' });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(2);
    presence.stop();
  });

  it('reports the configured workspace project on every heartbeat', async () => {
    vi.useFakeTimers();
    const { client, calls } = fakeClient();
    const presence = createPresenceReporter(client, {
      intervalMs: 30_000,
      projectName: 'agent-hub',
    });

    presence.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]).toMatchObject({
      status: 'Idle',
      projectName: 'agent-hub',
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.at(-1)).toMatchObject({ projectName: 'agent-hub' });
    presence.stop();
  });

  it('sends the current state on demand and on the next interval', async () => {
    vi.useFakeTimers();
    const { client, calls } = fakeClient();
    const presence = createPresenceReporter(client, { intervalMs: 30_000 });

    presence.start();
    await presence.beat({
      status: 'Blocked',
      projectName: 'yikuaomed-erp',
      currentTask: '等待审批',
    });
    expect(calls.at(-1)).toMatchObject({
      status: 'Blocked',
      projectName: 'yikuaomed-erp',
      currentTask: '等待审批',
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.at(-1)).toMatchObject({ status: 'Blocked' });
    presence.stop();
  });

  it('pauses during long polling and resumes afterwards', async () => {
    vi.useFakeTimers();
    const { client, calls } = fakeClient();
    const presence = createPresenceReporter(client, { intervalMs: 30_000 });

    presence.start();
    await vi.advanceTimersByTimeAsync(0);
    presence.pause();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);

    await presence.beat({ status: 'Running', currentTask: '恢复执行' });
    presence.resume();
    expect(calls.at(-1)).toMatchObject({ status: 'Running' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.at(-1)).toMatchObject({ status: 'Running' });
    presence.stop();
  });
});
