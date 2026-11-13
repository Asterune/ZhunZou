import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

import type {
  AgentKind,
  AgentTask,
  EngineEventInput,
  PermissionActionInput,
} from '@zhunzou/shared';
import { isArgvSafeSessionId } from '@zhunzou/shared';

import type { WakeAdapterName, WakeConfig } from './config.js';
import { NOTIFY_ADAPTERS } from './config.js';
import type { LogStream } from './log-sink.js';
import { buildInjectPrompt, buildRunPrompt } from './prompt.js';
import { createEventPipeline, profileForAdapter } from './events.js';

export type WakeDelivery = 'inject' | 'run' | 'notify';

export interface WakeCompletion {
  status: 'DONE' | 'FAILED';
  result?: string;
}

/** Why a run stopped early: the engine wants a human to approve something. */
export interface WakeParked {
  reason: string;
  tool?: string;
  action?: PermissionActionInput;
}

export interface WakeOutcome {
  delivery: WakeDelivery;
  /** Present when the daemon should record the result itself. */
  completion?: WakeCompletion;
  /** Present when the daemon should raise a ticket and hand the task back. */
  parked?: WakeParked;
}

export interface WakeContext {
  config: WakeConfig;
  projectName?: string;
  log: (message: string) => void;
  /** Stream execution output to the hub (best effort; never throws). */
  reportLog?: (
    stream: 'stdout' | 'stderr' | 'system',
    chunk: string,
  ) => void;
  /** Report one normalised engine event (best effort; never throws). */
  reportEvent?: (event: EngineEventInput) => void;
}

export interface WakeAdapter {
  readonly name: WakeAdapterName;
  readonly delivery: WakeDelivery;
  wake(task: AgentTask, context: WakeContext): Promise<WakeOutcome>;
}

/* ------------------------------------------------------------------ */
/* Process helpers                                                     */
/* ------------------------------------------------------------------ */

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_CAPTURE = 200_000;

function appendCapture(buffer: string, chunk: Buffer | string): string {
  const next = buffer + chunk.toString();
  return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
}

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  shell?: boolean;
  /** Stops the child early, e.g. when the engine asks for an approval. */
  signal?: AbortSignal;
  onOutput?: (
    stream: LogStream,
    chunk: string,
  ) => void;
}

export function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolvePromise({ code, stdout, stderr, timedOut });
    };

    const stop = (): void => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
    };

    function onAbort(): void {
      stop();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    timer.unref?.();

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendCapture(stdout, chunk);
      options.onOutput?.('stdout', chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendCapture(stderr, chunk);
      options.onOutput?.('stderr', chunk.toString());
    });
    child.on('error', (error: Error) => {
      stderr = appendCapture(stderr, `${error.message}\n`);
      options.onOutput?.('stderr', `${error.message}\n`);
      finish(null);
    });
    child.on('close', (code: number | null) => finish(code));
  });
}

/** Locate an executable on PATH without spawning a shell. */
export function whichSync(binary: string): string | undefined {
  const pathValue = process.env.PATH ?? '';
  if (!pathValue) return undefined;
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${binary}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

function tail(text: string, limit = 4_000): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? trimmed.slice(trimmed.length - limit) : trimmed;
}

/* ------------------------------------------------------------------ */
/* Shell helpers (command adapter)                                     */
/* ------------------------------------------------------------------ */

export function shellQuote(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Expand `{prompt}` and friends with shell-escaped task values. */
export function renderCommandTemplate(
  template: string,
  task: AgentTask,
  cwd: string,
): string {
  const values: Record<string, string> = {
    prompt: buildRunPrompt(task),
    instruction: task.instruction,
    title: task.title,
    taskId: String(task.id),
    project: task.projectName ?? '',
    env: task.env,
    cwd,
  };
  // An unusable id keeps the literal placeholder rather than expanding to an
  // empty string, which a CLI would read as "session " instead of "no session".
  if (isArgvSafeSessionId(task.sessionId)) values.sessionId = task.sessionId;

  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : shellQuote(value);
  });
}

/* ------------------------------------------------------------------ */
/* Output watching                                                     */
/* ------------------------------------------------------------------ */

export interface RunWatch {
  push: (stream: LogStream, chunk: string) => void;
  /** Flush whatever the last chunk left half-parsed. */
  finish: () => void;
  /** Passed to `runProcess`; fires as soon as the engine asks for approval. */
  signal: AbortSignal;
  parked: () => WakeParked | undefined;
}

/**
 * Watch one child process. Raw bytes go on to the log sink untouched, the
 * structured reading of them goes to the hub, and a request for approval stops
 * the run so that a human — not this daemon — can answer it.
 */
export function createRunWatch(
  adapter: WakeAdapterName,
  context: WakeContext,
  cwd: string,
): RunWatch {
  const controller = new AbortController();
  let parked: WakeParked | undefined;

  const pipeline = createEventPipeline({
    profile: profileForAdapter(adapter),
    engine: agentKindForAdapter(adapter),
    workspaceRoot: cwd,
    forward: (stream, chunk) => context.reportLog?.(stream, chunk),
    onEvent: (event) => context.reportEvent?.(event),
    onPermission: (event) => {
      if (parked) return;
      parked = describePermission(event);
      context.log(`${parked.reason}，已释放子进程`);
      controller.abort();
    },
  });

  return {
    push: (stream, chunk) => pipeline.push(stream, chunk),
    finish: () => pipeline.end(),
    signal: controller.signal,
    parked: () => parked,
  };
}

/** Turn an approval request into the line a human reads in a ticket. */
function describePermission(event: EngineEventInput): WakeParked {
  const command = event.action?.command;
  const path = (event.action?.paths ?? [])[0];
  const detail = [event.tool, command ?? path].filter(Boolean).join(' ');
  return {
    reason: `端侧引擎请求批准${detail ? `：${truncateText(detail, 200)}` : ''}`,
    ...(event.tool ? { tool: event.tool } : {}),
    ...(event.action ? { action: event.action } : {}),
  };
}

function truncateText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/**
 * Arguments that resume this task where it stopped. The id comes from the
 * engine's own output, so it is re-checked before it can reach argv.
 */
function resumeArgsFor(
  preset: Preset,
  task: AgentTask,
  context: WakeContext,
): string[] {
  if (!preset.resumeArgs || !task.sessionId) return [];
  if (!isArgvSafeSessionId(task.sessionId)) {
    context.log(`sessionId 不合 argv 规范，跳过续跑：${truncateText(task.sessionId, 80)}`);
    return [];
  }
  return preset.resumeArgs(task.sessionId);
}


/* ------------------------------------------------------------------ */
/* CLI presets                                                         */
/* ------------------------------------------------------------------ */

interface Preset {
  name: WakeAdapterName;
  binary: string;
  /** Alternative executable names on PATH (installers disagree on the name). */
  aliases?: string[];
  args: (prompt: string, extra: string[]) => string[];
  /** How this CLI picks up a previous session, if we know its syntax. */
  resumeArgs?: (sessionId: string) => string[];
}

const RESUME_ARGS = (sessionId: string): string[] => ['--resume', sessionId];

const PRESETS: Record<string, Preset> = {
  'opencode-run': {
    name: 'opencode-run',
    binary: 'opencode',
    args: (prompt, extra) => ['run', '--auto', ...extra, prompt],
    // Same shape `session.ts` uses for chat, where it is already in production.
    resumeArgs: (sessionId) => ['--session', sessionId],
  },
  claude: {
    name: 'claude',
    binary: 'claude',
    args: (prompt, extra) => ['-p', ...extra, prompt],
    resumeArgs: RESUME_ARGS,
  },
  codex: {
    name: 'codex',
    binary: 'codex',
    args: (prompt, extra) => ['exec', ...extra, prompt],
  },
  gemini: {
    name: 'gemini',
    binary: 'gemini',
    args: (prompt, extra) => ['-p', ...extra, prompt],
  },
  qoder: {
    name: 'qoder',
    binary: 'qoder',
    // Native installs expose `qoder`, npm installs `qodercli`; some setups
    // alias the CLI as `qcode`.
    aliases: ['qodercli', 'qcode'],
    args: (prompt, extra) => ['-p', ...extra, prompt],
    resumeArgs: RESUME_ARGS,
  },
  'cursor-agent': {
    name: 'cursor-agent',
    binary: 'cursor-agent',
    // Print mode only proposes edits unless --force is set; a dispatched task
    // is expected to actually apply its changes.
    args: (prompt, extra) => ['-p', '--force', ...extra, prompt],
    resumeArgs: RESUME_ARGS,
  },
  aider: {
    name: 'aider',
    binary: 'aider',
    args: (prompt, extra) => ['--message', ...extra, prompt],
  },
  goose: {
    name: 'goose',
    binary: 'goose',
    args: (prompt, extra) => ['run', '-t', ...extra, prompt],
  },
  amp: {
    name: 'amp',
    binary: 'amp',
    args: (prompt, extra) => ['-x', ...extra, prompt],
  },
};

/** Detection order for `auto`: the clients Zhunzou ships templates for first. */
const AUTO_ORDER: WakeAdapterName[] = [
  'claude',
  'codex',
  'gemini',
  'qoder',
  'cursor-agent',
  'aider',
  'goose',
  'amp',
];

function presetBinary(preset: Preset): string | undefined {
  for (const name of [preset.binary, ...(preset.aliases ?? [])]) {
    const found = whichSync(name);
    if (found) return found;
  }
  return undefined;
}

/** Executable a preset would spawn, searching PATH (installer aliases included). */
export function findPresetBinary(name: WakeAdapterName): string | undefined {
  const preset = PRESETS[name];
  return preset ? presetBinary(preset) : undefined;
}

function createPresetAdapter(preset: Preset): WakeAdapter {
  return {
    name: preset.name,
    delivery: 'run',
    async wake(task, context) {
      const binary = presetBinary(preset);
      if (!binary) {
        throw new Error(`找不到 ${preset.binary} 可执行文件（PATH 中不存在）`);
      }

      const prompt = buildRunPrompt(task);
      const resume = resumeArgsFor(preset, task, context);
      context.log(
        `spawn ${preset.binary} (run mode, cwd=${context.config.cwd})` +
          (resume.length ? ` resume=${task.sessionId}` : ''),
      );
      const watch = createRunWatch(preset.name, context, context.config.cwd);
      const result = await runProcess(
        binary,
        preset.args(prompt, [...context.config.extraArgs, ...resume]),
        {
          cwd: context.config.cwd,
          timeoutMs: context.config.runTimeoutMs,
          signal: watch.signal,
          onOutput: watch.push,
        },
      );
      watch.finish();

      const parked = watch.parked();
      if (parked) {
        // No completion: the task goes back to the queue with the session id
        // already stored, so whoever claims it next can resume in place.
        return { delivery: 'run', parked };
      }

      if (result.timedOut) {
        return {
          delivery: 'run',
          completion: {
            status: 'FAILED',
            result: `端侧 ${preset.binary} 执行超时（${Math.round(
              context.config.runTimeoutMs / 1000,
            )}s），已终止`,
          },
        };
      }

      const ok = result.code === 0;
      const output = ok ? result.stdout : result.stderr || result.stdout;
      return {
        delivery: 'run',
        completion: {
          status: ok ? 'DONE' : 'FAILED',
          result: tail(output) || (ok ? '端侧执行完成' : '端侧执行失败（无输出）'),
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Command adapter — the universal escape hatch                        */
/* ------------------------------------------------------------------ */

function createCommandAdapter(config: WakeConfig): WakeAdapter {
  return {
    name: 'command',
    delivery: 'run',
    async wake(task, context) {
      if (!config.command) {
        throw new Error(
          'command 适配器需要设置 ZHUNZOU_WAKE_COMMAND（例如 claude -p {prompt}）',
        );
      }

      const template = renderCommandTemplate(config.command, task, config.cwd);
      context.log(`spawn command: ${template.slice(0, 160)}`);
      const watch = createRunWatch('command', context, config.cwd);
      const result = await runProcess(
        process.platform === 'win32' ? 'cmd' : 'sh',
        process.platform === 'win32' ? ['/c', template] : ['-c', template],
        {
          cwd: config.cwd,
          env: {
            ...process.env,
            ZHUNZOU_TASK_ID: String(task.id),
            ZHUNZOU_TASK_TITLE: task.title,
            ZHUNZOU_TASK_INSTRUCTION: task.instruction,
            ZHUNZOU_TASK_ENV: task.env,
            ZHUNZOU_TASK_PROJECT: task.projectName ?? '',
            ZHUNZOU_PROMPT: buildRunPrompt(task),
            ZHUNZOU_WORKDIR: config.cwd,
            ...(isArgvSafeSessionId(task.sessionId)
              ? { ZHUNZOU_SESSION_ID: task.sessionId }
              : {}),
          },
          timeoutMs: config.runTimeoutMs,
          signal: watch.signal,
          onOutput: watch.push,
        },
      );
      watch.finish();

      const parked = watch.parked();
      if (parked) {
        return { delivery: 'run', parked };
      }

      if (result.timedOut) {
        return {
          delivery: 'run',
          completion: {
            status: 'FAILED',
            result: `唤醒命令执行超时（${Math.round(config.runTimeoutMs / 1000)}s），已终止`,
          },
        };
      }

      const ok = result.code === 0;
      const output = ok ? result.stdout : result.stderr || result.stdout;
      return {
        delivery: 'run',
        completion: {
          status: ok ? 'DONE' : 'FAILED',
          result: tail(output) || (ok ? '唤醒命令执行完成' : '唤醒命令执行失败（无输出）'),
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* OpenCode adapter — inject into the live session                     */
/* ------------------------------------------------------------------ */

interface OpenCodeSessionShape {
  id?: unknown;
  time?: { updated?: unknown };
}

async function findOpenCodeSession(cwd: string): Promise<string | undefined> {
  const query = new URLSearchParams({ directory: cwd, order: 'desc', limit: '5' });
  const result = await runProcess(
    'opencode',
    ['api', 'get', `/api/session?${query.toString()}`],
    { cwd, timeoutMs: 20_000 },
  );
  if (result.code !== 0) return undefined;

  try {
    const parsed = JSON.parse(result.stdout) as { data?: OpenCodeSessionShape[] };
    const sessions = Array.isArray(parsed.data) ? parsed.data : [];
    const session = sessions.find((entry) => typeof entry?.id === 'string');
    return typeof session?.id === 'string' ? session.id : undefined;
  } catch {
    return undefined;
  }
}

async function injectOpenCode(
  task: AgentTask,
  context: WakeContext,
): Promise<boolean> {
  const sessionID = await findOpenCodeSession(context.config.cwd);
  if (!sessionID) {
    context.log('没有找到可注入的 OpenCode 会话');
    return false;
  }

  const payload = JSON.stringify({ text: buildInjectPrompt(task), resume: true });
  const result = await runProcess(
    'opencode',
    ['api', 'post', `/api/session/${sessionID}/synthetic`, '--data', payload],
    { cwd: context.config.cwd, timeoutMs: 30_000 },
  );

  if (result.code !== 0) {
    context.log(
      `OpenCode 注入失败：${tail(result.stderr || result.stdout, 300)}`,
    );
    return false;
  }

  context.log(`已注入 OpenCode 会话 ${sessionID}`);
  return true;
}

function createOpenCodeAdapter(config: WakeConfig): WakeAdapter {
  const fallback = createPresetAdapter(PRESETS['opencode-run']!);

  return {
    name: 'opencode',
    delivery: 'inject',
    async wake(task, context) {
      if (await injectOpenCode(task, context)) {
        return { delivery: 'inject' };
      }

      // No live service (or injection failed): fall back to a one-shot run so
      // the task still executes while OpenCode is closed.
      context.log('回退到 `opencode run` 一次性执行');
      return fallback.wake(task, { ...context, config });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Notify adapter — reminder only, never claims                        */
/* ------------------------------------------------------------------ */

export async function notifyTask(
  task: AgentTask,
  context: WakeContext,
): Promise<void> {
  const title = `准奏 · 新任务 #${task.id}`;
  const body = `${task.projectName ?? task.env}：${task.title}`;

  if (process.platform === 'darwin') {
    await runProcess(
      'osascript',
      [
        '-e',
        `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`,
      ],
      { timeoutMs: 5_000 },
    ).catch(() => undefined);
    return;
  }

  if (process.platform === 'linux') {
    await runProcess('notify-send', [title, body], { timeoutMs: 5_000 }).catch(
      () => undefined,
    );
    return;
  }

  // Windows / others: the daemon log is the notification channel.
  context.log(`${title} ${body}`);
}

function createNotifyAdapter(): WakeAdapter {
  return {
    name: 'notify',
    delivery: 'notify',
    async wake(task) {
      return { delivery: 'notify' };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

export function isNotifyAdapter(name: WakeAdapterName): boolean {
  return NOTIFY_ADAPTERS.includes(name);
}

/**
 * The adapter `auto` resolves to from PATH alone. Env naming uses this so a
 * fleet project lands on the same `<client>-<project>` label `init` writes
 * into the editor's MCP config; tickets and task reports then share one env.
 */
export function detectAutoAdapter(): WakeAdapterName {
  if (whichSync('opencode')) return 'opencode';
  for (const name of AUTO_ORDER) {
    const candidate = PRESETS[name];
    if (candidate && presetBinary(candidate)) return name;
  }
  return 'notify';
}

/**
 * Guess which local client `auto` will hand tasks to, using the same order as
 * {@link resolveWakeAdapter}. Registration runs before that resolution, so it
 * must not report every auto project as "other".
 */
export function detectAgentKind(): AgentKind {
  return agentKindForAdapter(detectAutoAdapter());
}

const ADAPTER_KINDS: Partial<Record<WakeAdapterName, AgentKind>> = {
  opencode: 'opencode',
  'opencode-run': 'opencode',
  claude: 'claude-code',
  codex: 'codex',
  gemini: 'gemini',
  qoder: 'qoder',
  'cursor-agent': 'cursor',
};

/** Map a wake adapter to the client kind shown on the dashboard. */
export function agentKindForAdapter(adapter: WakeAdapterName): AgentKind {
  if (adapter === 'auto') return detectAgentKind();
  return ADAPTER_KINDS[adapter] ?? 'other';
}

export async function resolveWakeAdapter(config: WakeConfig): Promise<WakeAdapter> {
  const requested = config.adapter;

  if (requested === 'notify') return createNotifyAdapter();
  if (requested === 'command') return createCommandAdapter(config);
  if (requested === 'opencode') return createOpenCodeAdapter(config);

  const preset = PRESETS[requested];
  if (preset) return createPresetAdapter(preset);

  // auto: prefer a live OpenCode service, then any recognised CLI agent.
  if (whichSync('opencode')) {
    return createOpenCodeAdapter(config);
  }

  for (const name of AUTO_ORDER) {
    const candidate = PRESETS[name];
    if (candidate && presetBinary(candidate)) {
      return createPresetAdapter(candidate);
    }
  }

  return createNotifyAdapter();
}
