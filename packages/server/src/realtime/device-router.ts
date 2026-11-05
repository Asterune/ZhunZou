import type {
  ChatMessage,
  ChatSession,
  DecisionTicket,
  RealtimeClientFrame,
  RealtimeServerFrame,
} from '@zhunzou/shared';
import { isTerminalStatus } from '@zhunzou/shared';

import type { ServerConfig } from '../config.js';
import type {
  SessionEventBus,
  TaskEventBus,
  TicketEventBus,
} from '../events.js';
import type { TicketStore } from '../repository.js';
import type { RealtimeGateway } from './gateway.js';

export interface DeviceRouterOptions {
  config: ServerConfig;
  repo: TicketStore;
  gateway: RealtimeGateway;
  ticketBus: TicketEventBus;
  taskBus: TaskEventBus;
  sessionBus: SessionEventBus;
  /** Called after a mutation so the dashboard revision advances promptly. */
  onChanged?: () => void;
}

export interface DeviceRouter {
  close(): void;
}

const MAX_WAIT_MS = 55_000;

function clampTimeout(
  value: number | undefined,
  fallback: number,
): number {
  return Math.min(MAX_WAIT_MS, Math.max(0, value ?? fallback));
}

/**
 * Claim/wait transport for bridge and device sockets.
 *
 * This is the WebSocket equivalent of `/api/tasks/next`, `/api/tickets/:id/wait`
 * and `/api/sessions/next`. The existing HTTP routes stay as a fallback for
 * older bridges and for servers running with `REALTIME_ENABLED=false`.
 */
export function attachDeviceRouter(
  options: DeviceRouterOptions,
): DeviceRouter {
  const { config, repo, gateway, ticketBus, taskBus, sessionBus } = options;
  const onChanged = options.onChanged;

  const send = (env: string, frame: RealtimeServerFrame): boolean =>
    gateway.sendToBridge(env, frame);

  const fail = (
    env: string,
    code: string,
    message: string,
  ): void => {
    send(env, { type: 'error', code, message });
  };

  const ack = (env: string, requestId?: string): void => {
    send(env, {
      type: 'ack',
      ...(requestId ? { requestId } : {}),
      at: Date.now(),
    });
  };

  const deliverTask = (
    env: string,
    requestId: string,
    task: ReturnType<TicketStore['claimNextTask']>,
    timedOut: boolean,
  ): void => {
    const delivered = send(env, {
      type: 'task.assigned',
      requestId,
      task: task ?? null,
      timedOut,
    });
    if (!delivered && task) {
      repo.releaseTask(
        Number(task.id),
        true,
        'bridge disconnected before task delivery',
      );
    }
    onChanged?.();
  };

  const claimTask = async (
    env: string,
    requestId: string,
    timeoutMs: number,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const task = repo.claimNextTask(env);
      if (task) {
        deliverTask(env, requestId, task, false);
        return;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        deliverTask(env, requestId, null, true);
        return;
      }

      const wake = await taskBus.wait(env, remaining, () =>
        repo.claimNextTask(env),
      );
      if (wake.task) {
        deliverTask(env, requestId, wake.task, false);
        return;
      }
      if (wake.timedOut) {
        deliverTask(env, requestId, null, true);
        return;
      }
    }
  };

  const waitTicket = async (
    env: string,
    requestId: string,
    ticketId: string,
    timeoutMs: number,
  ): Promise<void> => {
    const id = Number(ticketId);
    const existing = repo.get(id);
    if (!existing) {
      fail(env, 'TICKET_NOT_FOUND', `ticket #${ticketId} not found`);
      return;
    }
    if (existing.env !== env) {
      fail(env, 'ENV_FORBIDDEN', 'ticket belongs to a different env');
      return;
    }

    if (isTerminalStatus(existing.status) || timeoutMs <= 0) {
      send(env, {
        type: 'ticket.resolved',
        requestId,
        ticket: existing,
        timedOut: !isTerminalStatus(existing.status),
      });
      return;
    }

    const wake = await ticketBus.wait(existing.id, timeoutMs);
    const ticket = wake.ticket ?? repo.get(id) ?? existing;
    send(env, {
      type: 'ticket.resolved',
      requestId,
      ticket,
      timedOut: wake.timedOut && !isTerminalStatus(ticket.status),
    });
  };

  const deliverChat = (
    env: string,
    requestId: string,
    claim: { session: ChatSession; message: ChatMessage } | null,
    timedOut: boolean,
  ): void => {
    send(env, {
      type: 'chat.assigned',
      requestId,
      session: claim?.session ?? null,
      message: claim?.message ?? null,
      timedOut,
    });
    if (claim) onChanged?.();
  };

  const claimChat = async (
    env: string,
    requestId: string,
    timeoutMs: number,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const claim = repo.claimNextChatMessage(env);
      if (claim) {
        deliverChat(env, requestId, claim, false);
        return;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        deliverChat(env, requestId, null, true);
        return;
      }

      const wake = await sessionBus.wait(env, remaining, () =>
        repo.claimNextChatMessage(env),
      );
      if (wake.claim) {
        deliverChat(env, requestId, wake.claim, false);
        return;
      }
      if (wake.timedOut) {
        deliverChat(env, requestId, null, true);
        return;
      }
    }
  };

  const handleTaskComplete = (
    env: string,
    frame: Extract<RealtimeClientFrame, { type: 'task.complete' }>,
  ): void => {
    const task = repo.getTask(Number(frame.taskId));
    if (!task) {
      fail(env, 'TASK_NOT_FOUND', `task #${frame.taskId} not found`);
      return;
    }
    if (task.env !== env) {
      fail(env, 'ENV_FORBIDDEN', 'task belongs to a different env');
      return;
    }

    const completed = repo.completeTask(Number(frame.taskId), {
      status: frame.status,
      ...(frame.result ? { result: frame.result } : {}),
    });
    send(env, {
      type: 'task.completed',
      ...(frame.requestId ? { requestId: frame.requestId } : {}),
      task: completed,
    });
    onChanged?.();
  };

  const handleTaskLog = (
    env: string,
    frame: Extract<RealtimeClientFrame, { type: 'task.log' }>,
  ): void => {
    const task = repo.getTask(Number(frame.taskId));
    if (!task) {
      fail(env, 'TASK_NOT_FOUND', `task #${frame.taskId} not found`);
      return;
    }
    if (task.env !== env) {
      fail(env, 'ENV_FORBIDDEN', 'task belongs to a different env');
      return;
    }
    if (task.status !== 'CLAIMED') {
      fail(env, 'INVALID_TASK_STATUS', `task is ${task.status}`);
      return;
    }
    repo.appendTaskLog(Number(frame.taskId), {
      stream: frame.stream,
      chunk: frame.chunk,
    });
    ack(env);
  };

  const handleTaskRelease = (
    env: string,
    frame: Extract<RealtimeClientFrame, { type: 'task.release' }>,
  ): void => {
    const task = repo.getTask(Number(frame.taskId));
    if (!task) {
      fail(env, 'TASK_NOT_FOUND', `task #${frame.taskId} not found`);
      return;
    }
    if (task.env !== env) {
      fail(env, 'ENV_FORBIDDEN', 'task belongs to a different env');
      return;
    }

    const released = repo.releaseTask(
      Number(frame.taskId),
      frame.requeue,
      frame.reason ?? 'bridge released the task',
    );
    if (!released) {
      fail(env, 'INVALID_TASK_STATUS', `task is ${task.status}`);
      return;
    }
    send(env, {
      type: 'task.released',
      ...(frame.requestId ? { requestId: frame.requestId } : {}),
      task: released,
    });
    onChanged?.();
  };

  const handleChatEvent = (
    env: string,
    frame: Extract<RealtimeClientFrame, { type: 'chat.event' }>,
  ): void => {
    const session = repo.getChatSession(Number(frame.sessionId));
    if (!session) {
      fail(env, 'SESSION_NOT_FOUND', `session #${frame.sessionId} not found`);
      return;
    }
    if (session.env !== env) {
      fail(env, 'ENV_FORBIDDEN', 'session belongs to a different env');
      return;
    }
    const message = repo.getChatMessage(Number(frame.messageId));
    if (!message || message.sessionId !== session.id) {
      fail(env, 'MESSAGE_NOT_FOUND', 'message not found in session');
      return;
    }
    if (message.status !== 'RUNNING') {
      fail(env, 'INVALID_MESSAGE_STATUS', `message is ${message.status}`);
      return;
    }
    repo.appendChatEvent(
      Number(session.id),
      Number(message.id),
      { stream: frame.stream, chunk: frame.chunk },
    );
    ack(env);
  };

  const handleChatComplete = (
    env: string,
    frame: Extract<RealtimeClientFrame, { type: 'chat.complete' }>,
  ): void => {
    const session = repo.getChatSession(Number(frame.sessionId));
    if (!session) {
      fail(env, 'SESSION_NOT_FOUND', `session #${frame.sessionId} not found`);
      return;
    }
    if (session.env !== env) {
      fail(env, 'ENV_FORBIDDEN', 'session belongs to a different env');
      return;
    }
    const result = repo.completeChatMessage(
      Number(session.id),
      Number(frame.messageId),
      {
        status: frame.status,
        ...(frame.content ? { content: frame.content } : {}),
        ...(frame.externalId ? { externalId: frame.externalId } : {}),
        ...(frame.error ? { error: frame.error } : {}),
      },
    );
    send(env, {
      type: 'chat.completed',
      ...(frame.requestId ? { requestId: frame.requestId } : {}),
      session: result.session,
      message: result.message,
    });
    onChanged?.();
  };

  const handle = (env: string, frame: RealtimeClientFrame): void => {
    switch (frame.type) {
      case 'task.claim':
        void claimTask(
          env,
          frame.requestId,
          clampTimeout(frame.timeoutMs, config.waitTimeoutMs),
        );
        break;
      case 'task.complete':
        handleTaskComplete(env, frame);
        break;
      case 'task.log':
        handleTaskLog(env, frame);
        break;
      case 'task.release':
        handleTaskRelease(env, frame);
        break;
      case 'ticket.wait':
        void waitTicket(
          env,
          frame.requestId,
          frame.ticketId,
          clampTimeout(frame.timeoutMs, config.waitTimeoutMs),
        );
        break;
      case 'chat.claim':
        void claimChat(
          env,
          frame.requestId,
          clampTimeout(frame.timeoutMs, config.waitTimeoutMs),
        );
        break;
      case 'chat.event':
        handleChatEvent(env, frame);
        break;
      case 'chat.complete':
        handleChatComplete(env, frame);
        break;
      default:
        break;
    }
  };

  const off = gateway.onDeviceFrame(handle);
  return { close: off };
}
