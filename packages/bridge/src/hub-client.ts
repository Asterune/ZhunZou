import type {
  AgentTask,
  CompleteTaskInput,
  CreateTicketInput,
  DecisionTicket,
  EnvHeartbeat,
  HeartbeatInput,
  ListTasksQuery,
  NextTaskResponse,
  ReleaseTaskInput,
  ResumeResponse,
  TaskListResponse,
  WaitResponse,
} from '@zhunzou/shared';
import {
  completeTaskSchema,
  createTicketSchema,
  heartbeatSchema,
  releaseTaskSchema,
  ticketIdSchema,
} from '@zhunzou/shared';

import type { BridgeConfig } from './config.js';

export class HubApiError extends Error {
  /** HTTP status, or 0 for network/timeout failures. */
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HubApiError';
    this.status = status;
    this.code = code;
  }

  get retryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

export interface HubApi {
  createTicket(input: Omit<CreateTicketInput, 'env'>): Promise<DecisionTicket>;
  wait(ticketId: string, timeoutMs?: number): Promise<WaitResponse>;
  heartbeat(input: Omit<HeartbeatInput, 'env'>): Promise<EnvHeartbeat>;
  nextTask(timeoutMs?: number): Promise<NextTaskResponse>;
  listTasks(query?: Omit<ListTasksQuery, 'env'>): Promise<TaskListResponse>;
  completeTask(taskId: string, input: CompleteTaskInput): Promise<AgentTask>;
  releaseTask(taskId: string, input: ReleaseTaskInput): Promise<AgentTask>;
  resume(sinceMs?: number): Promise<ResumeResponse>;
}

const REQUEST_GRACE_MS = 10_000;

export class HubClient implements HubApi {
  constructor(
    private readonly config: BridgeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string): string {
    return `${this.config.hubUrl}${path}`;
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(this.url(path), {
        ...init,
        headers: {
          authorization: `Bearer ${this.config.token}`,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });

      const body = (await response.json().catch(() => null)) as
        | { error?: { code?: string; message?: string } }
        | null;

      if (!response.ok) {
        throw new HubApiError(
          response.status,
          body?.error?.code ?? `HTTP_${response.status}`,
          body?.error?.message ?? `Zhunzou request failed (${response.status})`,
        );
      }

      return body as T;
    } catch (error) {
      if (error instanceof HubApiError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new HubApiError(
          0,
          'REQUEST_TIMEOUT',
          `Zhunzou request timed out after ${timeoutMs}ms`,
        );
      }
      throw new HubApiError(
        0,
        'NETWORK_ERROR',
        `Cannot reach Zhunzou at ${this.config.hubUrl}: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async createTicket(input: Omit<CreateTicketInput, 'env'>): Promise<DecisionTicket> {
    const payload = createTicketSchema.parse({
      ...input,
      env: this.config.agentEnv,
    });

    const body = await this.request<{ ticket: DecisionTicket }>(
      '/api/tickets',
      { method: 'POST', body: JSON.stringify(payload) },
      REQUEST_GRACE_MS + 5_000,
    );

    return body.ticket;
  }

  async wait(ticketId: string, timeoutMs = this.config.waitTimeoutMs): Promise<WaitResponse> {
    const id = ticketIdSchema.parse(String(ticketId));
    return this.request<WaitResponse>(
      `/api/tickets/${id}/wait?timeout=${timeoutMs}`,
      { method: 'GET' },
      timeoutMs + REQUEST_GRACE_MS,
    );
  }

  async heartbeat(input: Omit<HeartbeatInput, 'env'>): Promise<EnvHeartbeat> {
    const payload = heartbeatSchema.parse({
      ...input,
      env: this.config.agentEnv,
    });

    const body = await this.request<{ heartbeat: EnvHeartbeat }>(
      '/api/status/heartbeat',
      { method: 'POST', body: JSON.stringify(payload) },
      REQUEST_GRACE_MS,
    );

    return body.heartbeat;
  }

  async nextTask(timeoutMs = this.config.waitTimeoutMs): Promise<NextTaskResponse> {
    const query = new URLSearchParams({
      env: this.config.agentEnv,
      timeout: String(timeoutMs),
    });
    return this.request<NextTaskResponse>(
      `/api/tasks/next?${query.toString()}`,
      { method: 'GET' },
      timeoutMs + REQUEST_GRACE_MS,
    );
  }

  async listTasks(query: Partial<Omit<ListTasksQuery, 'env'>> = {}): Promise<TaskListResponse> {
    const params = new URLSearchParams({ env: this.config.agentEnv });
    if (query.status) params.set('status', query.status);
    if (query.limit !== undefined) params.set('limit', String(query.limit));

    return this.request<TaskListResponse>(
      `/api/tasks?${params.toString()}`,
      { method: 'GET' },
      REQUEST_GRACE_MS,
    );
  }

  async resume(sinceMs?: number): Promise<ResumeResponse> {
    const query = new URLSearchParams({ env: this.config.agentEnv });
    if (sinceMs !== undefined) query.set('since', String(sinceMs));

    return this.request<ResumeResponse>(
      `/api/resume?${query.toString()}`,
      { method: 'GET' },
      REQUEST_GRACE_MS,
    );
  }

  async completeTask(taskId: string, input: CompleteTaskInput): Promise<AgentTask> {
    const id = ticketIdSchema.parse(String(taskId));
    const payload = completeTaskSchema.parse(input);

    const body = await this.request<{ task: AgentTask }>(
      `/api/tasks/${id}/complete`,
      { method: 'POST', body: JSON.stringify(payload) },
      REQUEST_GRACE_MS,
    );

    return body.task;
  }

  async releaseTask(taskId: string, input: ReleaseTaskInput): Promise<AgentTask> {
    const id = ticketIdSchema.parse(String(taskId));
    const payload = releaseTaskSchema.parse(input);

    const body = await this.request<{ task: AgentTask }>(
      `/api/tasks/${id}/release`,
      { method: 'POST', body: JSON.stringify(payload) },
      REQUEST_GRACE_MS,
    );

    return body.task;
  }

  /** Best-effort status update; never blocks a decision. */
  async heartbeatSafe(input: Omit<HeartbeatInput, 'env'>): Promise<void> {
    try {
      await this.heartbeat(input);
    } catch {
      // The dashboard is advisory; never fail the escalation because of it.
    }
  }
}
