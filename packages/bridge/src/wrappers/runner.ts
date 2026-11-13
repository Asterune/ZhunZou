/**
 * `zz run` — wrap a local agent CLI.
 *
 * The human keeps their own terminal: bytes go through in both directions
 * untouched and the wrapper only watches. Watching buys the other half — when
 * nobody is at the keyboard and the CLI is parked on a confirmation or an
 * error, the run is registered, the question becomes a ticket, and the answer
 * (whoever gives it) is written back into the terminal.
 *
 * Every hub call is optional: if registration fails the CLI still runs, which
 * is the only acceptable behaviour for a command people type by hand.
 */

import { spawn } from 'node:child_process';

import type { AgentTask, DecisionTicket, EngineEventInput } from '@zhunzou/shared';
import { isTerminalStatus } from '@zhunzou/shared';

import type { BridgeConfig } from '../config.js';
import { detectWorkspaceProject } from '../config.js';
import { HubApiError, type HubApi } from '../hub-client.js';
import { createPresenceReporter } from '../presence.js';
import { agentKindForAdapter, findPresetBinary } from '../wake/adapters.js';
import type { WakeAdapterName } from '../wake/config.js';
import { WAKE_ADAPTERS } from '../wake/config.js';
import { createEventSink, type EventSink } from '../wake/event-sink.js';
import { createEventPipeline, profileForAdapter } from '../wake/events.js';
import { createLogSink, type LogSink, type LogStream } from '../wake/log-sink.js';
import {
  HANDOVER_OPTIONS,
  MAX_HANDOFFS,
  RELAY_KEYS,
  TAIL_BYTES,
  createHandoverJudge,
  parseIdleMs,
  type StuckSignal,
} from './idle.js';

/** Names that cannot be wrapped: they detect, shell out, or only remind. */
const UNWRAPPABLE: readonly WakeAdapterName[] = ['auto', 'command', 'notify'];

/** The blueprint's friendly names. */
const WRAP_ALIASES: Record<string, WakeAdapterName> = {
  cursor: 'cursor-agent',
  opencode: 'opencode-run',
};

const DEFAULT_TICK_MS = 15_000;
const RESULT_CHARS = 4_000;
/** How long a SIGTERM gets before the child is killed outright. */
export const KILL_GRACE_MS = 2_000;

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** The child, as far as the wrapper is concerned: two streams, one stdin, one exit. */
export interface WrappedChild {
  write: (chunk: string) => void;
  kill: (signal?: NodeJS.Signals) => void;
  onOutput: (listener: (stream: LogStream, chunk: string) => void) => void;
  onExit: (listener: (exit: ChildExit) => void) => void;
}

export type SpawnWrapped = (
  binary: string,
  args: string[],
  cwd: string,
) => WrappedChild;

/** The human's terminal, injectable so tests never need one. */
export interface WrapIo {
  writeStdout: (chunk: string) => void;
  writeStderr: (chunk: string) => void;
  onStdin: (listener: (chunk: string) => void) => void;
  onSignal: (name: 'SIGINT' | 'SIGTERM', listener: () => void) => void;
}

export interface RunWrappedOptions {
  adapter: WakeAdapterName;
  /** Passed to the child verbatim; never through a shell. */
  args: string[];
  cwd: string;
  hub: BridgeConfig;
  client: HubApi;
  /** Override what the hub is told this run is. */
  title?: string;
  instruction?: string;
  /** `--no-takeover` turns auto-handover off. */
  takeover?: boolean;
  idleMs?: number;
  quietMs?: number;
  tickIntervalMs?: number;
  pollTimeoutMs?: number;
  io?: WrapIo;
  spawnChild?: SpawnWrapped;
  now?: () => number;
  log?: (line: string) => void;
}

/** Adapters `zz run` is willing to wrap on this machine. */
export function wrappableAdapters(): WakeAdapterName[] {
  return WAKE_ADAPTERS.filter(
    (name) =>
      !(UNWRAPPABLE as readonly string[]).includes(name) &&
      findPresetBinary(name) !== undefined,
  );
}

/**
 * Resolve the engine name a person typed. Null means "this cannot be wrapped":
 * the caller lists what can instead of guessing a binary.
 *
 * The friendly alias wins over the bare adapter name where both exist, because
 * `opencode` is the dashboard-injection adapter and only `opencode-run` is a
 * CLI that can be attached to a terminal.
 */
export function resolveWrapAdapter(raw: string): WakeAdapterName | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  const known = (WAKE_ADAPTERS as readonly string[]).includes(value)
    ? (value as WakeAdapterName)
    : undefined;
  const available = wrappableAdapters();
  const candidates = [WRAP_ALIASES[value], known].filter(
    (candidate): candidate is WakeAdapterName => candidate !== undefined,
  );
  return candidates.find((candidate) => available.includes(candidate)) ?? null;
}

function describeSignal(event: EngineEventInput): string {
  const detail = [event.tool, event.action?.command ?? event.action?.paths?.[0]]
    .filter(Boolean)
    .join(' ');
  return `端侧引擎请求批准${detail ? `：${truncate(detail, 200)}` : ''}`;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function displayArg(value: string): string {
  return /^[\w.\-/:@=,+%]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exitCodeOf(exit: ChildExit): number {
  if (exit.code !== null) return exit.code;
  if (exit.signal === 'SIGINT') return 130;
  if (exit.signal === 'SIGTERM') return 143;
  return 1;
}

const NOOP_LOG_SINK: LogSink = { push: () => {}, close: async () => {} };
const NOOP_EVENT_SINK: EventSink = { push: () => {}, close: async () => {} };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

export async function runWrapped(options: RunWrappedOptions): Promise<number> {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((line: string) => process.stderr.write(`[zhunzou] ${line}\n`));
  const io = options.io ?? defaultIo();
  const spawnChild = options.spawnChild ?? defaultSpawn;
  const takeoverEnabled = options.takeover !== false;
  const idleMs = options.idleMs ?? parseIdleMs(process.env.ZHUNZOU_WRAP_IDLE_MS);
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_MS;
  const pollTimeoutMs =
    options.pollTimeoutMs ?? Math.min(options.hub.waitTimeoutMs, 55_000);

  const binary = findPresetBinary(options.adapter);
  if (!binary) {
    log(`找不到 ${options.adapter} 的可执行文件（PATH 中不存在）`);
    return 1;
  }

  const commandLine = [options.adapter, ...options.args.map(displayArg)].join(' ');
  const repoName = detectWorkspaceProject(options.cwd);
  const engine = agentKindForAdapter(options.adapter);

  // Registration is the only thing that can fail the command, and it must not:
  // an unwrapped run is strictly better than a refused one.
  let task: AgentTask | null = null;
  try {
    const title = options.title?.trim() || commandLine;
    const instruction = options.instruction?.trim() || commandLine;
    task = await options.client.createLocalTask({
      title: truncate(title, 200),
      instruction: truncate(instruction, 2_000),
      engine,
      ...(options.hub.projectName ? { projectName: options.hub.projectName } : {}),
      ...(repoName ? { repoName } : {}),
      workspacePath: options.cwd,
    });
    log(`本地伴随已登记为任务 #${task.id}（origin LOCAL_WRAP，不进队列）`);
  } catch (error) {
    log(`任务未登记：${messageOf(error)}；本地继续执行`);
  }

  const registered = task;
  const logSink = registered
    ? createLogSink(
        (stream, chunk) => options.client.appendTaskLog(registered.id, { stream, chunk }),
        (message) => log(`日志上报：${message}`),
      )
    : NOOP_LOG_SINK;
  const eventSink = registered
    ? createEventSink(
        (events) => options.client.reportTaskEvents(registered.id, events),
        (message) => log(`事件上报：${message}`),
      )
    : NOOP_EVENT_SINK;

  const judge = createHandoverJudge({
    startedAt: now(),
    idleMs,
    ...(options.quietMs === undefined ? {} : { quietMs: options.quietMs }),
  });

  let tail = '';
  let running = true;
  let stopping = false;
  let warnExhausted = false;
  let outstanding: DecisionTicket | null = null;
  let handover: Promise<void> = Promise.resolve();

  let resolveExit: (exit: ChildExit) => void = () => {};
  const exited = new Promise<ChildExit>((resolve) => {
    resolveExit = resolve;
  });
  let resolveStop: () => void = () => {};
  const stopped = new Promise<null>((resolve) => {
    resolveStop = () => resolve(null);
  });

  const pipeline = createEventPipeline({
    profile: profileForAdapter(options.adapter),
    engine,
    workspaceRoot: options.cwd,
    forward: (stream, chunk) => {
      logSink.push(stream, chunk);
      if (stream === 'stderr') io.writeStderr(chunk);
      else io.writeStdout(chunk);
    },
    onEvent: (event) => eventSink.push(event),
    onPermission: (event) => judge.notePermission(describeSignal(event), now()),
  });

  const child = spawnChild(binary, options.args, options.cwd);
  child.onOutput((stream, chunk) => {
    tail = `${tail}${chunk}`.slice(-TAIL_BYTES);
    judge.noteOutput(now(), tail);
    pipeline.push(stream, chunk);
  });
  child.onExit((exit) => {
    running = false;
    stopping = true;
    resolveStop();
    resolveExit(exit);
  });

  io.onStdin((chunk) => {
    judge.noteActivity(now());
    // A handover only exists while nobody is here. The moment somebody types,
    // the question is theirs again and the ticket has to stop waiting.
    if (outstanding) void withdraw(outstanding, '本地已有人应答');
    child.write(chunk);
  });

  let interrupts = 0;
  io.onSignal('SIGINT', () => {
    interrupts += 1;
    if (interrupts === 1) {
      // The terminal sends the same signal to the child, which normally only
      // interrupts its current step. Killing the wrapper here would stop the
      // watching, not the run.
      log('中断已交给子进程；再按一次 Ctrl-C 结束伴随');
      return;
    }
    stopChild();
  });
  io.onSignal('SIGTERM', () => stopChild());

  function stopChild(): void {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref?.();
  }

  const presence = registered
    ? createPresenceReporter(options.client, {
        intervalMs: options.hub.heartbeatIntervalMs,
        ...(options.hub.projectName
          ? { projectName: options.hub.projectName }
          : {}),
        initial: {
          status: 'Running',
          currentTask: `本地伴随 ${options.adapter}`,
        },
        onError: (error) => log(`心跳失败：${messageOf(error)}`),
      })
    : null;
  presence?.start();

  const handoverFor = async (signal: StuckSignal): Promise<void> => {
    if (!registered || !takeoverEnabled || stopping) return;
    log(`本地已 ${Math.round(idleMs / 1000)}s 无操作，${signal.summary} → 交给 Hub 管家`);
    logSink.push('system', `[handover] ${signal.kind}: ${signal.summary}\n`);
    const handedOverAt = judge.handedOverAt ?? now();

    let ticket: DecisionTicket | null = null;
    try {
      ticket = await options.client.createTicket({
        projectName: registered.projectName ?? options.hub.projectName ?? registered.env,
        doneSummary: truncate(
          `本地终端任务 #${registered.id}「${registered.title}」停在需要确认的一步`,
          500,
        ),
        blockerQuestion: `${signal.summary}\n具体内容：${signal.evidence}`,
        nextStepPlan: '批准后把选项原样写回本地终端继续执行；拒绝则回写 n 结束这一步。',
        options: HANDOVER_OPTIONS,
        recommendedOption: 'n',
      });
      outstanding = ticket;
      log(`已生成工单 #${ticket.id}`);
    } catch (error) {
      log(`接管工单创建失败：${messageOf(error)}`);
    }

    try {
      await options.client.takeoverTask(registered.id, `${signal.summary}（本地无操作）`);
      log('已置 managedBySupervisor=true');
    } catch (error) {
      log(`托管标记写入失败：${messageOf(error)}`);
    }

    // No ticket means nobody to ask, so there is nothing to wait for. The flag
    // above still says the run is unattended, which is what Step 3.2 reads.
    if (!ticket) return;
    await awaitResolution(ticket.id, handedOverAt);
  };

  const awaitResolution = async (ticketId: string, handedOverAt: number): Promise<void> => {
    for (;;) {
      if (stopping) return;
      const pending = options.client.wait(ticketId, pollTimeoutMs);
      let outcome;
      try {
        outcome = await Promise.race([pending, stopped]);
      } catch (error) {
        if (error instanceof HubApiError && !error.retryable) {
          log(`等待工单失败：${messageOf(error)}`);
          return;
        }
        // Transient: back off for one poll window, but never past the exit.
        if (await Promise.race([delay(pollTimeoutMs), stopped])) return;
        continue;
      }
      if (outcome === null) return;
      if (outcome.resolved) {
        relay(outcome.ticket, handedOverAt);
        return;
      }
      if (isTerminalStatus(outcome.ticket.status)) return;
    }
  };

  const relay = (ticket: DecisionTicket, handedOverAt: number): void => {
    const custom = ticket.customInstruction?.trim();
    const option = ticket.selectedOption ?? '';
    const answer = custom ? custom : RELAY_KEYS.includes(option) ? option : null;

    if (!answer) {
      log(
        `工单 #${ticket.id} 的选择「${option || '空'}」不是本终端认识的按键，未回写`,
      );
      return;
    }
    if (!running) {
      log('子进程已结束，未回写远端决策');
      return;
    }
    if (judge.movedOnSince(handedOverAt)) {
      log('本地已经继续，忽略远端决策');
      void withdraw(ticket, '本地已经继续');
      return;
    }

    child.write(`${answer}\n`);
    logSink.push('system', `远端决策已回写终端：${answer}\n`);
    log(`已按工单 #${ticket.id} 向终端回写：${answer}`);
  };

  const withdraw = async (ticket: DecisionTicket, why: string): Promise<void> => {
    if (outstanding?.id !== ticket.id) return;
    outstanding = null;
    try {
      await options.client.cancelTicket(ticket.id);
      log(`${why}，已撤回工单 #${ticket.id}`);
    } catch {
      // Already answered or already cancelled: there is nothing to take back.
    }
  };

  const tick = setInterval(() => {
    if (stopping) return;
    const signal = judge.evaluate(now(), running);
    if (signal) {
      handover = handover.then(() => handoverFor(signal));
      return;
    }
    if (running && judge.exhausted && !warnExhausted) {
      warnExhausted = true;
      log(`本轮已托管 ${MAX_HANDOFFS} 次，不再自动建票；本地执行继续`);
    }
  }, tickIntervalMs);
  tick.unref?.();

  const exit = await exited;
  clearInterval(tick);
  presence?.stop();

  pipeline.end();
  await eventSink.close();
  await logSink.close();

  if (outstanding) await withdraw(outstanding, '本地执行已结束');

  if (registered) {
    const ok = exit.code === 0;
    try {
      await options.client.completeTask(registered.id, {
        status: ok ? 'DONE' : 'FAILED',
        result:
          truncate(tail.trim(), RESULT_CHARS) ||
          (ok ? '本地伴随执行完成' : '本地伴随执行失败（无输出）'),
        workspacePath: options.cwd,
      });
    } catch (error) {
      log(`完成回报失败：${messageOf(error)}`);
    }
  }

  await handover;
  return exitCodeOf(exit);
}

function defaultIo(): WrapIo {
  return {
    writeStdout: (chunk) => {
      process.stdout.write(chunk);
    },
    writeStderr: (chunk) => {
      process.stderr.write(chunk);
    },
    onStdin: (listener) => {
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
      process.stdin.on('data', (chunk: string) => listener(chunk));
    },
    onSignal: (name, listener) => {
      process.on(name, listener);
    },
  };
}

/**
 * Piped stdio on all three, not a pty: the child sees a non-TTY stdout, so what
 * this supports is print/stream mode (the profiles in `wake/events.ts`), not a
 * full-screen TUI. Bytes are relayed unchanged, so a line-oriented `y/n` prompt
 * works as if the human were talking to the CLI directly.
 */
function defaultSpawn(binary: string, args: string[], cwd: string): WrappedChild {
  const child = spawn(binary, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });

  const outputListeners: Array<(stream: LogStream, chunk: string) => void> = [];
  const exitListeners: Array<(exit: ChildExit) => void> = [];

  const emitOutput = (stream: LogStream, chunk: Buffer | string): void => {
    const text = chunk.toString();
    for (const listener of outputListeners) listener(stream, text);
  };

  child.stdout?.on('data', (chunk: Buffer) => emitOutput('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => emitOutput('stderr', chunk));
  child.on('error', (error: Error) => {
    emitOutput('stderr', `${error.message}\n`);
    for (const listener of exitListeners) listener({ code: null, signal: null });
  });
  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    for (const listener of exitListeners) listener({ code, signal });
  });

  return {
    write: (chunk) => {
      child.stdin?.write(chunk);
    },
    kill: (signal) => {
      child.kill(signal);
    },
    onOutput: (listener) => {
      outputListeners.push(listener);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
    },
  };
}
