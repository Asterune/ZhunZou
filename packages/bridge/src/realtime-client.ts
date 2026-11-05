import { randomUUID } from 'node:crypto';

import { WebSocket } from 'ws';

import type {
  NextChatMessageResponse,
  NextTaskResponse,
  RealtimeClientFrame,
  RealtimeServerFrame,
  WaitResponse,
} from '@zhunzou/shared';
import { isResolvedStatus } from '@zhunzou/shared';

import type { BridgeConfig } from './config.js';

const REQUEST_GRACE_MS = 10_000;

export class RealtimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealtimeUnavailableError';
  }
}

interface PendingRequest {
  resolve: (frame: RealtimeServerFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function socketUrl(config: BridgeConfig): string {
  const url = new URL(config.hubUrl);
  url.protocol =
    url.protocol === 'https:'
      ? 'wss:'
      : url.protocol === 'http:'
        ? 'ws:'
        : url.protocol;
  url.pathname =
    !url.pathname || url.pathname === '/'
      ? '/ws/bridge'
      : `${url.pathname.replace(/\/+$/, '')}/ws/bridge`;
  url.searchParams.set('env', config.agentEnv);
  return url.toString();
}

/**
 * WebSocket side of the bridge.
 *
 * It carries claims/waits (`task.claim`, `ticket.wait`, `chat.claim`) while
 * the existing HTTP client keeps CRUD, logs and completion reporting. If the
 * socket is unavailable the hybrid client silently falls back to HTTP.
 */
export class RealtimeHubClient {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private closed = false;

  constructor(private readonly config: BridgeConfig) {}

  private async ensureConnected(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    if (this.closed) {
      throw new RealtimeUnavailableError('realtime client is closed');
    }

    const url = socketUrl(this.config);
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.config.token}` },
      handshakeTimeout: REQUEST_GRACE_MS,
      maxPayload: 64 * 1024,
    });
    this.socket = socket;

    this.connecting = new Promise<void>((resolve, reject) => {
      const failConnect = (error: Error): void => {
        this.connecting = null;
        if (this.socket === socket) this.socket = null;
        reject(new RealtimeUnavailableError(error.message));
      };

      socket.once('open', () => {
        this.connecting = null;
        resolve();
      });
      socket.once('error', (error: Error) => {
        failConnect(error);
      });
      socket.once('unexpected-response', (_request, response) => {
        failConnect(new Error(`bridge socket rejected (${response.statusCode})`));
      });
      socket.on('message', (data) => this.handleMessage(data.toString()));
      socket.on('close', () => {
        this.connecting = null;
        if (this.socket === socket) this.socket = null;
        this.rejectAll(new RealtimeUnavailableError('bridge socket closed'));
      });
    });

    return this.connecting;
  }

  private handleMessage(raw: string): void {
    let frame: RealtimeServerFrame;
    try {
      frame = JSON.parse(raw) as RealtimeServerFrame;
    } catch {
      return;
    }

    if (frame.type === 'ready') return;

    if (frame.type === 'error') {
      this.rejectAll(new Error(`${frame.code}: ${frame.message}`));
      return;
    }

    const requestId =
      'requestId' in frame && typeof frame.requestId === 'string'
        ? frame.requestId
        : undefined;
    if (!requestId) return;

    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(frame);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async request<T extends RealtimeServerFrame['type']>(
    frame: RealtimeClientFrame & { requestId: string },
    expected: T,
    timeoutMs: number,
  ): Promise<Extract<RealtimeServerFrame, { type: T }>> {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new RealtimeUnavailableError('bridge socket is not open');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(frame.requestId);
        reject(
          new RealtimeUnavailableError(
            `bridge request ${expected} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs + REQUEST_GRACE_MS);
      timer.unref?.();

      this.pending.set(frame.requestId, {
        resolve: (response) => {
          if (response.type !== expected) {
            reject(new Error(`expected ${expected}, got ${response.type}`));
            return;
          }
          resolve(response as Extract<RealtimeServerFrame, { type: T }>);
        },
        reject,
        timer,
      });

      try {
        socket.send(JSON.stringify(frame));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(frame.requestId);
        reject(new RealtimeUnavailableError((error as Error).message));
      }
    });
  }

  async nextTask(
    timeoutMs = this.config.waitTimeoutMs,
  ): Promise<NextTaskResponse> {
    const response = await this.request(
      {
        type: 'task.claim',
        requestId: randomUUID(),
        timeoutMs,
      },
      'task.assigned',
      timeoutMs,
    );
    return { task: response.task, timedOut: response.timedOut };
  }

  async wait(
    ticketId: string,
    timeoutMs = this.config.waitTimeoutMs,
  ): Promise<WaitResponse> {
    const response = await this.request(
      {
        type: 'ticket.wait',
        requestId: randomUUID(),
        ticketId,
        timeoutMs,
      },
      'ticket.resolved',
      timeoutMs,
    );
    return {
      resolved: isResolvedStatus(response.ticket.status),
      timedOut: response.timedOut,
      ticket: response.ticket,
    };
  }

  async nextChatMessage(
    timeoutMs = this.config.waitTimeoutMs,
  ): Promise<NextChatMessageResponse> {
    const response = await this.request(
      {
        type: 'chat.claim',
        requestId: randomUUID(),
        timeoutMs,
      },
      'chat.assigned',
      timeoutMs,
    );
    return {
      session: response.session,
      message: response.message,
      timedOut: response.timedOut,
    };
  }

  close(): void {
    this.closed = true;
    this.rejectAll(new RealtimeUnavailableError('bridge client closed'));
    try {
      this.socket?.close(1000, 'bridge stopping');
    } catch {
      // Already closed.
    }
    this.socket = null;
  }
}
