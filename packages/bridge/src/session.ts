import { randomUUID } from 'node:crypto';

import type {
  ChatMessage,
  ChatSession,
  CompleteChatMessageInput,
} from '@zhunzou/shared';

import type { BridgeConfig } from './config.js';
import { HubApiError, type HubApi } from './hub-client.js';
import type { PresenceReporter } from './presence.js';
import { RunnerState } from './runner-state.js';
import { runProcess, shellQuote, whichSync, type ProcessResult } from './wake/adapters.js';
import type { WakeAdapterName, WakeConfig } from './wake/config.js';
import { createLogSink, type LogStream } from './wake/log-sink.js';

/**
 * Interactive sessions over resumable CLI agents.
 *
 * Each user message becomes one non-interactive CLI call: OpenCode creates or
 * resumes `--session <id>`, Cursor resumes `--resume <id>`, Claude resumes
 * `--resume <id>`. The hub owns the message queue, so the editor does not have
 * to be open.
 */

export interface SessionDaemonOptions {
  client: HubApi;
  hub: BridgeConfig;
  wake: WakeConfig;
  presence?: PresenceReporter;
  once?: boolean;
  signal?: AbortSignal;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Stable id for this loop; a new id tells the hub the old runner died. */
  runnerId?: string;
  /** Durable runner state; defaults to `~/.zhunzou`. */
  state?: RunnerState;
}

interface ChatRun {
  binary: string;
  args: string[];
  /** Session id to persist on completion (when knowable up front). */
  externalId?: string;
}

const RESUME_CAPABLE: WakeAdapterName[] = [
  'opencode',
  'opencode-run',
  'cursor-agent',
  'claude',
  'command',
];

/**
 * OpenCode session ids must start with `ses`; it rejects a bare UUID.
 * `opencode run --session <id>` creates the session when it is unknown.
 */
export function openCodeSessionId(): string {
  return `ses_${randomUUID().replace(/-/g, '')}`;
}

function resolveChatAdapter(wake: WakeConfig): WakeAdapterName {
  if (wake.adapter !== 'auto') return wake.adapter;

  if (wake.command) return 'command';
  if (whichSync('opencode')) return 'opencode-run';
  if (whichSync('agent') || whichSync('cursor-agent')) return 'cursor-agent';
  if (whichSync('claude')) return 'claude';
  return 'command';
}

/** Whether this project's adapter can drive a resumable conversation. */
export function supportsChat(wake: WakeConfig): boolean {
  const adapter = resolveChatAdapter(wake);
  if (!RESUME_CAPABLE.includes(adapter)) return false;
  if (adapter === 'command' && !wake.command) return false;
  return true;
}

function renderChatTemplate(
  template: string,
  session: ChatSession,
  message: ChatMessage,
  externalId: string,
): string {
  const values: Record<string, string> = {
    message: message.content,
    prompt: message.content,
    session: externalId,
    env: session.env,
    project: session.projectName ?? '',
  };
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : shellQuote(value);
  });
}

function buildChatRun(
  adapter: WakeAdapterName,
  wake: WakeConfig,
  session: ChatSession,
  message: ChatMessage,
): ChatRun {
  const externalId = session.externalId;

  switch (adapter) {
    case 'opencode':
    case 'opencode-run': {
      // OpenCode accepts a client-provided id and creates the session if needed.
      const assigned = externalId ?? openCodeSessionId();
      return {
        binary: 'opencode',
        args: [
          'run',
          '--auto',
          ...(wake.chatModel ? ['-m', wake.chatModel] : []),
          '--session',
          assigned,
          message.content,
        ],
        externalId: assigned,
      };
    }
    case 'cursor-agent': {
      const binary = whichSync('agent') ?? whichSync('cursor-agent') ?? 'cursor-agent';
      return {
        binary,
        args: [
          '-p',
          '--force',
          '--output-format',
          'json',
          ...(wake.chatModel ? ['--model', wake.chatModel] : []),
          ...(externalId ? ['--resume', externalId] : []),
          message.content,
        ],
      };
    }
    case 'claude':
      return {
        binary: 'claude',
        args: [
          '-p',
          '--output-format',
          'json',
          ...(wake.chatModel ? ['--model', wake.chatModel] : []),
          ...(externalId ? ['--resume', externalId] : []),
          message.content,
        ],
      };
    case 'command': {
      if (!wake.command) {
        throw new Error(
          '交互式会话需要可恢复的 CLI，请设置 adapter/agent 或 ZHUNZOU_WAKE_COMMAND（支持 {message} 与 {session}）',
        );
      }
      const assigned = externalId ?? randomUUID();
      const template = renderChatTemplate(
        wake.command,
        session,
        message,
        assigned,
      );
      return {
        binary: process.platform === 'win32' ? 'cmd' : 'sh',
        args:
          process.platform === 'win32'
            ? ['/c', template]
            : ['-c', template],
        externalId: assigned,
      };
    }
    default:
      throw new Error(
        `adapter ${adapter} 不支持可恢复会话；请使用 opencode / cursor-agent / claude / command`,
      );
  }
}

function tail(value: string, limit = 20_000): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? trimmed.slice(trimmed.length - limit) : trimmed;
}

/**
 * Cursor/Claude print mode can return structured JSON. Fall back to raw text
 * when the CLI did not honour `--output-format json`.
 */
export function parseChatOutput(stdout: string): {
  content: string;
  externalId?: string;
} {
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const content =
        typeof parsed.result === 'string'
          ? parsed.result
          : typeof parsed.response === 'string'
            ? parsed.response
            : typeof parsed.content === 'string'
              ? parsed.content
              : undefined;
      const externalId =
        typeof parsed.session_id === 'string'
          ? parsed.session_id
          : typeof parsed.sessionId === 'string'
            ? parsed.sessionId
            : undefined;

      if (content) {
        return { content, ...(externalId ? { externalId } : {}) };
      }
    } catch {
      // raw text below
    }
  }
  return { content: tail(trimmed) };
}

/**
 * Reporting a finished turn is a single HTTP call, and a hub deploy restarts
 * the server for a few seconds. Without retries the CLI finishes its work but
 * the message stays RUNNING forever because the result never reached the hub.
 */
const COMPLETE_RETRY_ATTEMPTS = 12;
const COMPLETE_RETRY_BASE_MS = 1_000;
const COMPLETE_RETRY_MAX_MS = 15_000;

function retryableCompletionError(error: unknown): boolean {
  return error instanceof HubApiError && error.retryable;
}

async function completeWithRetry(options: {
  client: HubApi;
  sessionId: string;
  messageId: string;
  input: CompleteChatMessageInput;
  logError: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
}): Promise<void> {
  const { client, sessionId, messageId, input, logError, sleep } = options;
  let delay = COMPLETE_RETRY_BASE_MS;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.completeChatMessage(sessionId, messageId, input);
      return;
    } catch (error) {
      // The hub already moved this message out of RUNNING, so the result was
      // recorded before the connection dropped. Retrying cannot improve it.
      if (
        error instanceof HubApiError &&
        error.code === 'INVALID_MESSAGE_STATUS'
      ) {
        logError(
          `会话 #${sessionId} 消息 #${messageId} 已结束，跳过重复回报`,
        );
        return;
      }

      if (!retryableCompletionError(error) || attempt >= COMPLETE_RETRY_ATTEMPTS) {
        throw error;
      }

      logError(
        `回报会话结果失败（第 ${attempt} 次）：${(error as Error).message}；${delay}ms 后重试`,
      );
      await sleep(delay);
      delay = Math.min(delay * 2, COMPLETE_RETRY_MAX_MS);
    }
  }
}

/** A wait longer than one poll cycle must still keep the ledger fresh. */
const LEDGER_TOUCH_MS = 10_000;

function touchWhileWaiting(state: RunnerState): () => void {
  const timer = setInterval(() => state.heartbeat(), LEDGER_TOUCH_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function runTurn(
  run: ChatRun,
  wake: WakeConfig,
  session: ChatSession,
  state: RunnerState,
  onOutput: (stream: LogStream, chunk: string) => void,
): Promise<ProcessResult> {
  const stopTouching = touchWhileWaiting(state);
  try {
    return await runProcess(run.binary, run.args, {
      cwd: wake.cwd,
      env: {
        ...process.env,
        // The MCP server inside this CLI inherits these, so
        // agent_hub_propose_reply can address the exact conversation.
        ZHUNZOU_CHAT_SESSION_ID: session.id,
        ZHUNZOU_CHAT_ENV: session.env,
      },
      timeoutMs: wake.runTimeoutMs,
      onOutput,
    });
  } finally {
    stopTouching();
  }
}

/** Turns already finished whose result the hub never accepted. */
async function replayCompletions(options: {
  client: HubApi;
  state: RunnerState;
  log: (line: string) => void;
  logError: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
}): Promise<void> {
  const { client, state, log, logError, sleep } = options;
  const pending = state.pendingCompletions();
  if (pending.length === 0) return;

  log(`重放 ${pending.length} 条未送达的会话结果`);
  for (const entry of pending) {
    // The hub may have given up on this turn while it was unreachable; a real
    // answer still beats the "interrupted" placeholder.
    const input: CompleteChatMessageInput =
      entry.completion.status === 'DONE'
        ? { ...entry.completion, force: true }
        : entry.completion;
    try {
      await completeWithRetry({
        client,
        sessionId: entry.sessionId,
        messageId: entry.messageId,
        input,
        logError,
        sleep,
      });
      state.clearCompletion(entry.messageId);
      state.endTurn(entry.messageId);
      log(`重放会话 #${entry.sessionId} 消息 #${entry.messageId} 完成`);
    } catch (error) {
      logError(
        `重放会话 #${entry.sessionId} 消息 #${entry.messageId} 失败：${(error as Error).message}`,
      );
    }
  }
}

export async function runSessionDaemon(
  options: SessionDaemonOptions,
): Promise<number> {
  const { client, hub, wake } = options;
  const write =
    options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeError =
    options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  const log = (message: string) => write(`[zhunzou] ${message}`);
  const logError = (message: string) => writeError(`[zhunzou] ${message}`);
  const adapter = resolveChatAdapter(wake);
  const state = options.state ?? new RunnerState(hub.agentEnv);
  const runnerId = options.runnerId ?? state.runnerId;

  if (!RESUME_CAPABLE.includes(adapter)) {
    logError(`adapter ${adapter} 不支持交互式会话，会话循环已跳过`);
    return 0;
  }

  log(`chat ready (env=${hub.agentEnv}, adapter=${adapter})`);
  await replayCompletions({ client, state, log, logError, sleep });

  const pollTimeout = options.once
    ? Math.min(wake.pollTimeoutMs, 1_000)
    : wake.pollTimeoutMs;

  for (;;) {
    if (options.signal?.aborted) break;
    state.heartbeat();

    let next;
    const stopTouching = touchWhileWaiting(state);
    try {
      next = await client.nextChatMessage(pollTimeout, runnerId);
    } catch (error) {
      logError(
        `领取会话消息失败：${(error as Error).message}；2s 后重试`,
      );
      if (options.once) break;
      await sleep(2_000);
      continue;
    } finally {
      stopTouching();
    }

    if (!next.session || !next.message) {
      if (options.once) break;
      continue;
    }

    const session = next.session;
    const message = next.message;
    log(`会话 #${session.id} 收到消息 #${message.id}`);
    state.beginTurn(message.id);
    await options.presence
      ?.beat({
        status: 'Running',
        currentTask: tail(`会话 #${session.id}：${message.content}`, 300),
      })
      .catch(() => undefined);

    const sink = createLogSink(
      (stream, chunk) =>
        client.appendChatEvent(session.id, message.id, { stream, chunk }),
      logError,
    );
    sink.push('system', `[zhunzou] 开始处理消息 #${message.id}\n`);

    let completion: CompleteChatMessageInput;
    try {
      const run = buildChatRun(adapter, wake, session, message);
      const result = await runTurn(run, wake, session, state, sink.push);

      if (result.timedOut) {
        sink.push('system', '\n[zhunzou] 执行超时，已终止\n');
        completion = {
          status: 'FAILED',
          error: `执行超时（${Math.round(wake.runTimeoutMs / 1000)}s）`,
        };
        logError(`会话 #${session.id} 消息 #${message.id} 超时`);
      } else if (result.code === 0) {
        const parsed = parseChatOutput(result.stdout);
        const externalId = parsed.externalId ?? run.externalId;
        sink.push('system', '\n[zhunzou] 回复完成\n');
        completion = {
          status: 'DONE',
          content: parsed.content || '(无输出)',
          ...(externalId ? { externalId } : {}),
        };
      } else {
        const error = tail(result.stderr || result.stdout, 2_000);
        sink.push('system', `\n[zhunzou] 失败：${error}\n`);
        completion = {
          status: 'FAILED',
          error: error || `CLI 退出码 ${result.code}`,
        };
        logError(`会话 #${session.id} 消息 #${message.id} 失败`);
      }
    } catch (error) {
      const reason = (error as Error).message || '会话执行失败';
      sink.push('system', `\n[zhunzou] 失败：${reason}\n`);
      completion = { status: 'FAILED', error: reason.slice(0, 2_000) };
      logError(`会话 #${session.id} 消息 #${message.id} 失败：${reason}`);
    }

    await sink.close();

    // Journal before POSTing: the CLI already ran, so a hub restart (or a loop
    // killed right here) must not throw the result away.
    state.recordCompletion(session.id, message.id, completion);
    try {
      await completeWithRetry({
        client,
        sessionId: session.id,
        messageId: message.id,
        input: completion,
        logError,
        sleep,
      });
      state.clearCompletion(message.id);
      state.endTurn(message.id);
      if (completion.status === 'DONE') {
        log(`会话 #${session.id} 消息 #${message.id} → DONE`);
      }
    } catch (error) {
      logError(
        `会话 #${session.id} 消息 #${message.id} 的结果未能写回中枢，下次启动重放：${(error as Error).message}`,
      );
    }

    await options.presence
      ?.beat({ status: 'Idle', currentTask: 'Runner 已连接' })
      .catch(() => undefined);

    if (options.once) break;
  }

  state.close();
  return 0;
}
