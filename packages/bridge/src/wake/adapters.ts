import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

import type { AgentTask } from '@zhunzou/shared';

import type { WakeAdapterName, WakeConfig } from './config.js';
import { NOTIFY_ADAPTERS } from './config.js';
import { buildInjectPrompt, buildRunPrompt } from './prompt.js';

export type WakeDelivery = 'inject' | 'run' | 'notify';

export interface WakeCompletion {
  status: 'DONE' | 'FAILED';
  result?: string;
}

export interface WakeOutcome {
  delivery: WakeDelivery;
  /** Present when the daemon should record the result itself. */
  completion?: WakeCompletion;
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
}

export interface WakeAdapter {
  readonly name: WakeAdapterName;
  readonly delivery: WakeDelivery;
  wake(task: AgentTask, context: WakeContext): Promise<WakeOutcome>;
}

/* ------------------------------------------------------------------ */
/* Process helpers                                                     */
/* ------------------------------------------------------------------ */

interface ProcessResult {
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

interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  shell?: boolean;
  onOutput?: (
    stream: 'stdout' | 'stderr',
    chunk: string,
  ) => void;
}

function runProcess(
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
      resolvePromise({ code, stdout, stderr, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
    }, options.timeoutMs);
    timer.unref?.();

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

  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : shellQuote(value);
  });
}

/* ------------------------------------------------------------------ */
/* CLI presets                                                         */
/* ------------------------------------------------------------------ */

interface Preset {
  name: WakeAdapterName;
  binary: string;
  args: (prompt: string, extra: string[]) => string[];
}

const PRESETS: Record<string, Preset> = {
  'opencode-run': {
    name: 'opencode-run',
    binary: 'opencode',
    args: (prompt, extra) => ['run', '--auto', ...extra, prompt],
  },
  claude: {
    name: 'claude',
    binary: 'claude',
    args: (prompt, extra) => ['-p', ...extra, prompt],
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
  'cursor-agent': {
    name: 'cursor-agent',
    binary: 'cursor-agent',
    // Print mode only proposes edits unless --force is set; a dispatched task
    // is expected to actually apply its changes.
    args: (prompt, extra) => ['-p', '--force', ...extra, prompt],
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
  'cursor-agent',
  'aider',
  'goose',
  'amp',
];

function createPresetAdapter(preset: Preset): WakeAdapter {
  return {
    name: preset.name,
    delivery: 'run',
    async wake(task, context) {
      const binary = whichSync(preset.binary);
      if (!binary) {
        throw new Error(`找不到 ${preset.binary} 可执行文件（PATH 中不存在）`);
      }

      const prompt = buildRunPrompt(task);
      context.log(`spawn ${preset.binary} (run mode, cwd=${context.config.cwd})`);
      const result = await runProcess(
        binary,
        preset.args(prompt, context.config.extraArgs),
        {
          cwd: context.config.cwd,
          timeoutMs: context.config.runTimeoutMs,
          ...(context.reportLog ? { onOutput: context.reportLog } : {}),
        },
      );

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
          },
          timeoutMs: config.runTimeoutMs,
          ...(context.reportLog ? { onOutput: context.reportLog } : {}),
        },
      );

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
    if (candidate && whichSync(candidate.binary)) {
      return createPresetAdapter(candidate);
    }
  }

  return createNotifyAdapter();
}
