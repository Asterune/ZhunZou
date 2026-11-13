import type { AgentTask, HeartbeatInput } from '@zhunzou/shared';

import type { BridgeConfig } from '../config.js';
import { WorktreeManager } from '../git/worktree.js';
import { readWorkspaceFingerprint } from '../git/delta.js';
import type { HubApi } from '../hub-client.js';
import type { PresenceReporter } from '../presence.js';
import { createLogSanitizer, type LogSanitizer } from '../sanitizer/log-sanitizer.js';
import type { WakeCompletion, WakeContext, WakeParked } from './adapters.js';
import {
  agentKindForAdapter,
  notifyTask,
  resolveWakeAdapter,
  type WakeAdapter,
} from './adapters.js';
import type { WakeConfig } from './config.js';
import { createEventSink } from './event-sink.js';
import { createLogSink, type LogSink } from './log-sink.js';
import { resolveWorkspace, type WorkspaceIsolation } from './isolation.js';

export interface WakeDaemonOptions {
  client: HubApi;
  hub: BridgeConfig;
  wake: WakeConfig;
  /** Injected adapter (tests / advanced callers). Defaults to auto-detection. */
  adapter?: WakeAdapter;
  /** Injected worktree isolation; defaults to on/off from `wake.worktrees`. */
  isolation?: WorkspaceIsolation;
  /** Run a single poll cycle and exit (used by smoke tests). */
  once?: boolean;
  /** Shared presence so task/chat loops do not overwrite each other. */
  presence?: PresenceReporter;
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
  presence?: PresenceReporter,
): Promise<void> {
  try {
    if (presence) await presence.beat(input);
    else await client.heartbeat(input);
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
  // The switch decides whether tasks are isolated at all; an injected manager
  // only says how, so a disabled config can never isolate by accident.
  const isolation = wake.worktrees
    ? (options.isolation ?? new WorktreeManager({ repoPath: wake.cwd }))
    : undefined;
  // Report the client we actually resolved, not the `auto` placeholder, so an
  // OpenCode wake loop does not label its agent "other" on the dashboard.
  hub.agentKind = agentKindForAdapter(adapter.name);
  log(
    `wake adapter=${adapter.name} mode=${adapter.delivery} env=${hub.agentEnv} cwd=${wake.cwd}` +
      (isolation ? ' worktrees=on' : ''),
  );

  if (adapter.delivery === 'notify') {
    // A notify adapter never claims a task, so there is nothing to isolate.
    return runNotifyLoop(adapter, { ...options, context, log, logError, sleep });
  }

  return runClaimLoop(adapter, {
    ...options,
    isolation,
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

function createTaskLogSink(
  client: HubApi,
  taskId: string,
  onError: (message: string) => void,
  sanitizer: LogSanitizer,
) {
  return createLogSink(
    (stream, chunk, meta) =>
      client.appendTaskLog(taskId, {
        stream,
        chunk,
        ...(meta.errorSignature ? { errorSignature: meta.errorSignature } : {}),
        ...(meta.diffHash ? { diffHash: meta.diffHash } : {}),
      }),
    (message) => onError(`任务 #${taskId} ${message}`),
    { sanitizer },
  );
}

/**
 * Tell the hub what the workspace looks like now, while the task is still
 * CLAIMED and before its outcome lands. A node that cannot answer simply says
 * nothing; the run's completion must not depend on git.
 */
async function pushWorkspaceFingerprint(
  sink: LogSink,
  cwd: string,
  logError: (message: string) => void,
): Promise<void> {
  try {
    const diffHash = await readWorkspaceFingerprint(cwd);
    if (!diffHash) return;
    sink.push('system', `[zhunzou] 工作树指纹 ${diffHash}\n`, { diffHash });
  } catch (error) {
    logError(`工作树指纹上报失败：${(error as Error).message}`);
  }
}

/** A failed run reports what broke, not the last four kilobytes of noise. */
function refineResult(
  completion: WakeCompletion,
  sanitizer: LogSanitizer,
): WakeCompletion {
  if (completion.status !== 'FAILED') return completion;
  return { ...completion, result: sanitizer.summarize() || completion.result };
}

function createTaskEventSink(
  client: HubApi,
  taskId: string,
  onError: (message: string) => void,
) {
  return createEventSink(
    (events) => client.reportTaskEvents(taskId, events),
    (message) => onError(`任务 #${taskId} ${message}`),
  );
}

/**
 * Hand a parked run to a human.
 *
 * The session id is already on the task (the hub wrote it from the event
 * stream), so the task goes back to the queue instead of sitting on this
 * node: approval is human time, and a CLAIMED task spends a concurrency slot.
 */
async function parkTask(
  client: HubApi,
  hub: BridgeConfig,
  task: AgentTask,
  parked: WakeParked,
  log: (message: string) => void,
  logError: (message: string) => void,
): Promise<void> {
  const projectName = task.projectName ?? hub.projectName ?? task.env;
  const action = parked.action
    ? [parked.action.command, ...(parked.action.paths ?? [])]
        .filter(Boolean)
        .join(' ')
    : '';

  try {
    const ticket = await client.createTicket({
      projectName,
      doneSummary: `任务 #${task.id}「${task.title}」执行到需要批准的一步停下`,
      blockerQuestion: `${parked.reason}${action ? `\n具体内容：${action}` : ''}`,
      nextStepPlan:
        `批准后从引擎会话 ${task.sessionId ?? '（未记录）'} 原地续跑，拒绝则任务留在队列等待新的指令。` +
        `端侧进程已释放，未占用节点槽位。`,
      options: [
        {
          key: 'approve',
          label: '批准续跑',
          prosCons: '从中断处继续，已做的工作不丢',
          risk: 'caution',
        },
        {
          key: 'reject',
          label: '拒绝',
          prosCons: '保持挂起，等人工改写任务指令',
          risk: 'safe',
        },
      ],
      recommendedOption: 'reject',
    });
    log(`任务 #${task.id} 已挂起，等待审批（工单 #${ticket.id}）`);
  } catch (error) {
    // A ticket we cannot raise must not turn into a failed task: the events
    // already carry the request, and the task is back in the queue anyway.
    logError(
      `任务 #${task.id} 建审批工单失败：${(error as Error).message}；仍将重新排队`,
    );
  }

  try {
    await client.releaseTask(task.id, { requeue: true, reason: parked.reason });
    log(`任务 #${task.id} 已重新排队，等待批准后续跑`);
  } catch (error) {
    logError(`任务 #${task.id} 重新排队失败：${(error as Error).message}`);
  }
}

async function runClaimLoop(
  adapter: WakeAdapter,
  internals: LoopInternals,
): Promise<number> {
  const { client, hub, wake, isolation, context, log, logError, sleep } = internals;
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
    }, internals.presence);

    const sanitizer = createLogSanitizer();
    const sink = createTaskLogSink(client, task.id, logError, sanitizer);
    const eventSink = createTaskEventSink(client, task.id, logError);
    sink.push('system', `[zhunzou] 任务 #${task.id} 开始执行\n`);

    const workspace = await resolveWorkspace({
      ...(isolation ? { isolation } : {}),
      cwd: wake.cwd,
      taskId: task.id,
      ...(task.repoName ? { repoName: task.repoName } : {}),
      log,
    });
    const taskContext: WakeContext = {
      ...context,
      config: { ...wake, cwd: workspace.cwd },
      reportLog: sink.push,
      reportEvent: eventSink.push,
    };

    try {
      const outcome = await adapter.wake(task, taskContext);
      // Ship the events before anything changes the task's status: the hub only
      // accepts them while the task is CLAIMED, and the resume credential has
      // to be in the row before the next claimant picks it up.
      await eventSink.close();

      if (outcome.parked) {
        sink.push(
          'system',
          `\n[zhunzou] 任务 #${task.id} 等待人工批准：${outcome.parked.reason}\n`,
        );
        await sink.close();
        await parkTask(client, hub, task, outcome.parked, log, logError);
        await beat(client, idlePatch, internals.presence);
      } else if (outcome.completion) {
        const { completion } = outcome;
        sink.push(
          'system',
          `\n[zhunzou] 任务 #${task.id} → ${completion.status}\n`,
        );
        await pushWorkspaceFingerprint(sink, workspace.cwd, logError);
        await sink.close();
        await client.completeTask(task.id, {
          ...refineResult(completion, sanitizer),
          ...(workspace.workspacePath
            ? { workspacePath: workspace.workspacePath }
            : {}),
        });
        log(`任务 #${task.id} → ${completion.status}`);
        await beat(client, idlePatch, internals.presence);
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
      await eventSink.close();
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
      await beat(client, idlePatch, internals.presence);
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
