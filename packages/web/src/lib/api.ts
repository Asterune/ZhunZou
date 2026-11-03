import type {
  BatchResolveResponse,
  BatchResolveTicketsInput,
  BindWorkspaceProjectInput,
  CreateTaskInput,
  DecisionTicket,
  EnvHeartbeat,
  ExtendTicketInput,
  ResolveTicketInput,
  RuleCandidateActionResponse,
  RuleCandidateListResponse,
  RuleCandidateStatus,
  RulesResponse,
  TaskListResponse,
  TaskResponse,
  TicketListResponse,
  TicketResponse,
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
