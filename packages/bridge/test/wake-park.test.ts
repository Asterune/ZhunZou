import { describe, expect, it, vi } from 'vitest';

import type {
  AgentTask,
  CreateTicketInput,
  EnvHeartbeat,
  HeartbeatInput,
} from '@zhunzou/shared';

import type { HubApi } from '../src/hub-client.js';
import type { WakeAdapter, WakeContext } from '../src/wake/adapters.js';
import { loadWakeConfig } from '../src/wake/config.js';
import { runWakeDaemon } from '../src/wake/daemon.js';
import { makeTask, testConfig } from './helpers.js';

interface Calls {
  tickets: Array<Omit<CreateTicketInput, 'env'>>;
  completed: string[];
  released: Array<{ taskId: string; requeue: boolean; reason?: string }>;
  events: Array<{ taskId: string; count: number }>;
  heartbeats: Array<Omit<HeartbeatInput, 'env'>>;
}

function makeClient(task: AgentTask, calls: Calls, failTicket = false): HubApi {
  let polls = 0;
  let ticketId = 0;

  return {
    async createTicket(input) {
      if (failTicket) throw new Error('审批服务不可用');
      calls.tickets.push(input);
      ticketId += 1;
      return {
        id: String(ticketId),
        env: task.env,
        projectName: input.projectName,
        status: 'PENDING_HUMAN',
        doneSummary: input.doneSummary,
        blockerQuestion: input.blockerQuestion,
        nextStepPlan: input.nextStepPlan,
        options: input.options,
        recommendedOption: input.recommendedOption,
        createdAt: 1,
        updatedAt: 1,
      };
    },
    async reportTaskEvents(taskId, events) {
      calls.events.push({ taskId, count: events.length });
      return events.length;
    },
    async wait() {
      throw new Error('unused');
    },
    async heartbeat(input) {
      calls.heartbeats.push(input);
      return { env: task.env, status: input.status, lastSeenAt: 1, online: true } satisfies EnvHeartbeat;
    },
    async nextTask() {
      polls += 1;
      return { task: polls === 1 ? task : null, timedOut: false };
    },
    async listTasks() {
      return { tasks: [task], total: 1 };
    },
    async completeTask(taskId) {
      calls.completed.push(taskId);
      return task;
    },
    async appendTaskLog(taskId, input) {
      return { id: 1, taskId, stream: input.stream, chunk: input.chunk, createdAt: 1 };
    },
    async releaseTask(taskId, input) {
      calls.released.push({ taskId, requeue: input.requeue, reason: input.reason });
      return { ...task, status: 'PENDING' };
    },
    async resume() {
      throw new Error('unused');
    },
  };
}

/** The adapter half of a parked run: the engine stopped, no completion to file. */
function parkedAdapter(): WakeAdapter {
  return {
    name: 'claude',
    delivery: 'run',
    async wake(_task: AgentTask, context: WakeContext) {
      context.reportEvent?.({ kind: 'session', engine: 'claude-code', sessionId: 'ses_1' });
      context.reportEvent?.({
        kind: 'permission_required',
        engine: 'claude-code',
        tool: 'Bash',
        action: { kind: 'command', command: 'rm -rf dist', outsideWorkspace: false },
      });
      return {
        delivery: 'run',
        parked: {
          reason: '端侧引擎请求批准：Bash rm -rf dist',
          tool: 'Bash',
          action: { kind: 'command', command: 'rm -rf dist', outsideWorkspace: false },
        },
      };
    },
  };
}

function finishedAdapter(status: 'DONE' | 'FAILED' = 'DONE'): WakeAdapter {
  return {
    name: 'claude',
    delivery: 'run',
    async wake() {
      return { delivery: 'run', completion: { status, result: 'ok' } };
    },
  };
}

async function run(
  task: AgentTask,
  adapter: WakeAdapter,
  client: HubApi,
): Promise<string[]> {
  const lines: string[] = [];
  await runWakeDaemon({
    client,
    hub: testConfig(),
    wake: loadWakeConfig({}, '/repo'),
    adapter,
    once: true,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    sleep: async () => undefined,
  });
  return lines;
}

describe('wake daemon parking', () => {
  it('raises an approval ticket and hands the task back without completing it', async () => {
    const calls: Calls = { tickets: [], completed: [], released: [], events: [], heartbeats: [] };
    const task = makeTask({ sessionId: 'ses_1' });

    const lines = await run(task, parkedAdapter(), makeClient(task, calls));

    expect(calls.completed).toEqual([]);
    expect(calls.released).toEqual([
      { taskId: task.id, requeue: true, reason: '端侧引擎请求批准：Bash rm -rf dist' },
    ]);

    expect(calls.tickets).toHaveLength(1);
    const ticket = calls.tickets[0]!;
    expect(ticket.projectName).toBe(task.projectName);
    expect(ticket.blockerQuestion).toContain('rm -rf dist');
    // The human reads the credential off the ticket, so it says what resumes.
    expect(ticket.nextStepPlan).toContain('ses_1');
    expect(ticket.options.map((option) => option.label)).toEqual(['批准续跑', '拒绝']);
    expect(ticket.recommendedOption).toBe('reject');

    // The session id ships before the release, or the next claimant loses it.
    expect(calls.events).toEqual([{ taskId: task.id, count: 2 }]);
    expect(lines.join('\n')).toContain('等待审批');
  });

  it('still requeues the task when the ticket cannot be created', async () => {
    const calls: Calls = { tickets: [], completed: [], released: [], events: [], heartbeats: [] };
    const task = makeTask();

    const lines = await run(task, parkedAdapter(), makeClient(task, calls, true));

    expect(calls.tickets).toEqual([]);
    expect(calls.released).toHaveLength(1);
    expect(calls.completed).toEqual([]);
    expect(lines.join('\n')).toContain('建审批工单失败');
  });

  it('does not raise a ticket for an ordinary finished run', async () => {
    const calls: Calls = { tickets: [], completed: [], released: [], events: [], heartbeats: [] };
    const task = makeTask();

    await run(task, finishedAdapter(), makeClient(task, calls));

    expect(calls.tickets).toEqual([]);
    expect(calls.released).toEqual([]);
    expect(calls.completed).toEqual([task.id]);
  });

  it('keeps reporting presence around a parked run', async () => {
    const calls: Calls = { tickets: [], completed: [], released: [], events: [], heartbeats: [] };
    const task = makeTask();

    await run(task, parkedAdapter(), makeClient(task, calls));

    expect(calls.heartbeats.map((beat) => beat.status)).toEqual(['Running', 'Idle']);
  });
});
