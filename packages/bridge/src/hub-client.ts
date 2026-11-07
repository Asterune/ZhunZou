import { arch, hostname, platform } from 'node:os';

import type {
  AgentTask,
  AppendChatEventInput,
  AppendTaskLogInput,
  ChatEvent,
  ChatMessageResponse,
  CompleteChatMessageInput,
  CompleteTaskInput,
  CreateTicketInput,
  DecisionRequest,
  DecisionResponse,
  DecisionTicket,
  EnvHeartbeat,
  Exchange,
  FleetBrowseResultInput,
  FleetCandidate,
  FleetDesiredListResponse,
  FleetWorkspaceStatusInput,
  HeartbeatInput,
  ListTasksQuery,
  NextChatMessageResponse,
  NextTaskResponse,
  ProposeChatReplyInput,
  ReleaseTaskInput,
  ReportExchangeInput,
  ReportFleetCandidatesInput,
  ResumeResponse,
  TaskListResponse,
  TaskLog,
  WaitResponse,
} from '@zhunzou/shared';
import {
  appendChatEventSchema,
  appendTaskLogSchema,
  completeChatMessageSchema,
  completeTaskSchema,
  createTicketSchema,
  decisionRequestSchema,
  fleetBrowseResultInputSchema,
  fleetWorkspaceStatusInputSchema,
  heartbeatSchema,
  proposeChatReplySchema,
  releaseTaskSchema,
  reportExchangeSchema,
  reportFleetCandidatesSchema,
  ticketIdSchema,
} from '@zhunzou/shared';

import type { BridgeConfig } from './config.js';
import { machineId } from './machine-id.js';
import { BRIDGE_VERSION } from './version.js';

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
  /**
   * `projectName` is optional here: the bridge fills it from the workspace
   * config so the MCP tool does not have to know it.
   */
  decide(
    input: Omit<DecisionRequest, 'env' | 'projectName'> & {
      projectName?: string;
    },
  ): Promise<DecisionResponse>;
  wait(ticketId: string, timeoutMs?: number): Promise<WaitResponse>;
  heartbeat(input: Omit<HeartbeatInput, 'env'>): Promise<EnvHeartbeat>;
  nextTask(timeoutMs?: number): Promise<NextTaskResponse>;
  nextChatMessage(
    timeoutMs?: number,
    runnerId?: string,
  ): Promise<NextChatMessageResponse>;
  appendChatEvent(
    sessionId: string,
    messageId: string,
    input: AppendChatEventInput,
  ): Promise<ChatEvent>;
  completeChatMessage(
    sessionId: string,
    messageId: string,
    input: CompleteChatMessageInput,
  ): Promise<ChatMessageResponse>;
  proposeChatReply(
    input: Omit<ProposeChatReplyInput, 'env'>,
  ): Promise<ChatMessageResponse>;
  listTasks(query?: Omit<ListTasksQuery, 'env'>): Promise<TaskListResponse>;
  completeTask(taskId: string, input: CompleteTaskInput): Promise<AgentTask>;
  appendTaskLog(taskId: string, input: AppendTaskLogInput): Promise<TaskLog>;
  releaseTask(taskId: string, input: ReleaseTaskInput): Promise<AgentTask>;
  reportExchange(
    input: Omit<ReportExchangeInput, 'env'>,
  ): Promise<Exchange>;
  resume(sinceMs?: number): Promise<ResumeResponse>;
  /** Publish local directories the dashboard can associate with an env. */
  reportFleetCandidates(
    input: ReportFleetCandidatesInput,
  ): Promise<{ candidates: FleetCandidate[]; total: number }>;
  /** Directories the human associated with this machine but the bridge has not applied yet. */
  listDesiredWorkspaces(): Promise<FleetDesiredListResponse>;
  reportFleetWorkspaceStatus(
    workspaceId: string,
    input: FleetWorkspaceStatusInput,
  ): Promise<void>;
  /** Return one directory listing requested by the dashboard picker. */
  reportFleetBrowseResult(
    requestId: string,
    input: FleetBrowseResultInput,
  ): Promise<void>;
  /** Present on clients that hold a realtime socket. */
  close?(): void;
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

  /**
   * Ask the hub to rule on the next move. This replaces the agent's own
   * "should I ask a human?" judgment: the answer is either a permit or a
   * ticket that a human will decide.
   */
  async decide(
    input: Omit<DecisionRequest, 'env' | 'projectName'> & {
      projectName?: string;
    },
  ): Promise<DecisionResponse> {
    const payload = decisionRequestSchema.parse({
      env: this.config.agentEnv,
      ...input,
      projectName:
        input.projectName ?? this.config.projectName ?? this.config.agentEnv,
      ...(this.config.chatSessionId && !input.sessionId
        ? { sessionId: this.config.chatSessionId }
        : {}),
    });

    return this.request<DecisionResponse>(
      '/api/decisions',
      { method: 'POST', body: JSON.stringify(payload) },
      REQUEST_GRACE_MS + 15_000,
    );
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
      // Every heartbeat doubles as a registry update, so the dashboard can
      // show the client type / version / host without extra setup.
      agent: {
        kind: this.config.agentKind,
        version: BRIDGE_VERSION,
        host: hostname(),
        os: `${platform()}-${arch()}`,
        machineId: machineId(),
        ...(input.agent ?? {}),
      },
    });

    const body = await this.request<{ heartbeat: EnvHeartbeat }>(
      '/api/status/heartbeat',
      { method: 'POST', body: JSON.stringify(payload) },
      REQUEST_GRACE_MS,
    );

    return body.heartbeat;
  }

  async nextChatMessage(
    timeoutMs = this.config.waitTimeoutMs,
    runnerId?: string,
  ): Promise<NextChatMessageResponse> {
    const query = new URLSearchParams({
      env: this.config.agentEnv,
      timeout: String(timeoutMs),
    });
    if (runnerId) query.set('runner', runnerId);
    return this.request<NextChatMessageResponse>(
      `/api/sessions/next?${query.toString()}`,
      { method: 'GET' },
      timeoutMs + REQUEST_GRACE_MS,
    );
  }

  async appendChatEvent(
    sessionId: string,
    messageId: string,
    input: AppendChatEventInput,
  ): Promise<ChatEvent> {
    const sid = ticketIdSchema.parse(String(sessionId));
    const mid = ticketIdSchema.parse(String(messageId));
    const payload = appendChatEventSchema.parse(input);
    const body = await this.request<{ event: ChatEvent }>(
      `/api/sessions/${sid}/messages/${mid}/events`,
      { method: 'POST', body: JSON.stringify(payload) },
      REQUEST_GRACE_MS,
    );
    return body.event;
  }

  async completeChatMessage(
    sessionId: string,
    messageId: string,
    input: CompleteChatMessageInput,
  ): Promise<ChatMessageResponse> {
    const sid = ticketIdSchema.parse(String(sessionId));
    const mid = ticketIdSchema.parse(String(messageId));
    const payload = completeChatMessageSchema.parse(input);
    return this.request<ChatMessageResponse>(
      `/api/sessions/${sid}/messages/${mid}/complete`,
      { method: 'POST', body: JSON.stringify(payload) },
      REQUEST_GRACE_MS,
    );
  }

  /**
   * Draft a reply for the human to adopt. The hub keeps it PROPOSED, so this
   * never speaks for the human by itself.
   */
  async proposeChatReply(
    input: Omit<ProposeChatReplyInput, 'env'>,
  ): Promise<ChatMessageResponse> {
    const payload = proposeChatReplySchema.parse({
      env: this.config.agentEnv,
      ...input,
      ...(this.config.chatSessionId && !input.sessionId
        ? { sessionId: this.config.chatSessionId }
        : {}),
    });
    return this.request<ChatMessageResponse>(
      '/api/sessions/proposals',
      { method: 'POST', body: JSON.stringify(payload) },
      REQUEST_GRACE_MS,
    );
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

  async appendTaskLog(
    taskId: string,
    input: AppendTaskLogInput,
  ): Promise<TaskLog> {
    const id = ticketIdSchema.parse(String(taskId));
    const payload = appendTaskLogSchema.parse(input);
    const body = await this.request<{ log: TaskLog }>(
      `/api/tasks/${id}/log`,
      { method: 'POST', body: JSON.stringify(payload) },
      REQUEST_GRACE_MS,
    );
    return body.log;
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

  async reportExchange(
    input: Omit<ReportExchangeInput, 'env'>,
  ): Promise<Exchange> {
    const payload = reportExchangeSchema.parse({
      ...input,
      env: this.config.agentEnv,
    });

    const body = await this.request<{ exchange: Exchange }>(
      '/api/exchanges',
      { method: 'POST', body: JSON.stringify(payload) },
      REQUEST_GRACE_MS,
    );
    return body.exchange;
  }

  async reportFleetCandidates(
    input: ReportFleetCandidatesInput,
  ): Promise<{ candidates: FleetCandidate[]; total: number }> {
    const payload = reportFleetCandidatesSchema.parse(input);
    return this.request<{ candidates: FleetCandidate[]; total: number }>(
      '/api/fleet/candidates',
      { method: 'POST', body: JSON.stringify(payload) },
      REQUEST_GRACE_MS,
    );
  }

  async listDesiredWorkspaces(): Promise<FleetDesiredListResponse> {
    const query = new URLSearchParams({ host: hostname() });
    return this.request<FleetDesiredListResponse>(
      `/api/fleet/desired?${query.toString()}`,
      { method: 'GET' },
      REQUEST_GRACE_MS,
    );
  }

  async reportFleetWorkspaceStatus(
    workspaceId: string,
    input: FleetWorkspaceStatusInput,
  ): Promise<void> {
    const id = ticketIdSchema.parse(String(workspaceId));
    const payload = fleetWorkspaceStatusInputSchema.parse(input);
    await this.request<unknown>(
      `/api/fleet/desired/${id}/status`,
      { method: 'POST', body: JSON.stringify(payload) },
      REQUEST_GRACE_MS,
    );
  }

  async reportFleetBrowseResult(
    requestId: string,
    input: FleetBrowseResultInput,
  ): Promise<void> {
    const id = ticketIdSchema.parse(String(requestId));
    const payload = fleetBrowseResultInputSchema.parse(input);
    await this.request<unknown>(
      `/api/fleet/browse/${id}/result`,
      { method: 'POST', body: JSON.stringify(payload) },
      REQUEST_GRACE_MS,
    );
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
