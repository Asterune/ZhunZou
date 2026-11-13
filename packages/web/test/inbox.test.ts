import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AgentTask,
  Device,
  SupervisorInboxItem,
  SupervisorInboxResponse,
} from '@zhunzou/shared';

import { ApiError, type HubApi } from '../src/lib/api';
import {
  blockedCount,
  deviceForTask,
  mergeInfoFor,
  sortInbox,
} from '../src/lib/inbox';
import { useToasts } from '../src/lib/toast';
import { createHubStore } from '../src/stores/hub';

const T0 = 1_700_000_000_000;

function task(id: string, overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    env: `env-${id}`,
    title: `任务 ${id}`,
    instruction: '把这件事做完。',
    status: 'BLOCKED',
    attempts: 1,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  } as AgentTask;
}

function item(
  id: string,
  overrides: Partial<SupervisorInboxItem> = {},
): SupervisorInboxItem {
  return { task: task(id), ...overrides };
}

function device(id: string, envs: string[]): Device {
  return {
    id,
    host: id,
    online: true,
    envs,
    createdAt: T0,
    updatedAt: T0,
  } as Device;
}

/** A hub whose inbox arrives on its own request, outside the sync snapshot. */
function fakeHub(handlers: Partial<HubApi> = {}) {
  const calls = { sync: 0 };

  const api = {
    sync: async () => {
      calls.sync += 1;
      // The snapshot is unchanged here; these tests watch the optimistic row,
      // not the round trip that would replace it.
      return { rev: 1, changed: false };
    },
    ...handlers,
  } as unknown as HubApi;

  const store = createHubStore(api);
  store.token = 'test-token';
  return { store, calls };
}

const { toasts, dismissToast } = useToasts();

function lastToast(): string {
  return toasts.value[toasts.value.length - 1]?.message ?? '';
}

beforeEach(() => {
  for (const toast of [...toasts.value]) dismissToast(toast.id);
});

describe('sortInbox', () => {
  it('I1: puts blocked work first, then newest first, without truncating', () => {
    const items = [
      item('3', { task: task('3', { status: 'DONE', updatedAt: T0 + 30_000 }) }),
      item('1'),
      item('4', { task: task('4', { updatedAt: T0 + 10_000 }) }),
      item('2', { task: task('2', { updatedAt: T0 + 20_000 }) }),
      item('5', { task: task('5', { status: 'DONE', updatedAt: T0 + 40_000 }) }),
    ];

    expect(sortInbox(items).map((entry) => entry.task.id)).toEqual([
      '2',
      '4',
      '1',
      '5',
      '3',
    ]);
    // Cutting the list is the server's job; the panel must not hide a stuck card.
    expect(sortInbox(items)).toHaveLength(items.length);
    expect(items.map((entry) => entry.task.id)).toEqual([
      '3',
      '1',
      '4',
      '2',
      '5',
    ]);
  });

  it('I1b: breaks an exact tie on the newer task id', () => {
    const items = [item('11'), item('9'), item('12')];

    expect(sortInbox(items).map((entry) => entry.task.id)).toEqual([
      '12',
      '11',
      '9',
    ]);
  });

  it('I2: counts only blocked work as waiting for a person', () => {
    const items = [
      item('1'),
      item('2', { task: task('2', { status: 'DONE' }) }),
      item('3'),
      item('4', { task: task('4', { status: 'FAILED' }) }),
    ];

    expect(blockedCount(items)).toBe(2);
    expect(blockedCount([])).toBe(0);
  });
});

describe('mergeInfoFor', () => {
  it('I3: derives the wip branch for isolated work', () => {
    const isolated = item('5', {
      task: task('5', { workspacePath: '/srv/node/.zhunzou/wt/5' }),
    });

    expect(mergeInfoFor(isolated)).toEqual({
      branch: 'wip/zz-5',
      path: '/srv/node/.zhunzou/wt/5',
    });
  });

  it('I3b: prefers the branch the server reported', () => {
    const reported = item('5', {
      task: task('5', { workspacePath: '/srv/node/.zhunzou/wt/5' }),
      branch: 'wip/zz-5-retry',
    });

    expect(mergeInfoFor(reported)?.branch).toBe('wip/zz-5-retry');
  });

  it('I3c: gives nothing for a task that shared the agent checkout', () => {
    expect(mergeInfoFor(item('6'))).toBeUndefined();
  });
});

describe('deviceForTask', () => {
  const devices = [device('pc-a', ['desk-a', 'desk-b']), device('pc-c', [])];

  it('I4: resolves the machine through the env it hosts', () => {
    expect(deviceForTask(task('7', { env: 'desk-b' }), devices)?.id).toBe('pc-a');
  });

  it('I4b: stays silent for an env no machine claims', () => {
    expect(deviceForTask(task('7', { env: 'desk-z' }), devices)).toBeUndefined();
    expect(deviceForTask(task('7', { env: 'desk-a' }), [])).toBeUndefined();
  });
});

describe('store.loadInbox', () => {
  it('I5: keeps one request in flight and sorts what comes back', async () => {
    let inboxCalls = 0;
    let release!: (value: SupervisorInboxResponse) => void;
    const pending = new Promise<SupervisorInboxResponse>((resolve) => {
      release = resolve;
    });
    const { store } = fakeHub({
      getInbox: async () => {
        inboxCalls += 1;
        return pending;
      },
    });

    const first = store.loadInbox();
    const second = store.loadInbox();
    expect(inboxCalls).toBe(1);
    expect(store.inboxLoading).toBe(true);

    release({
      items: [
        item('3', { task: task('3', { status: 'DONE', updatedAt: T0 + 30_000 }) }),
        item('4', { task: task('4', { updatedAt: T0 + 10_000 }) }),
      ],
    });
    await Promise.all([first, second]);

    expect(inboxCalls).toBe(1);
    expect(store.inbox.map((entry) => entry.task.id)).toEqual(['4', '3']);
    expect(store.inboxLoading).toBe(false);
  });

  it('I5b: reports a failed load and keeps the cards already on screen', async () => {
    let failing = false;
    const { store } = fakeHub({
      getInbox: async () => {
        if (failing) throw new ApiError(500, 'INTERNAL', '收件箱读不出来');
        return { items: [item('9')] };
      },
    });

    await store.loadInbox();
    expect(store.inbox.map((entry) => entry.task.id)).toEqual(['9']);

    failing = true;
    await store.loadInbox();

    expect(store.inbox.map((entry) => entry.task.id)).toEqual(['9']);
    expect(store.inboxLoading).toBe(false);
    expect(lastToast()).toBe('收件箱读不出来');
  });
});

describe('store.retryTask', () => {
  it('I6: releases the task, drops its card and refreshes once', async () => {
    const requests: Array<[string, string, string]> = [];
    const { store, calls } = fakeHub({
      getInbox: async () => ({
        items: [item('12'), item('9', { task: task('9', { status: 'DONE' }) })],
      }),
      retryTask: async (token, taskId, reason) => {
        requests.push([token, taskId, reason ?? '']);
        return { task: task(taskId, { status: 'PENDING' }) };
      },
    });
    await store.loadInbox();

    await expect(store.retryTask('12', '人工放行')).resolves.toBe(true);

    expect(requests).toEqual([['test-token', '12', '人工放行']]);
    expect(store.inbox.map((entry) => entry.task.id)).toEqual(['9']);
    expect(calls.sync).toBe(1);
    expect(store.inboxActionId).toBe('');
    expect(lastToast()).toContain('12');
  });

  it('I7: leaves local state alone when the hub refuses, and says why', async () => {
    const { store, calls } = fakeHub({
      getInbox: async () => ({ items: [item('12')] }),
      retryTask: async () => {
        throw new ApiError(
          409,
          'INVALID_TASK_STATUS',
          'task 12 is DONE, expected BLOCKED',
        );
      },
    });
    await store.loadInbox();

    await expect(store.retryTask('12')).resolves.toBe(false);

    expect(store.inbox.map((entry) => entry.task.id)).toEqual(['12']);
    expect(store.tasks).toEqual([]);
    expect(calls.sync).toBe(0);
    expect(lastToast()).toBe('task 12 is DONE, expected BLOCKED');
    expect(store.inboxActionId).toBe('');
  });

  it('I7b: refuses a second release while one is in flight', async () => {
    let release!: (value: { task: AgentTask }) => void;
    const { store } = fakeHub({
      retryTask: () => new Promise((resolve) => (release = resolve)),
    });

    const first = store.retryTask('12');
    const second = await store.retryTask('13');
    expect(second).toBe(false);

    release({ task: task('12', { status: 'PENDING' }) });
    await expect(first).resolves.toBe(true);
  });
});

describe('store.dispatchTask', () => {
  it('I8: shows the routing failure verbatim', async () => {
    const { store, calls } = fakeHub({
      dispatchTask: async () => {
        throw new ApiError(
          409,
          'NO_ROUTE_TARGET',
          '没有可派发的节点：desk-a（离线）、desk-b（并发已满）',
        );
      },
    });

    await expect(
      store.dispatchTask({
        title: '补齐导出',
        instruction: '把 CSV 导出补上测试。',
        repoName: 'agent-hub',
      }),
    ).resolves.toBe(false);

    expect(store.tasks).toEqual([]);
    expect(calls.sync).toBe(0);
    expect(lastToast()).toBe('没有可派发的节点：desk-a（离线）、desk-b（并发已满）');
  });

  it('I8b: puts routed work on the board and names the machine it chose', async () => {
    const { store, calls } = fakeHub({
      dispatchTask: async (_token, input) => ({
        task: task('21', { env: 'desk-b', title: input.title }),
        route: { env: 'desk-b', reason: 'LEAST_BUSY' as const, assessed: [] },
      }),
    });

    await expect(
      store.dispatchTask({
        title: '补齐导出',
        instruction: '把 CSV 导出补上测试。',
        repoName: 'agent-hub',
      }),
    ).resolves.toBe(true);

    expect(store.tasks.map((entry) => [entry.id, entry.env])).toEqual([
      ['21', 'desk-b'],
    ]);
    expect(calls.sync).toBe(1);
    expect(lastToast()).toContain('desk-b');
  });
});
