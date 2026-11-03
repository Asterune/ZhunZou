import { describe, expect, it } from 'vitest';

import type {
  AgentTask,
  CompleteTaskInput,
  EnvHeartbeat,
  HeartbeatInput,
  ReleaseTaskInput,
} from '@zhunzou/shared';

import type { HubApi } from '../src/hub-client.js';
import {
  renderCommandTemplate,
  resolveWakeAdapter,
  shellQuote,
  type WakeAdapter,
} from '../src/wake/adapters.js';
import { loadWakeConfig, type WakeConfig } from '../src/wake/config.js';
import { runWakeDaemon } from '../src/wake/daemon.js';
import { buildInjectPrompt, buildRunPrompt } from '../src/wake/prompt.js';
import { makeTask, testConfig } from './helpers.js';

const wakeConfig: WakeConfig = {
  adapter: 'command',
  command: 'true',
  extraArgs: [],
  cwd: process.cwd(),
  runTimeoutMs: 5_000,
  pollTimeoutMs: 1_000,
  notifyIntervalMs: 2_000,
};

interface Calls {
  completed: Array<{ taskId: string; input: CompleteTaskInput }>;
  released: Array<{ taskId: string; input: ReleaseTaskInput }>;
  heartbeats: Array<Omit<HeartbeatInput, 'env'>>;
}

function makeClient(
  task: AgentTask | null,
  calls: Calls,
): HubApi {
  let polls = 0;

  return {
    async createTicket() {
      throw new Error('unused');
    },
    async wait() {
      throw new Error('unused');
    },
    async heartbeat(input) {
      calls.heartbeats.push(input);
      return {
        env: 'company-cursor',
        status: input.status,
        lastSeenAt: 1,
        online: true,
      } satisfies EnvHeartbeat;
    },
    async nextTask() {
      polls += 1;
      return { task: polls === 1 ? task : null, timedOut: false };
    },
    async listTasks() {
      return { tasks: task ? [task] : [], total: task ? 1 : 0 };
    },
    async completeTask(taskId, input) {
      calls.completed.push({ taskId, input });
      return { ...(task as AgentTask), status: input.status };
    },
    async releaseTask(taskId, input) {
      calls.released.push({ taskId, input });
      return { ...(task as AgentTask), status: 'PENDING' };
    },
    async resume() {
      throw new Error('unused');
    },
  };
}

function makeAdapter(
  wake: WakeAdapter['wake'],
  delivery: WakeAdapter['delivery'] = 'run',
): WakeAdapter {
  return { name: 'command', delivery, wake };
}

async function runOnce(
  adapter: WakeAdapter,
  task: AgentTask | null,
): Promise<{ calls: Calls; lines: string[] }> {
  const calls: Calls = { completed: [], released: [], heartbeats: [] };
  const lines: string[] = [];

  await runWakeDaemon({
    client: makeClient(task, calls),
    hub: testConfig(),
    wake: wakeConfig,
    adapter,
    once: true,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    sleep: async () => undefined,
  });

  return { calls, lines };
}

describe('buildInjectPrompt', () => {
  it('includes the task and forbids claiming it again', () => {
    const prompt = buildInjectPrompt(makeTask());

    expect(prompt).toContain('#12');
    expect(prompt).toContain('给登录页补错误提示');
    expect(prompt).toContain('错误提示统一使用行内文案');
    expect(prompt).toContain('不要再调用 agent_hub_next_task');
    expect(prompt).toContain('agent_hub_complete_task(taskId: "12"');
  });
});

describe('buildRunPrompt', () => {
  it('describes the task without MCP instructions', () => {
    const prompt = buildRunPrompt(makeTask({ projectName: 'erp' }));

    expect(prompt).toContain('项目：erp');
    expect(prompt).toContain('指令：');
    expect(prompt).not.toContain('agent_hub_next_task');
  });
});

describe('shell helpers', () => {
  it('quotes values so placeholders cannot break the command', () => {
    expect(shellQuote('a b')).toBe(`'a b'`);
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
  });

  it('expands placeholders with quoted task values', () => {
    const rendered = renderCommandTemplate(
      'run {taskId} {project} {prompt}',
      makeTask({ title: 'title with spaces' }),
      '/tmp/work',
    );

    expect(rendered).toContain(`run '12' 'yikuaomed-erp'`);
    expect(rendered).toContain('title with spaces');
    expect(rendered).toContain('错误提示统一使用行内文案');
    expect(rendered).not.toContain('{prompt}');
  });
});

describe('loadWakeConfig', () => {
  it('falls back to auto and parses overrides', () => {
    const config = loadWakeConfig(
      {
        ZHUNZOU_WAKE_ADAPTER: 'claude',
        ZHUNZOU_WAKE_ARGS: '--model sonnet',
        ZHUNZOU_WAKE_RUN_TIMEOUT_MS: '9000',
      },
      '/tmp/work',
    );

    expect(config.adapter).toBe('claude');
    expect(config.extraArgs).toEqual(['--model', 'sonnet']);
    expect(config.runTimeoutMs).toBe(9_000);
    expect(config.cwd).toBe('/tmp/work');
  });

  it('maps unknown adapters to auto', () => {
    expect(loadWakeConfig({ ZHUNZOU_WAKE_ADAPTER: 'nope' }, '/tmp')).toMatchObject({
      adapter: 'auto',
    });
  });
});

describe('resolveWakeAdapter', () => {
  it('returns the notify adapter when explicitly requested', async () => {
    const adapter = await resolveWakeAdapter({ ...wakeConfig, adapter: 'notify' });
    expect(adapter.delivery).toBe('notify');
  });

  it('returns the command adapter without probing binaries', async () => {
    const adapter = await resolveWakeAdapter({ ...wakeConfig, adapter: 'command' });
    expect(adapter.name).toBe('command');
    expect(adapter.delivery).toBe('run');
  });
});

describe('runWakeDaemon', () => {
  it('completes a task when the adapter reports a result', async () => {
    const task = makeTask();
    const adapter = makeAdapter(async () => ({
      delivery: 'run',
      completion: { status: 'DONE', result: '已补测试' },
    }));

    const { calls } = await runOnce(adapter, task);

    expect(calls.completed).toHaveLength(1);
    expect(calls.completed[0]).toEqual({
      taskId: '12',
      input: { status: 'DONE', result: '已补测试' },
    });
    expect(calls.released).toHaveLength(0);
    expect(calls.heartbeats.at(-1)?.status).toBe('Idle');
  });

  it('releases the task when the adapter cannot wake a client', async () => {
    const task = makeTask();
    const adapter = makeAdapter(async () => {
      throw new Error('找不到 claude 可执行文件');
    });

    const { calls } = await runOnce(adapter, task);

    expect(calls.completed).toHaveLength(0);
    expect(calls.released).toHaveLength(1);
    expect(calls.released[0]?.taskId).toBe('12');
    expect(calls.released[0]?.input.requeue).toBe(true);
    expect(calls.released[0]?.input.reason).toContain('claude');
  });

  it('leaves completion to the agent for inject adapters', async () => {
    const task = makeTask();
    const adapter = makeAdapter(
      async () => ({ delivery: 'inject' }),
      'inject',
    );

    const { calls } = await runOnce(adapter, task);

    expect(calls.completed).toHaveLength(0);
    expect(calls.released).toHaveLength(0);
  });
});
