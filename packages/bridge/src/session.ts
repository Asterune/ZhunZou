import { randomUUID } from 'node:crypto';

import type { ChatMessage, ChatSession } from '@zhunzou/shared';

import type { BridgeConfig } from './config.js';
import type { HubApi } from './hub-client.js';
import type { PresenceReporter } from './presence.js';
import { runProcess, shellQuote, whichSync } from './wake/adapters.js';
import type { WakeAdapterName, WakeConfig } from './wake/config.js';
import { createLogSink } from './wake/log-sink.js';

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

  if (!RESUME_CAPABLE.includes(adapter)) {
    logError(`adapter ${adapter} 不支持交互式会话，会话循环已跳过`);
    return 0;
  }

  log(`chat ready (env=${hub.agentEnv}, adapter=${adapter})`);
  const pollTimeout = options.once
    ? Math.min(wake.pollTimeoutMs, 1_000)
    : wake.pollTimeoutMs;

  for (;;) {
    if (options.signal?.aborted) return 0;

    let next;
    try {
      next = await client.nextChatMessage(pollTimeout);
    } catch (error) {
      logError(
        `领取会话消息失败：${(error as Error).message}；2s 后重试`,
      );
      if (options.once) return 0;
      await sleep(2_000);
      continue;
    }

    if (!next.session || !next.message) {
      if (options.once) return 0;
      continue;
    }

    const session = next.session;
    const message = next.message;
    log(`会话 #${session.id} 收到消息 #${message.id}`);
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

    try {
      const run = buildChatRun(adapter, wake, session, message);
      const result = await runProcess(run.binary, run.args, {
        cwd: wake.cwd,
        env: {
          ...process.env,
          // The MCP server inside this CLI inherits these, so
          // agent_hub_propose_reply can address the exact conversation.
          ZHUNZOU_CHAT_SESSION_ID: session.id,
          ZHUNZOU_CHAT_ENV: session.env,
        },
        timeoutMs: wake.runTimeoutMs,
        onOutput: sink.push,
      });

      if (result.timedOut) {
        sink.push('system', '\n[zhunzou] 执行超时，已终止\n');
        await sink.close();
        await client.completeChatMessage(session.id, message.id, {
          status: 'FAILED',
          error: `执行超时（${Math.round(wake.runTimeoutMs / 1000)}s）`,
        });
        logError(`会话 #${session.id} 消息 #${message.id} 超时`);
      } else if (result.code === 0) {
        const parsed = parseChatOutput(result.stdout);
        const externalId = parsed.externalId ?? run.externalId;
        sink.push('system', '\n[zhunzou] 回复完成\n');
        await sink.close();
        await client.completeChatMessage(session.id, message.id, {
          status: 'DONE',
          content: parsed.content || '(无输出)',
          ...(externalId ? { externalId } : {}),
        });
        log(`会话 #${session.id} 消息 #${message.id} → DONE`);
      } else {
        const error = tail(result.stderr || result.stdout, 2_000);
        sink.push('system', `\n[zhunzou] 失败：${error}\n`);
        await sink.close();
        await client.completeChatMessage(session.id, message.id, {
          status: 'FAILED',
          error: error || `CLI 退出码 ${result.code}`,
        });
        logError(`会话 #${session.id} 消息 #${message.id} 失败`);
      }
    } catch (error) {
      const reason = (error as Error).message || '会话执行失败';
      sink.push('system', `\n[zhunzou] 失败：${reason}\n`);
      await sink.close();
      await client
        .completeChatMessage(session.id, message.id, {
          status: 'FAILED',
          error: reason.slice(0, 2_000),
        })
        .catch((completeError: unknown) =>
          logError(
            `回报失败结果时出错：${(completeError as Error).message}`,
          ),
        );
      logError(`会话 #${session.id} 消息 #${message.id} 失败：${reason}`);
    }

    await options.presence
      ?.beat({ status: 'Idle', currentTask: 'Runner 已连接' })
      .catch(() => undefined);

    if (options.once) return 0;
  }
}
