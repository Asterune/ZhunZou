import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

import type {
  AgentTask,
  CompleteTaskInput,
  CreateLocalTaskInput,
  CreateTicketInput,
  DecisionTicket,
  EngineEventInput,
  WaitResponse,
} from '@zhunzou/shared';

import { HubApiError, type HubApi } from '../src/hub-client.js';
import type { WakeAdapterName } from '../src/wake/config.js';
import type { LogStream } from '../src/wake/log-sink.js';
import {
  KILL_GRACE_MS,
  resolveWrapAdapter,
  runWrapped,
  wrappableAdapters,
} from '../src/wrappers/runner.js';
import type { ChildExit, SpawnWrapped, WrapIo, WrappedChild } from '../src/wrappers/runner.js';

import { makeTask, makeTicket, testConfig } from './helpers.js';

/**
 * `zz run` gets no real terminal, no real CLI and no real hub here: the
 * spawner, the stdio, the clock and the client are all handed in, and PATH is
 * pointed at a staged directory so the preset lookup is the same on every
 * machine.
 */

const CWD = '/tmp/pte-dojo';
const IDLE_MS = 5_000;
const PERMISSION_LINE =
  '{"type":"permission_required","tool_name":"bash","command":"rm -rf dist"}\n';

let binDir = '';
let emptyBinDir = '';
let realPath = '';

beforeAll(() => {
  realPath = process.env.PATH ?? '';
  binDir = stagedDir(['cursor-agent', 'opencode', 'claude']);
  emptyBinDir = stagedDir([]);
  process.env.PATH = [binDir, realPath].filter(Boolean).join(delimiter());
});

afterAll(() => {
  process.env.PATH = realPath;
  for (const dir of [binDir, emptyBinDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.useRealTimers();
});

function delimiter(): string {
  return process.platform === 'win32' ? ';' : ':';
}

function stagedDir(executables: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-wrap-'));
  for (const name of executables) {
    const path = join(dir, name);
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o755);
  }
  return dir;
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

interface Calls {
  /** Named hops in the order they happened; the sequencing assertions read this. */
  seq: string[];
  localTasks: CreateLocalTaskInput[];
  logs: Array<{ stream: LogStream; chunk: string }>;
  events: EngineEventInput[];
  tickets: Omit<CreateTicketInput, 'env'>[];
  takeovers: Array<{ id: string; reason: string }>;
  waits: string[];
  cancels: string[];
  completions: Array<{ id: string; input: CompleteTaskInput }>;
  releases: string[];
  heartbeats: Array<Record<string, unknown>>;
  spawns: Array<{ binary: string; args: string[]; cwd: string }>;
}

interface HarnessOptions {
  adapter?: WakeAdapterName;
  args?: string[];
  takeover?: boolean;
  title?: string;
  instruction?: string;
  localTask?: (input: CreateLocalTaskInput) => Promise<AgentTask>;
  createTicket?: (input: Omit<CreateTicketInput, 'env'>) => Promise<DecisionTicket>;
  takeoverTask?: (id: string, reason: string) => Promise<AgentTask>;
}

interface Harness {
  calls: Calls;
  lines: string[];
  writes: string[];
  kills: Array<NodeJS.Signals | undefined>;
  emit: (stream: LogStream, chunk: string) => void;
  finish: (exit: ChildExit) => void;
  stdin: (chunk: string) => void;
  signal: (name: 'SIGINT' | 'SIGTERM') => void;
  stdoutText: () => string;
  stderrText: () => string;
  /** Answer the oldest outstanding ticket, the way a human on the dashboard would. */
  answer: (decision: Partial<DecisionTicket>) => void;
  /** Park the run: idle past the threshold with the engine asking permission. */
  park: () => Promise<void>;
  drain: () => Promise<void>;
  settle: () => Promise<number>;
}

function fakeChild(): {
  spawn: SpawnWrapped;
  writes: string[];
  kills: Array<NodeJS.Signals | undefined>;
  emit: Harness['emit'];
  finish: Harness['finish'];
} {
  const outputListeners: Array<(stream: LogStream, chunk: string) => void> = [];
  const exitListeners: Array<(exit: ChildExit) => void> = [];
  const writes: string[] = [];
  const kills: Array<NodeJS.Signals | undefined> = [];
  const child: WrappedChild = {
    write: (chunk) => {
      writes.push(chunk);
    },
    kill: (signal) => {
      kills.push(signal);
    },
    onOutput: (listener) => {
      outputListeners.push(listener);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
    },
  };
  return {
    writes,
    kills,
    spawn: () => child,
    emit: (stream, chunk) => {
      for (const listener of outputListeners) listener(stream, chunk);
    },
    finish: (exit) => {
      for (const listener of exitListeners) listener(exit);
    },
  };
}

function fakeIo(): {
  io: WrapIo;
  stdin: Harness['stdin'];
  signal: Harness['signal'];
  stdoutText: () => string;
  stderrText: () => string;
} {
  const out: string[] = [];
  const err: string[] = [];
  const stdinListeners: Array<(chunk: string) => void> = [];
  const signals: Record<string, Array<() => void>> = {};
  const io: WrapIo = {
    writeStdout: (chunk) => {
      out.push(chunk);
    },
    writeStderr: (chunk) => {
      err.push(chunk);
    },
    onStdin: (listener) => {
      stdinListeners.push(listener);
    },
    onSignal: (name, listener) => {
      signals[name] = [...(signals[name] ?? []), listener];
    },
  };
  return {
    io,
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
    stdin: (chunk) => {
      for (const listener of stdinListeners) listener(chunk);
    },
    signal: (name) => {
      for (const listener of signals[name] ?? []) listener();
    },
  };
}

async function start(options: HarnessOptions = {}): Promise<Harness> {
  const child = fakeChild();
  const terminal = fakeIo();
  const lines: string[] = [];
  const waiters: Array<{
    ticketId: string;
    release: (response: WaitResponse) => void;
  }> = [];
  const task = makeTask({
    id: '77',
    env: 'company-cursor',
    projectName: 'pte-dojo',
    status: 'CLAIMED',
    attempts: 1,
    origin: 'LOCAL_WRAP',
  });
  const calls: Calls = {
    seq: [],
    localTasks: [],
    logs: [],
    events: [],
    tickets: [],
    takeovers: [],
    waits: [],
    cancels: [],
    completions: [],
    releases: [],
    heartbeats: [],
    spawns: [],
  };

  const client = {
    createLocalTask: async (input: CreateLocalTaskInput) => {
      calls.seq.push('local');
      calls.localTasks.push(input);
      return options.localTask ? options.localTask(input) : task;
    },
    appendTaskLog: async (id: string, input: { stream: LogStream; chunk: string }) => {
      calls.seq.push('log');
      calls.logs.push(input);
      return { id: '1', taskId: id, stream: input.stream, chunk: input.chunk, createdAt: 1 };
    },
    reportTaskEvents: async (_id: string, events: EngineEventInput[]) => {
      calls.seq.push('event');
      calls.events.push(...events);
      return events.length;
    },
    createTicket: async (input: Omit<CreateTicketInput, 'env'>) => {
      calls.seq.push('ticket');
      calls.tickets.push(input);
      if (options.createTicket) return options.createTicket(input);
      return makeTicket({ id: '201', projectName: 'pte-dojo', status: 'PENDING_HUMAN' });
    },
    takeoverTask: async (id: string, reason: string) => {
      calls.seq.push('takeover');
      calls.takeovers.push({ id, reason });
      if (options.takeoverTask) return options.takeoverTask(id, reason);
      return { ...task, managedBySupervisor: true };
    },
    wait: async (ticketId: string) => {
      calls.seq.push('wait');
      calls.waits.push(ticketId);
      return new Promise<WaitResponse>((release) => {
        waiters.push({ ticketId, release });
      });
    },
    cancelTicket: async (ticketId: string) => {
      calls.seq.push('cancel');
      calls.cancels.push(ticketId);
      // The hub ends the long-poll on the way out, so a withdrawn ticket stops
      // blocking the wrapper instead of hanging it.
      const settled = waiters.filter((waiter) => waiter.ticketId === ticketId);
      for (const waiter of settled) {
        waiter.release({
          resolved: false,
          timedOut: false,
          ticket: makeTicket({ id: ticketId, status: 'CANCELLED' }),
        });
      }
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (waiters[index]?.ticketId === ticketId) waiters.splice(index, 1);
      }
      return makeTicket({ id: ticketId, status: 'CANCELLED' });
    },
    completeTask: async (id: string, input: CompleteTaskInput) => {
      calls.seq.push('complete');
      calls.completions.push({ id, input });
      return { ...task, status: input.status };
    },
    releaseTask: async (id: string) => {
      calls.seq.push('release');
      calls.releases.push(id);
      return task;
    },
    heartbeat: async (input: Record<string, unknown>) => {
      calls.seq.push('heartbeat');
      calls.heartbeats.push(input);
      return { env: 'company-cursor', ...input, updatedAt: 1 };
    },
  } as unknown as HubApi;

  const spawnChild: SpawnWrapped = (binary, args, cwd) => {
    calls.spawns.push({ binary, args, cwd });
    return child.spawn(binary, args, cwd);
  };

  const run = runWrapped({
    adapter: options.adapter ?? 'cursor-agent',
    args: options.args ?? ['--force', 'fix the login form'],
    cwd: CWD,
    hub: testConfig({ projectName: 'pte-dojo' }),
    client,
    takeover: options.takeover,
    idleMs: IDLE_MS,
    tickIntervalMs: 500,
    pollTimeoutMs: 3_000,
    io: terminal.io,
    spawnChild,
    log: (line) => lines.push(line),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.instruction === undefined ? {} : { instruction: options.instruction }),
  });

  // Registration is awaited before any listener is attached, so nothing can be
  // observed until the microtask queue has drained once.
  const drain = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };
  await drain();

  const settle = async (): Promise<number> => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    return run;
  };

  const parkedOn = IDLE_MS + 1_000;
  return {
    calls,
    lines,
    writes: child.writes,
    kills: child.kills,
    emit: child.emit,
    finish: child.finish,
    stdin: terminal.stdin,
    signal: terminal.signal,
    stdoutText: terminal.stdoutText,
    stderrText: terminal.stderrText,
    answer: (decision) => {
      const waiter = waiters.shift();
      if (!waiter) throw new Error('没有等待中的工单可以应答');
      waiter.release({
        resolved: true,
        timedOut: false,
        ticket: makeTicket({ id: waiter.ticketId, status: 'HUMAN_RESOLVED', ...decision }),
      });
    },
    park: async () => {
      child.emit('stdout', PERMISSION_LINE);
      await vi.advanceTimersByTimeAsync(parkedOn);
    },
    drain,
    settle,
  };
}

/* ------------------------------------------------------------------ */
/* Run, relay, finalise                                                */
/* ------------------------------------------------------------------ */

describe('runWrapped', () => {
  it('registers the run, relays its bytes, and reports DONE (R1)', async () => {
    vi.useFakeTimers();
    const h = await start();

    expect(h.calls.localTasks[0]).toMatchObject({
      title: 'cursor-agent --force "fix the login form"',
      engine: 'cursor',
      repoName: 'pte-dojo',
      workspacePath: CWD,
    });
    expect(h.calls.spawns).toEqual([
      {
        binary: join(binDir, 'cursor-agent'),
        args: ['--force', 'fix the login form'],
        cwd: CWD,
      },
    ]);

    h.emit('stdout', 'hello world\n');
    h.finish({ code: 0, signal: null });

    await expect(h.settle()).resolves.toBe(0);
    expect(h.stdoutText()).toBe('hello world\n');
    expect(h.calls.logs).toContainEqual({ stream: 'stdout', chunk: 'hello world\n' });
    expect(h.calls.completions).toEqual([
      { id: '77', input: { status: 'DONE', result: 'hello world', workspacePath: CWD } },
    ]);
    // The sinks ship before the task is finalised, or the dashboard loses the tail.
    expect(h.calls.seq.lastIndexOf('log')).toBeLessThan(h.calls.seq.indexOf('complete'));
  });

  it('reports FAILED with the tail when the CLI exits non-zero (R2)', async () => {
    vi.useFakeTimers();
    const h = await start();

    h.emit('stderr', 'boom: model overloaded\n');
    h.finish({ code: 1, signal: null });
    await h.settle();

    expect(h.stderrText()).toContain('boom');
    expect(h.calls.completions[0]?.input).toMatchObject({ status: 'FAILED' });
    expect(h.calls.completions[0]?.input.result).toContain('model overloaded');
  });

  it('runs the command anyway when the hub refuses registration (R3)', async () => {
    vi.useFakeTimers();
    const h = await start({
      localTask: () => Promise.reject(new HubApiError(404, 'NOT_FOUND', 'no such route')),
    });

    h.emit('stdout', 'still working\n');
    h.finish({ code: 0, signal: null });

    await expect(h.settle()).resolves.toBe(0);
    expect(h.calls.spawns).toHaveLength(1);
    expect(h.stdoutText()).toContain('still working');
    expect(h.lines.join('\n')).toContain('任务未登记');
    expect(h.calls.logs).toEqual([]);
    expect(h.calls.events).toEqual([]);
    expect(h.calls.completions).toEqual([]);
    expect(h.calls.heartbeats).toEqual([]);
  });

  it('relays keystrokes to the child verbatim (R4)', async () => {
    vi.useFakeTimers();
    const h = await start();

    h.stdin('y\n');
    expect(h.writes).toEqual(['y\n']);
  });

  it('reports engine events with the workspace root it spawned in (R5)', async () => {
    vi.useFakeTimers();
    const h = await start();

    h.emit('stdout', PERMISSION_LINE);
    h.finish({ code: 0, signal: null });
    await h.settle();

    expect(h.calls.events).toContainEqual({
      kind: 'permission_required',
      engine: 'cursor',
      tool: 'bash',
      action: { kind: 'command', command: 'rm -rf dist', workspaceRoot: CWD },
    });
  });

  /* ---------------------------------------------------------------- */
  /* Handover                                                          */
  /* ---------------------------------------------------------------- */

  it('hands an idle, permission-parked run over: ticket, flag, then wait (R6)', async () => {
    vi.useFakeTimers();
    const h = await start();
    await h.park();

    expect(h.calls.seq.indexOf('ticket')).toBeLessThan(h.calls.seq.indexOf('takeover'));
    expect(h.calls.seq.indexOf('takeover')).toBeLessThan(h.calls.seq.indexOf('wait'));
    expect(h.calls.waits).toEqual(['201']);
    expect(h.calls.releases).toEqual([]);
    expect(h.calls.completions).toEqual([]);
    expect(h.calls.takeovers).toEqual([
      { id: '77', reason: '端侧引擎请求批准：bash rm -rf dist（本地无操作）' },
    ]);
    expect(h.calls.tickets[0]).toMatchObject({
      projectName: 'pte-dojo',
      recommendedOption: 'n',
      options: [
        { key: 'y', label: '批准：向终端回写 y', risk: 'caution' },
        { key: 'n', label: '拒绝：向终端回写 n', risk: 'safe' },
      ],
    });
    expect(h.calls.tickets[0]?.blockerQuestion).toContain('rm -rf dist');
    expect(h.lines.join('\n')).toContain('已置 managedBySupervisor=true');

    h.finish({ code: 0, signal: null });
    await h.settle();
  });

  it('writes the approved option back into the terminal (R7)', async () => {
    vi.useFakeTimers();
    const h = await start();
    await h.park();

    h.answer({ selectedOption: 'y' });
    await vi.advanceTimersByTimeAsync(700);
    expect(h.writes).toEqual(['y\n']);
    expect(h.calls.logs).toContainEqual({ stream: 'system', chunk: '远端决策已回写终端：y\n' });
    expect(h.lines.join('\n')).toContain('向终端回写：y');

    h.finish({ code: 0, signal: null });
    await h.settle();
  });

  it('prefers a custom instruction over the option key (R8)', async () => {
    vi.useFakeTimers();
    const h = await start();
    await h.park();

    h.answer({ selectedOption: 'y', customInstruction: '只删 build/ 目录' });
    await h.drain();
    expect(h.writes).toEqual(['只删 build/ 目录\n']);

    h.finish({ code: 0, signal: null });
    await h.settle();
  });

  it('drops a remote answer once the terminal moved on by itself (R9)', async () => {
    vi.useFakeTimers();
    const h = await start();
    await h.park();

    await vi.advanceTimersByTimeAsync(50);
    h.emit('stdout', 'Applying changes to src/login.tsx\n');
    await h.drain();

    h.answer({ selectedOption: 'y' });
    await h.drain();
    expect(h.writes).toEqual([]);
    expect(h.calls.cancels).toEqual(['201']);
    expect(h.lines.join('\n')).toContain('本地已经继续，忽略远端决策');

    h.finish({ code: 0, signal: null });
    await h.settle();
  });

  it('withdraws the ticket the moment somebody types locally (R9b)', async () => {
    vi.useFakeTimers();
    const h = await start();
    await h.park();

    h.stdin('n');
    await h.drain();
    expect(h.writes).toEqual(['n']);
    expect(h.calls.cancels).toEqual(['201']);
    expect(h.lines.join('\n')).toContain('本地已有人应答，已撤回工单 #201');

    h.finish({ code: 0, signal: null });
    await h.settle();
  });

  it('ignores an answer this terminal would not understand (R10)', async () => {
    vi.useFakeTimers();
    const h = await start();
    await h.park();

    h.answer({ selectedOption: 'C' });
    await h.drain();
    expect(h.writes).toEqual([]);
    expect(h.lines.join('\n')).toContain('不是本终端认识的按键');

    h.finish({ code: 0, signal: null });
    await h.settle();
  });

  it('still marks the run supervised when no ticket can be created (R11)', async () => {
    vi.useFakeTimers();
    const h = await start({
      createTicket: () => Promise.reject(new HubApiError(400, 'INVALID', 'project unknown')),
    });
    await h.park();

    expect(h.calls.takeovers).toHaveLength(1);
    expect(h.calls.waits).toEqual([]);

    h.finish({ code: 0, signal: null });
    await expect(h.settle()).resolves.toBe(0);
  });

  it('still waits for a human when the supervised flag cannot be written (R11b)', async () => {
    vi.useFakeTimers();
    const h = await start({
      takeoverTask: () => Promise.reject(new HubApiError(409, 'INVALID_TASK_STATUS', 'gone')),
    });
    await h.park();

    expect(h.calls.waits).toEqual(['201']);
    h.answer({ selectedOption: 'y' });
    await h.drain();
    expect(h.writes).toEqual(['y\n']);

    h.finish({ code: 0, signal: null });
    await h.settle();
  });

  it('cancels an outstanding ticket when the run ends underneath it (R12)', async () => {
    vi.useFakeTimers();
    const h = await start();
    await h.park();

    h.finish({ code: 0, signal: null });
    await h.settle();

    expect(h.calls.cancels).toEqual(['201']);
    expect(h.calls.seq.lastIndexOf('log')).toBeLessThan(h.calls.seq.indexOf('cancel'));
    expect(h.lines.join('\n')).toContain('本地执行已结束，已撤回工单 #201');
  });

  it('stops handing over after three episodes (R18)', async () => {
    vi.useFakeTimers();
    const h = await start();

    for (let episode = 0; episode < 5; episode += 1) {
      await h.park();
      // The human comes back for a keystroke, which retires the ticket and
      // re-arms the judge for the next episode.
      h.stdin(' ');
      await vi.advanceTimersByTimeAsync(700);
    }

    expect(h.calls.tickets).toHaveLength(3);
    expect(h.calls.takeovers).toHaveLength(3);
    expect(h.lines.join('\n')).toContain('不再自动建票');
    expect(h.writes.filter((chunk) => chunk === ' ')).toHaveLength(5);
    expect(h.writes.filter((chunk) => chunk === 'y\n')).toHaveLength(0);

    h.finish({ code: 0, signal: null });
    await h.settle();
  });

  it('stays out of the way when the takeover switch is off', async () => {
    vi.useFakeTimers();
    const h = await start({ takeover: false });
    await h.park();

    expect(h.calls.tickets).toEqual([]);
    expect(h.calls.takeovers).toEqual([]);
  });

  /* ---------------------------------------------------------------- */
  /* Signals, presence, engine names                                   */
  /* ---------------------------------------------------------------- */

  it('gives the first Ctrl-C to the child and kills on the second (R13)', async () => {
    vi.useFakeTimers();
    const h = await start();

    h.signal('SIGINT');
    expect(h.kills).toEqual([]);
    expect(h.lines.join('\n')).toContain('再按一次 Ctrl-C');

    h.signal('SIGINT');
    expect(h.kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(h.kills).toEqual(['SIGTERM', 'SIGKILL']);

    h.finish({ code: null, signal: 'SIGTERM' });
    await expect(h.settle()).resolves.toBe(143);
    expect(h.calls.completions[0]?.input.status).toBe('FAILED');
  });

  it('keeps the env card online while the run lives, and stops after (R14)', async () => {
    vi.useFakeTimers();
    const h = await start();

    expect(h.calls.heartbeats[0]).toMatchObject({
      status: 'Running',
      currentTask: '本地伴随 cursor-agent',
      projectName: 'pte-dojo',
    });
    const before = h.calls.heartbeats.length;

    h.finish({ code: 0, signal: null });
    await h.settle();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(h.calls.heartbeats.length).toBe(before);
  });

  it('resolves the blueprint names to the wrap presets (R15)', () => {
    expect(resolveWrapAdapter('cursor')).toBe('cursor-agent');
    expect(resolveWrapAdapter('OpenCode')).toBe('opencode-run');
    expect(resolveWrapAdapter(' claude ')).toBe('claude');
    expect(wrappableAdapters()).toEqual(
      expect.arrayContaining(['cursor-agent', 'opencode-run', 'claude']),
    );
  });

  it('refuses detecting, shelling and reminding adapters instead of guessing (R16)', () => {
    for (const name of ['auto', 'command', 'notify', 'vim', '']) {
      expect(resolveWrapAdapter(name)).toBeNull();
    }
    expect(wrappableAdapters()).not.toContain('auto');
  });

  it('explains a missing binary instead of registering a task (R17)', async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = emptyBinDir;
    try {
      vi.useFakeTimers();
      const h = await start();
      await expect(h.settle()).resolves.toBe(1);
      expect(h.calls.localTasks).toEqual([]);
      expect(h.calls.spawns).toEqual([]);
      expect(h.lines.join('\n')).toContain('可执行文件');
    } finally {
      vi.useRealTimers();
      process.env.PATH = savedPath;
    }
  });

  it('takes the title and instruction the operator typed', async () => {
    vi.useFakeTimers();
    const h = await start({
      title: '  重跑 ERP 导入用例  ',
      instruction: '重跑导入用例，失败就把日志贴出来',
    });

    expect(h.calls.localTasks[0]).toMatchObject({
      title: '重跑 ERP 导入用例',
      instruction: '重跑导入用例，失败就把日志贴出来',
    });
    h.finish({ code: 0, signal: null });
    await h.settle();
  });
});
