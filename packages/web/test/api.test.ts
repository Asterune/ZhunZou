import { describe, expect, it, vi } from 'vitest';

import type { AgentTask, DecisionTicket, EnvHeartbeat } from '@zhunzou/shared';

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

  it('loads tickets with the requested limit', async () => {
    const fetchImpl = mockFetch(jsonResponse({ tickets: [ticket], total: 1 }));
    const api = createHubApi(fetchImpl);

    const result = await api.listTickets(token, 50);

    expect(result.total).toBe(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/tickets?limit=50');
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
