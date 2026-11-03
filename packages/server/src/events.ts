import { EventEmitter } from 'node:events';

import type { AgentTask, ChatMessage, ChatSession, DecisionTicket } from '@zhunzou/shared';

/**
 * In-process wake-up bus for long polling.
 *
 * We never poll SQLite while waiting: each waiter attaches a single listener
 * keyed by ticket id and is woken by `resolve` / `cancel` / the Meta-Agent.
 */
export class TicketEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per concurrent long-poll; there is no meaningful cap.
    this.emitter.setMaxListeners(0);
  }

  private channel(id: string): string {
    return `ticket:${id}`;
  }

  publish(ticket: DecisionTicket): void {
    this.emitter.emit(this.channel(ticket.id), ticket);
  }

  /**
   * Wait until the ticket is published, or resolve with `timedOut: true`.
   * The caller must have verified the ticket is not terminal already.
   */
  wait(id: string, timeoutMs: number): Promise<{ ticket: DecisionTicket | null; timedOut: boolean }> {
    return new Promise((resolve) => {
      let settled = false;

      const finish = (ticket: DecisionTicket | null, timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.emitter.removeListener(this.channel(id), onPublish);
        resolve({ ticket, timedOut });
      };

      const onPublish = (ticket: DecisionTicket) => finish(ticket, false);

      const timer = setTimeout(() => finish(null, true), timeoutMs);
      // Do not keep the process alive just because a client is long-polling.
      timer.unref?.();

      this.emitter.once(this.channel(id), onPublish);
    });
  }

  listenerCount(id: string): number {
    return this.emitter.listenerCount(this.channel(id));
  }
}

/**
 * In-process wake-up bus for interactive sessions.
 *
 * When the dashboard sends a message, any bridge long-polling
 * `GET /api/sessions/next?env=...` wakes immediately instead of waiting for
 * the next poll tick.
 */
export interface ChatClaim {
  session: ChatSession;
  message: ChatMessage;
}

export class SessionEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  private channel(env: string): string {
    return `chat-env:${env}`;
  }

  publish(session: ChatSession): void {
    this.emitter.emit(this.channel(session.env), session);
  }

  wait(
    env: string,
    timeoutMs: number,
    probe?: () => ChatClaim | null,
  ): Promise<{ claim: ChatClaim | null; timedOut: boolean }> {
    return new Promise((resolve) => {
      let settled = false;

      const finish = (claim: ChatClaim | null, timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.emitter.removeListener(this.channel(env), onPublish);
        resolve({ claim, timedOut });
      };

      const onPublish = () => finish(null, false);

      const timer = setTimeout(() => finish(null, true), timeoutMs);
      timer.unref?.();

      this.emitter.once(this.channel(env), onPublish);

      if (probe) {
        const claimed = probe();
        if (claimed) finish(claimed, false);
      }
    });
  }

  listenerCount(env: string): number {
    return this.emitter.listenerCount(this.channel(env));
  }
}
export class TaskEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  private channel(env: string): string {
    return `task-env:${env}`;
  }

  publish(task: AgentTask): void {
    this.emitter.emit(this.channel(task.env), task);
  }

  /**
   * Wait for a new task notification. `probe` is called after the listener is
   * registered so a task created between the caller's last check and this call
   * cannot be missed. If `probe` returns a claimed task, the wait resolves
   * immediately; otherwise a publish or timeout wakes the caller.
   */
  wait(
    env: string,
    timeoutMs: number,
    probe?: () => AgentTask | null,
  ): Promise<{ task: AgentTask | null; timedOut: boolean }> {
    return new Promise((resolve) => {
      let settled = false;

      const finish = (task: AgentTask | null, timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.emitter.removeListener(this.channel(env), onPublish);
        resolve({ task, timedOut });
      };

      const onPublish = () => finish(null, false);

      const timer = setTimeout(() => finish(null, true), timeoutMs);
      timer.unref?.();

      this.emitter.once(this.channel(env), onPublish);

      if (probe) {
        const claimed = probe();
        if (claimed) finish(claimed, false);
      }
    });
  }

  listenerCount(env: string): number {
    return this.emitter.listenerCount(this.channel(env));
  }
}
