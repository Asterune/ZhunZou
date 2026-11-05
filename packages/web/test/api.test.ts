import { describe, expect, it, vi } from 'vitest';

import type {
  Agent,
  AgentTask,
  DecisionTicket,
  EnvHeartbeat,
  TerminalSession,
} from '@zhunzou/shared';

import { ApiError, createHubApi } from '../src/lib/api';

const token = 'test-token';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(response: Response | (() => Promise<Response>)) {
  return vi.fn(async () =>
    typeof response === 'function' ? response() : response.clone(),
  ) as unknown as typeof fetch;
}

const ticket: DecisionTicket = {
  id: '104',
  env: 'company-cursor',
  projectName: 'yikuaomed-erp',
  status: 'PENDING_HUMAN',
  doneSummary: '完成登录页',
  blockerQuestion: 'Toast 还是行内？',
  nextStepPlan: '接入错误处理',
  options: [
    { key: 'A', label: 'Toast' },
    { key: 'B', label: '行内' },
  ],
  recommendedOption: 'A',
  createdAt: 1,
  updatedAt: 1,
};

const env: EnvHeartbeat = {
  env: 'company-cursor',
  status: 'Running',
  lastSeenAt: 1,
  online: true,
};

const agent: Agent = {
  env: 'company-cursor',
  name: '公司的 Cursor',
  kind: 'cursor',
  status: 'active',
  hasToken: true,
  tokenPrefix: 'zz_abc123',
  online: true,
  lastSeenAt: 1,
  createdAt: 1,
  updatedAt: 1,
};

const terminal: TerminalSession = {
  id: '7',
  env: 'home-mac',
  title: 'deploy shell',
  cols: 120,
  rows: 30,
  status: 'ACTIVE',
  createdAt: 1,
  updatedAt: 1,
  lastActiveAt: 1,
};

const task: AgentTask = {
  id: '12',
  env: 'company-windows',
  projectName: 'yikuaomed-erp',
  title: '给登录页补错误提示',
  instruction: '统一使用行内文案。',
  status: 'PENDING',
  attempts: 0,
  createdAt: 1,
  updatedAt: 1,
};

describe('createHubApi', () => {
  it('sends the bearer token when loading dashboard status', async () => {
    const fetchImpl = mockFetch(jsonResponse({ envs: [env] }));
    const api = createHubApi(fetchImpl);

    const result = await api.status(token);

    expect(result.envs).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/status',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${token}` }),
      }),
    );
  });

  it('lists registered agents', async () => {
    const fetchImpl = mockFetch(jsonResponse({ agents: [agent] }));
    const api = createHubApi(fetchImpl);

    const result = await api.listAgents(token);

    expect(result.agents[0]).toMatchObject({ env: 'company-cursor', kind: 'cursor' });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/agents');
  });

  it('creates, lists and closes terminal sessions', async () => {
    const fetchImpl = mockFetch(jsonResponse({ session: terminal }));
    const api = createHubApi(fetchImpl);

    await api.createTerminal(token, { env: 'home-mac', cols: 120, rows: 30 });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/terminals');
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');

    await api.listTerminals(token, 'home-mac');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/terminals?limit=50&env=home-mac');

    await api.closeTerminal(token, '7', 'done');
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('/api/terminals/7/close');
    expect(
      JSON.parse(String((fetchImpl.mock.calls[2]?.[1] as RequestInit).body)),
    ).toEqual({ reason: 'done' });

    await api.getTerminalAudit(token, '7');
    expect(fetchImpl.mock.calls[3]?.[0]).toBe(
      '/api/terminals/7/audit?after=0&limit=100',
    );

    await api.getTerminalStats(token);
    expect(fetchImpl.mock.calls[4]?.[0]).toBe('/api/terminals/stats');
  });

  it('exchanges the admin token for a short-lived realtime ticket', async () => {
    const fetchImpl = mockFetch(
      jsonResponse({ ticket: 'realtime.1.sig', expiresAt: 2 }),
    );
    const api = createHubApi(fetchImpl);

    const result = await api.createRealtimeTicket(token);

    expect(result.ticket).toBe('realtime.1.sig');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/realtime/ticket');
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
  });

  it('registers, edits, issues and revokes agent tokens', async () => {
    const fetchImpl = mockFetch(jsonResponse({ agent }));
    const api = createHubApi(fetchImpl);

    await api.createAgent(token, { env: 'company-cursor', kind: 'cursor' });
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect(
      JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body)),
    ).toEqual({ env: 'company-cursor', kind: 'cursor' });

    await api.updateAgent(token, 'company-cursor', { name: 'Cursor 1' });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/agents/company-cursor');
    expect((fetchImpl.mock.calls[1]?.[1] as RequestInit).method).toBe('PATCH');

    const issued = mockFetch(
      jsonResponse({ agent, token: 'zz_plaintext' }),
    );
    const issuingApi = createHubApi(issued);
    const result = await issuingApi.issueAgentToken(token, 'company-cursor');
    expect(result.token).toBe('zz_plaintext');
    expect(issued.mock.calls[0]?.[0]).toBe(
      '/api/agents/company-cursor/token',
    );

    await api.revokeAgentToken(token, 'company-cursor');
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(
      '/api/agents/company-cursor/token',
    );
    expect((fetchImpl.mock.calls[2]?.[1] as RequestInit).method).toBe('DELETE');
  });

  it('loads task logs after a cursor', async () => {
    const fetchImpl = mockFetch(
      jsonResponse({
        logs: [
          { id: 2, taskId: '12', stream: 'stdout', chunk: 'hi', createdAt: 1 },
        ],
        nextAfter: 2,
        truncated: false,
      }),
    );
    const api = createHubApi(fetchImpl);

    const result = await api.getTaskLogs(token, '12', 1);

    expect(result.nextAfter).toBe(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      '/api/tasks/12/logs?after=1&limit=200',
    );
  });

  it('lists chat sessions and sends a message', async () => {
    const fetchImpl = mockFetch(
      jsonResponse({
        sessions: [
          {
            id: '1',
            env: 'company-cursor',
            title: '会话',
            status: 'ACTIVE',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    const api = createHubApi(fetchImpl);

    const list = await api.listChatSessions(token);
    expect(list.sessions).toHaveLength(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/sessions?limit=50');

    await api.sendChatMessage(token, '1', 'hello');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/sessions/1/messages');
    expect(
      JSON.parse(String((fetchImpl.mock.calls[1]?.[1] as RequestInit).body)),
    ).toEqual({ content: 'hello' });

    await api.retryChatMessage(token, '1', '2');
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(
      '/api/sessions/1/messages/2/retry',
    );
  });

  it('tails chat events after a cursor', async () => {
    const fetchImpl = mockFetch(
      jsonResponse({
        events: [
          {
            id: 3,
            sessionId: '1',
            messageId: '2',
            stream: 'stdout',
            chunk: 'hi',
            createdAt: 1,
          },
        ],
        nextAfter: 3,
        truncated: false,
      }),
    );
    const api = createHubApi(fetchImpl);

    const result = await api.getChatEvents(token, '1', 2, '2');

    expect(result.nextAfter).toBe(3);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      '/api/sessions/1/events?after=2&messageId=2',
    );
  });

  it('loads tickets with the requested limit', async () => {
    const fetchImpl = mockFetch(jsonResponse({ tickets: [ticket], total: 1 }));
    const api = createHubApi(fetchImpl);

    const result = await api.listTickets(token, 50);

    expect(result.total).toBe(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/tickets?limit=50');
  });

  it('long-polls the dashboard sync endpoint with the current revision', async () => {
    const fetchImpl = mockFetch(
      jsonResponse({ rev: 7, changed: false }),
    );
    const api = createHubApi(fetchImpl);

    const result = await api.sync(token, 6, 25_000);

    expect(result).toEqual({ rev: 7, changed: false });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      '/api/sync?after=6&timeout=25000',
    );
  });

  it('posts an approval with the selected option and instruction', async () => {
    const fetchImpl = mockFetch(jsonResponse({ ticket }));
    const api = createHubApi(fetchImpl);

    await api.resolve(token, '104', {
      selectedOption: 'B',
      customInstruction: '先只改登录页',
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/tickets/104/resolve');
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      selectedOption: 'B',
      customInstruction: '先只改登录页',
    });
  });

  it('reads and writes GLOBAL_RULES.md', async () => {
    const fetchImpl = mockFetch(
      jsonResponse({ content: '# 规则', updatedAt: 123 }),
    );
    const api = createHubApi(fetchImpl);

    const rules = await api.getRules(token);
    expect(rules.content).toBe('# 规则');

    await api.saveRules(token, '# 新规则');
    const init = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ content: '# 新规则' });
  });

  it('batch-resolves, extends and cancels tickets', async () => {
    const fetchImpl = mockFetch(
      jsonResponse({ tickets: [ticket], skipped: [] }),
    );
    const api = createHubApi(fetchImpl);

    await api.batchResolve(token, {
      ticketIds: ['104', '105'],
      confirmDestructive: true,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/tickets/batch-resolve');
    expect(
      JSON.parse(
        String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body),
      ),
    ).toEqual({ ticketIds: ['104', '105'], confirmDestructive: true });

    await api.extendTicket(token, '104', { minutes: 15 });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/tickets/104/extend');
    expect(
      JSON.parse(String((fetchImpl.mock.calls[1]?.[1] as RequestInit).body)),
    ).toEqual({ minutes: 15 });

    await api.cancelTicket(token, '104');
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('/api/tickets/104/cancel');
    expect(
      (
        (fetchImpl.mock.calls[2]?.[1] as RequestInit)
          .headers as Record<string, string>
      )['content-type'],
    ).toBeUndefined();
  });

  it('lists, accepts and dismisses rule candidates', async () => {
    const candidate = {
      id: '7',
      ticketId: '104',
      content: '- 表单错误优先使用行内文案。',
      status: 'PENDING' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchImpl = mockFetch(
      jsonResponse({ candidates: [candidate], total: 1 }),
    );
    const api = createHubApi(fetchImpl);

    const list = await api.listRuleCandidates(token, 'PENDING', 20);
    expect(list.total).toBe(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      '/api/rules/candidates?limit=20&status=PENDING',
    );

    await api.acceptRuleCandidate(token, '7');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      '/api/rules/candidates/7/accept',
    );
    const acceptInit = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect(acceptInit.method).toBe('POST');
    expect(
      (acceptInit.headers as Record<string, string>)['content-type'],
    ).toBeUndefined();

    await api.dismissRuleCandidate(token, '7');
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(
      '/api/rules/candidates/7/dismiss',
    );
  });

  it('creates, lists and cancels dispatched tasks', async () => {
    const fetchImpl = mockFetch(jsonResponse({ task }));
    const api = createHubApi(fetchImpl);

    const list = await api.listTasks(token, 50);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/tasks?limit=50');
    expect(list).toBeDefined();

    await api.createTask(token, {
      env: 'company-windows',
      title: '给登录页补错误提示',
      instruction: '统一使用行内文案。',
    });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/tasks');
    const init = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      env: 'company-windows',
      title: '给登录页补错误提示',
      instruction: '统一使用行内文案。',
    });

    await api.cancelTask(token, '12');
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('/api/tasks/12/cancel');
    expect(
      (
        (fetchImpl.mock.calls[2]?.[1] as RequestInit)
          .headers as Record<string, string>
      )['content-type'],
    ).toBeUndefined();
  });

  it('lists, bind and unbind workspace projects', async () => {
    const project = {
      id: '3',
      env: 'home-mac-opencode',
      projectName: 'agent-hub',
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchImpl = mockFetch(jsonResponse({ project }));
    const api = createHubApi(fetchImpl);

    // The mock returns the same body for every call; only request shapes matter.
    await api.listWorkspaceProjects(token, 'home-mac-opencode');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      '/api/workspace-projects?env=home-mac-opencode',
    );

    await api.bindWorkspaceProject(token, {
      env: 'home-mac-opencode',
      projectName: 'agent-hub',
    });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/workspace-projects');
    const init = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      env: 'home-mac-opencode',
      projectName: 'agent-hub',
    });

    await api.unbindWorkspaceProject(token, '3');
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('/api/workspace-projects/3');
    expect((fetchImpl.mock.calls[2]?.[1] as RequestInit).method).toBe('DELETE');
  });

  it('maps API errors to ApiError with code and status', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(
        { error: { code: 'ALREADY_FINALIZED', message: 'ticket is done' } },
        409,
      ),
    );
    const api = createHubApi(fetchImpl);

    const error = await api.resolve(token, '104', { selectedOption: 'A' }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'ALREADY_FINALIZED',
      message: 'ticket is done',
    });
  });

  it('maps network failures to status 0', async () => {
    const api = createHubApi(
      mockFetch(async () => {
        throw new Error('connection refused');
      }),
    );

    await expect(api.status(token)).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
    });
  });

  it('falls back to HTTP_<status> when the error body is not JSON', async () => {
    const api = createHubApi(
      mockFetch(new Response('upstream exploded', { status: 502 })),
    );

    await expect(api.getRules(token)).rejects.toMatchObject({
      status: 502,
      code: 'HTTP_502',
    });
  });
});
