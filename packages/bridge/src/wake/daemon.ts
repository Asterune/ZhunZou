import type { AgentTask, HeartbeatInput } from '@zhunzou/shared';

import type { BridgeConfig } from '../config.js';
import type { HubApi } from '../hub-client.js';
import type { WakeContext } from './adapters.js';
import {
  notifyTask,
  resolveWakeAdapter,
  type WakeAdapter,
} from './adapters.js';
import type { WakeConfig } from './config.js';

export interface WakeDaemonOptions {
  client: HubApi;
  hub: BridgeConfig;
  wake: WakeConfig;
  /** Injected adapter (tests / advanced callers). Defaults to auto-detection. */
  adapter?: WakeAdapter;
  /** Run a single poll cycle and exit (used by smoke tests). */
  once?: boolean;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

function truncate(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

/** Advisory heartbeat: a wake cycle must not fail because the dashboard is down. */
async function beat(
  client: HubApi,
  input: Omit<HeartbeatInput, 'env'>,
): Promise<void> {
  try {
    await client.heartbeat(input);
  } catch {
    // Dashboard status is advisory only.
  }
}

/**
 * Long-poll the hub for dispatched tasks and hand each one to a local agent.
 *
 * This is the push half of Zhunzou's dispatch: the MCP server lets an agent
 * pull tasks mid-conversation, while this daemon wakes an idle client when a
 * task arrives. Adapters decide *how* to wake it (OpenCode session injection,
 * a one-shot CLI agent, a custom command, or a desktop reminder).
 */
export async function runWakeDaemon(options: WakeDaemonOptions): Promise<number> {
  const { client, hub, wake } = options;
  const write = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeError =
    options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const log = (message: string) => write(`[zhunzou] ${message}`);
  const logError = (message: string) => writeError(`[zhunzou] ${message}`);

  const context: WakeContext = {
    config: wake,
    ...(hub.projectName ? { projectName: hub.projectName } : {}),
    log,
  };

  const adapter = options.adapter ?? (await resolveWakeAdapter(wake));
  log(
    `wake adapter=${adapter.name} mode=${adapter.delivery} env=${hub.agentEnv} cwd=${wake.cwd}`,
  );

  if (adapter.delivery === 'notify') {
    return runNotifyLoop(adapter, { ...options, context, log, logError, sleep });
  }

  return runClaimLoop(adapter, {
    ...options,
    context,
    log,
    logError,
    sleep,
  });
}

interface LoopInternals extends WakeDaemonOptions {
  context: WakeContext;
  log: (message: string) => void;
  logError: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
}

type LogStream = 'stdout' | 'stderr' | 'system';

interface TaskLogSink {
  push: (stream: LogStream, chunk: string) => void;
  close: () => Promise<void>;
}

const LOG_FLUSH_INTERVAL_MS = 600;
const LOG_CHUNK_BYTES = 12_000;
const LOG_BUFFER_BYTES = 24_000;

/**
 * Batch a running task's output and post it to the hub.
 *
 * The daemon must never fail a task because log shipping failed, so every
 * error is downgraded to a single warning. Chunks are split to fit the API's
 * 16 KB limit and flushed before the task is completed.
 */
function createTaskLogSink(
  client: HubApi,
  taskId: string,
  onError: (message: string) => void,
): TaskLogSink {
  const buffers: Record<LogStream, string> = {
    stdout: '',
    stderr: '',
    system: '',
  };
  let flushing = false;
  let closed = false;
  let warned = false;

  const take = (): Array<{ stream: LogStream; chunk: string }> => {
    const chunks: Array<{ stream: LogStream; chunk: string }> = [];
    for (const stream of ['stdout', 'stderr', 'system'] as const) {
      const text = buffers[stream];
      if (!text) continue;
      buffers[stream] = '';
      for (let index = 0; index < text.length; index += LOG_CHUNK_BYTES) {
        chunks.push({
          stream,
          chunk: text.slice(index, index + LOG_CHUNK_BYTES),
        });
      }
    }
    return chunks;
  };

  const flush = async (): Promise<void> => {
    if (flushing) return;
    flushing = true;
    try {
      for (;;) {
        const chunks = take();
        if (chunks.length === 0) return;
        for (const item of chunks) {
          try {
            await client.appendTaskLog(taskId, item);
          } catch (error) {
            if (!warned) {
              warned = true;
              onError(
                `任务 #${taskId} 日志上报失败：${(error as Error).message}`,
              );
            }
          }
        }
      }
    } finally {
      flushing = false;
    }
  };

  const timer = setInterval(() => {
    void flush();
  }, LOG_FLUSH_INTERVAL_MS);
  timer.unref?.();

  return {
    push(stream, chunk) {
      if (closed || !chunk) return;
      buffers[stream] += chunk;
      if (buffers[stream].length >= LOG_BUFFER_BYTES) {
        void flush();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await flush();
    },
  };
}

async function runClaimLoop(
  adapter: WakeAdapter,
  internals: LoopInternals,
): Promise<number> {
  const { client, hub, wake, context, log, logError, sleep } = internals;
  const idlePatch = {
    status: 'Idle' as const,
    currentTask: '等待下发任务',
    ...(hub.projectName ? { projectName: hub.projectName } : {}),
  };

  for (;;) {
    if (internals.signal?.aborted) return 0;

    let task: AgentTask | null = null;
    try {
      const response = await client.nextTask(wake.pollTimeoutMs);
      task = response.task;
    } catch (error) {
      logError(
        `领取任务失败：${(error as Error).message}；2s 后重试`,
      );
      await sleep(2_000);
      continue;
    }

    if (!task) {
      if (internals.once) return 0;
      continue;
    }

    log(`领取任务 #${task.id} ${task.title}`);
    await beat(client, {
      status: 'Running',
      currentTask: truncate(`任务 #${task.id}：${task.title}`, 300),
      ...(hub.projectName ? { projectName: hub.projectName } : {}),
    });

    const sink = createTaskLogSink(client, task.id, logError);
    sink.push('system', `[zhunzou] 任务 #${task.id} 开始执行\n`);
    const taskContext: WakeContext = { ...context, reportLog: sink.push };

    try {
      const outcome = await adapter.wake(task, taskContext);

      if (outcome.completion) {
        sink.push(
          'system',
          `\n[zhunzou] 任务 #${task.id} → ${outcome.completion.status}\n`,
        );
        await sink.close();
        await client.completeTask(task.id, outcome.completion);
        log(`任务 #${task.id} → ${outcome.completion.status}`);
        await beat(client, idlePatch);
      } else {
        sink.push(
          'system',
          `[zhunzou] 任务 #${task.id} 已交接给端侧 Agent，等待其回报\n`,
        );
        await sink.close();
        // The agent owns the task from here and reports through MCP.
        log(`任务 #${task.id} 已交接给端侧 Agent，等待其回报`);
      }
    } catch (error) {
      const reason = truncate(
        (error as Error).message || '端侧未能唤醒',
        500,
      );
      sink.push('system', `\n[zhunzou] 执行失败：${reason}\n`);
      await sink.close();
      logError(`任务 #${task.id} 唤醒失败：${reason}`);

      try {
        await client.releaseTask(task.id, { requeue: true, reason });
        log(`任务 #${task.id} 已重新排队，等待下次唤醒`);
      } catch (releaseError) {
        logError(
          `任务 #${task.id} 重新排队失败：${(releaseError as Error).message}`,
        );
      }

      await notifyTask(task, context).catch(() => undefined);
      await beat(client, idlePatch);
    }

    if (internals.once) return 0;
  }
}

async function runNotifyLoop(
  _adapter: WakeAdapter,
  internals: LoopInternals,
): Promise<number> {
  const { client, wake, context, log, logError, sleep } = internals;
  const seen = new Set<string>();

  for (;;) {
    if (internals.signal?.aborted) return 0;

    try {
      const page = await client.listTasks({ status: 'PENDING', limit: 50 });
      const current = new Set<string>();

      for (const task of page.tasks) {
        current.add(task.id);
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        await notifyTask(task, context);
        log(`提醒任务 #${task.id} ${task.title}`);
      }

      // Drop ids that are no longer pending so the set cannot grow forever.
      for (const id of seen) {
        if (!current.has(id)) seen.delete(id);
      }
    } catch (error) {
      logError(`扫描待领取任务失败：${(error as Error).message}`);
    }

    if (internals.once) return 0;
    await sleep(wake.notifyIntervalMs);
  }
}
