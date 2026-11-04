import type {
  AgentListResponse,
  AgentResponse,
  AgentTokenResponse,
  BatchResolveResponse,
  BatchResolveTicketsInput,
  BindWorkspaceProjectInput,
  ChatEventListResponse,
  ChatSessionListResponse,
  ChatSessionResponse,
  CreateAgentInput,
  CreateChatSessionInput,
  CreateTaskInput,
  DecisionTicket,
  EnvHeartbeat,
  ExchangeListResponse,
  ExtendTicketInput,
  ResolveTicketInput,
  RuleCandidateActionResponse,
  RuleCandidateListResponse,
  RuleCandidateStatus,
  RulesResponse,
  SyncResponse,
  TaskListResponse,
  TaskLogListResponse,
  TaskResponse,
  TicketListResponse,
  TicketResponse,
  UpdateAgentInput,
  WorkspaceProjectListResponse,
  WorkspaceProjectResponse,
} from '@zhunzou/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export interface HubApi {
  status(token: string): Promise<{ envs: EnvHeartbeat[] }>;
  listAgents(token: string): Promise<AgentListResponse>;
  listExchanges(
    token: string,
    limit?: number,
    env?: string,
  ): Promise<ExchangeListResponse>;
  createAgent(token: string, input: CreateAgentInput): Promise<AgentResponse>;
  updateAgent(
    token: string,
    env: string,
    input: UpdateAgentInput,
  ): Promise<AgentResponse>;
  deleteAgent(token: string, env: string): Promise<{ deleted: boolean; env: string }>;
  issueAgentToken(token: string, env: string): Promise<AgentTokenResponse>;
  revokeAgentToken(token: string, env: string): Promise<AgentResponse>;
  listTickets(token: string, limit?: number): Promise<TicketListResponse>;
  resolve(
    token: string,
    ticketId: string,
    input: ResolveTicketInput,
  ): Promise<TicketResponse>;
  batchResolve(
    token: string,
    input: BatchResolveTicketsInput,
  ): Promise<BatchResolveResponse>;
  extendTicket(
    token: string,
    ticketId: string,
    input: ExtendTicketInput,
  ): Promise<TicketResponse>;
  cancelTicket(token: string, ticketId: string): Promise<TicketResponse>;
  getRules(token: string): Promise<RulesResponse>;
  saveRules(token: string, content: string): Promise<RulesResponse>;
  listRuleCandidates(
    token: string,
    status?: RuleCandidateStatus,
    limit?: number,
  ): Promise<RuleCandidateListResponse>;
  acceptRuleCandidate(
    token: string,
    candidateId: string,
  ): Promise<RuleCandidateActionResponse>;
  dismissRuleCandidate(
    token: string,
    candidateId: string,
  ): Promise<RuleCandidateActionResponse>;
  listTasks(token: string, limit?: number): Promise<TaskListResponse>;
  sync(token: string, after?: number, timeout?: number): Promise<SyncResponse>;
  getTaskLogs(
    token: string,
    taskId: string,
    after?: number,
    limit?: number,
  ): Promise<TaskLogListResponse>;
  listChatSessions(
    token: string,
    env?: string,
    limit?: number,
  ): Promise<ChatSessionListResponse>;
  createChatSession(
    token: string,
    input: CreateChatSessionInput,
  ): Promise<ChatSessionResponse>;
  getChatSession(token: string, sessionId: string): Promise<ChatSessionResponse>;
  sendChatMessage(
    token: string,
    sessionId: string,
    content: string,
  ): Promise<ChatSessionResponse>;
  closeChatSession(
    token: string,
    sessionId: string,
  ): Promise<ChatSessionResponse>;
  retryChatMessage(
    token: string,
    sessionId: string,
    messageId: string,
  ): Promise<ChatSessionResponse>;
  getChatEvents(
    token: string,
    sessionId: string,
    after?: number,
    messageId?: string,
  ): Promise<ChatEventListResponse>;
  createTask(token: string, input: CreateTaskInput): Promise<TaskResponse>;
  cancelTask(token: string, taskId: string): Promise<TaskResponse>;
  listWorkspaceProjects(
    token: string,
    env?: string,
  ): Promise<WorkspaceProjectListResponse>;
  bindWorkspaceProject(
    token: string,
    input: BindWorkspaceProjectInput,
  ): Promise<WorkspaceProjectResponse>;
  unbindWorkspaceProject(
    token: string,
    projectId: string,
  ): Promise<WorkspaceProjectResponse>;
}

export function createHubApi(fetchImpl: typeof fetch = fetch): HubApi {
  async function request<T>(
    token: string,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    let response: Response;

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    };
    // Fastify rejects an empty body when content-type is application/json,
    // so only declare JSON when we actually send one.
    if (init.body !== undefined && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }

    try {
      response = await fetchImpl(path, {
        ...init,
        headers,
      });
    } catch (error) {
      throw new ApiError(0, 'NETWORK_ERROR', (error as Error).message);
    }

    const body = (await response.json().catch(() => null)) as
      | (T & ApiErrorBody)
      | null;

    if (!response.ok) {
      throw new ApiError(
        response.status,
        body?.error?.code ?? `HTTP_${response.status}`,
        body?.error?.message ?? `请求失败（${response.status}）`,
      );
    }

    return body as T;
  }

  return {
    status: (token) => request<{ envs: EnvHeartbeat[] }>(token, '/api/status'),

    listAgents: (token) => request<AgentListResponse>(token, '/api/agents'),

    listExchanges: (token, limit = 20, env) =>
      request<ExchangeListResponse>(
        token,
        `/api/exchanges?limit=${limit}${env ? `&env=${encodeURIComponent(env)}` : ''}`,
      ),

    createAgent: (token, input) =>
      request<AgentResponse>(token, '/api/agents', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    updateAgent: (token, env, input) =>
      request<AgentResponse>(token, `/api/agents/${encodeURIComponent(env)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),

    deleteAgent: (token, env) =>
      request<{ deleted: boolean; env: string }>(
        token,
        `/api/agents/${encodeURIComponent(env)}`,
        { method: 'DELETE' },
      ),

    issueAgentToken: (token, env) =>
      request<AgentTokenResponse>(
        token,
        `/api/agents/${encodeURIComponent(env)}/token`,
        { method: 'POST' },
      ),

    revokeAgentToken: (token, env) =>
      request<AgentResponse>(
        token,
        `/api/agents/${encodeURIComponent(env)}/token`,
        { method: 'DELETE' },
      ),

    listTickets: (token, limit = 200) =>
      request<TicketListResponse>(token, `/api/tickets?limit=${limit}`),

    resolve: (token, ticketId, input) =>
      request<TicketResponse>(token, `/api/tickets/${ticketId}/resolve`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    batchResolve: (token, input) =>
      request<BatchResolveResponse>(token, '/api/tickets/batch-resolve', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    extendTicket: (token, ticketId, input) =>
      request<TicketResponse>(token, `/api/tickets/${ticketId}/extend`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    cancelTicket: (token, ticketId) =>
      request<TicketResponse>(token, `/api/tickets/${ticketId}/cancel`, {
        method: 'POST',
      }),

    getRules: (token) => request<RulesResponse>(token, '/api/rules'),

    saveRules: (token, content) =>
      request<RulesResponse>(token, '/api/rules', {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }),

    listRuleCandidates: (token, status, limit = 50) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (status) params.set('status', status);
      return request<RuleCandidateListResponse>(
        token,
        `/api/rules/candidates?${params.toString()}`,
      );
    },

    acceptRuleCandidate: (token, candidateId) =>
      request<RuleCandidateActionResponse>(
        token,
        `/api/rules/candidates/${candidateId}/accept`,
        { method: 'POST' },
      ),

    dismissRuleCandidate: (token, candidateId) =>
      request<RuleCandidateActionResponse>(
        token,
        `/api/rules/candidates/${candidateId}/dismiss`,
        { method: 'POST' },
      ),

    listTasks: (token, limit = 100) =>
      request<TaskListResponse>(token, `/api/tasks?limit=${limit}`),

    // Long poll: the server holds the request until the dashboard changes.
    sync: (token, after = 0, timeout = 25_000) =>
      request<SyncResponse>(
        token,
        `/api/sync?after=${after}&timeout=${timeout}`,
      ),

    getTaskLogs: (token, taskId, after = 0, limit = 200) =>
      request<TaskLogListResponse>(
        token,
        `/api/tasks/${taskId}/logs?after=${after}&limit=${limit}`,
      ),

    listChatSessions: (token, env, limit = 50) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (env) params.set('env', env);
      return request<ChatSessionListResponse>(
        token,
        `/api/sessions?${params.toString()}`,
      );
    },

    createChatSession: (token, input) =>
      request<ChatSessionResponse>(token, '/api/sessions', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    getChatSession: (token, sessionId) =>
      request<ChatSessionResponse>(token, `/api/sessions/${sessionId}`),

    sendChatMessage: (token, sessionId, content) =>
      request<ChatSessionResponse>(
        token,
        `/api/sessions/${sessionId}/messages`,
        { method: 'POST', body: JSON.stringify({ content }) },
      ),

    closeChatSession: (token, sessionId) =>
      request<ChatSessionResponse>(token, `/api/sessions/${sessionId}/close`, {
        method: 'POST',
      }),

    retryChatMessage: (token, sessionId, messageId) =>
      request<ChatSessionResponse>(
        token,
        `/api/sessions/${sessionId}/messages/${messageId}/retry`,
        { method: 'POST' },
      ),

    getChatEvents: (token, sessionId, after = 0, messageId) => {
      const params = new URLSearchParams({ after: String(after) });
      if (messageId) params.set('messageId', messageId);
      return request<ChatEventListResponse>(
        token,
        `/api/sessions/${sessionId}/events?${params.toString()}`,
      );
    },

    createTask: (token, input) =>
      request<TaskResponse>(token, '/api/tasks', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    cancelTask: (token, taskId) =>
      request<TaskResponse>(token, `/api/tasks/${taskId}/cancel`, {
        method: 'POST',
      }),

    listWorkspaceProjects: (token, env) => {
      const query = env ? `?env=${encodeURIComponent(env)}` : '';
      return request<WorkspaceProjectListResponse>(
        token,
        `/api/workspace-projects${query}`,
      );
    },

    bindWorkspaceProject: (token, input) =>
      request<WorkspaceProjectResponse>(token, '/api/workspace-projects', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    unbindWorkspaceProject: (token, projectId) =>
      request<WorkspaceProjectResponse>(
        token,
        `/api/workspace-projects/${projectId}`,
        { method: 'DELETE' },
      ),
  };
}

export const hubApi = createHubApi();

export type { DecisionTicket };
