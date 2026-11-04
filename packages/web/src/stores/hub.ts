import { computed, reactive, ref } from 'vue';

import type {
  Agent,
  AgentTask,
  CreateAgentInput,
  CreateTaskInput,
  DecisionTicket,
  EnvHeartbeat,
  Exchange,
  ResolveTicketInput,
  RuleCandidate,
  RulesResponse,
  SyncState,
  UpdateAgentInput,
  WorkspaceProject,
} from '@zhunzou/shared';

import { ApiError, hubApi, type HubApi } from '../lib/api';
import {
  isActiveTask,
  isAwaitingTicket,
  isTerminalTicket,
} from '../lib/format';
import { pushToast } from '../lib/toast';

const TOKEN_KEY = 'zhunzou.token';
const LEGACY_TOKEN_KEY = 'agent-hub.token';
/** Held long-poll window; must stay below the nginx 75s read timeout. */
const SYNC_TIMEOUT_MS = 25_000;
/** Backoff after a network/5xx error before re-arming the long poll. */
const SYNC_RETRY_MS = 4_000;

function loadStoredToken(): string {
  try {
    const storage = globalThis.localStorage;
    return (
      storage?.getItem(TOKEN_KEY) ??
      storage?.getItem(LEGACY_TOKEN_KEY) ??
      ''
    );
  } catch {
    return '';
  }
}

function persistToken(token: string): void {
  try {
    globalThis.localStorage?.setItem(TOKEN_KEY, token);
    globalThis.localStorage?.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    // Private browsing may deny storage; the session still works in memory.
  }
}

function clearStoredToken(): void {
  try {
    globalThis.localStorage?.removeItem(TOKEN_KEY);
    globalThis.localStorage?.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    // ignore
  }
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 0 ? '无法连接服务端，请检查网络' : error.message;
  }
  return error instanceof Error ? error.message : '未知错误';
}

export function createHubStore(api: HubApi = hubApi) {
  const token = ref(loadStoredToken());
  const envs = ref<EnvHeartbeat[]>([]);
  const agents = ref<Agent[]>([]);
  const exchanges = ref<Exchange[]>([]);
  const tickets = ref<DecisionTicket[]>([]);
  const tasks = ref<AgentTask[]>([]);
  const rules = ref<RulesResponse | null>(null);
  const ruleCandidates = ref<RuleCandidate[]>([]);
  const workspaceProjects = ref<WorkspaceProject[]>([]);
  /** Server revision of the snapshot currently applied. */
  const rev = ref(0);

  const authenticating = ref(false);
  const refreshing = ref(false);
  // Only manual refreshes should animate the header button. Background polling
  // reuses `refreshing` as an in-flight guard, which would otherwise make the
  // icon spin (and blink) on every poll.
  const manualRefreshing = ref(false);
  const rulesLoading = ref(false);
  const savingRules = ref(false);
  const ruleCandidatesLoading = ref(false);
  const ruleCandidateActionId = ref('');
  const batchResolving = ref(false);
  const bindingProject = ref(false);
  const unbindingProjectId = ref('');
  const agentActionEnv = ref('');
  const agentsLoading = ref(false);
  const connection = ref<'idle' | 'online' | 'offline'>('idle');
  const lastSyncAt = ref(0);
  const lastError = ref('');
  const authError = ref('');

  let syncGeneration = 0;

  const pendingTickets = computed(() =>
    tickets.value
      .filter(isAwaitingTicket)
      .sort((left, right) => left.createdAt - right.createdAt),
  );

  const historyTickets = computed(() =>
    tickets.value
      .filter(isTerminalTicket)
      .sort((left, right) => right.updatedAt - left.updatedAt),
  );

  const activeTasks = computed(() =>
    tasks.value
      .filter(isActiveTask)
      .sort((left, right) => left.createdAt - right.createdAt),
  );

  const finishedTasks = computed(() =>
    tasks.value
      .filter((task) => !isActiveTask(task))
      .sort((left, right) => right.updatedAt - left.updatedAt),
  );

  const onlineCount = computed(
    () => envs.value.filter((env) => env.online).length,
  );

  /** Registered agents, online first and then by env name. */
  const sortedAgents = computed(() =>
    [...agents.value].sort((left, right) => {
      if (left.online !== right.online) return left.online ? -1 : 1;
      return left.env.localeCompare(right.env);
    }),
  );

  const pendingRuleCandidates = computed(() =>
    ruleCandidates.value
      .filter((candidate) => candidate.status === 'PENDING')
      .sort((left, right) => right.createdAt - left.createdAt),
  );

  /** Newest mirrored exchange for an env, or null when it never reported one. */
  function latestExchangeFor(env: string): Exchange | null {
    return (
      exchanges.value.find((exchange) => exchange.env === env) ?? null
    );
  }

  /** Projects bound to a workspace, sorted for the dispatch dropdown. */
  function projectsForEnv(env: string): WorkspaceProject[] {
    return workspaceProjects.value
      .filter((project) => project.env === env)
      .sort((left, right) =>
        left.projectName.localeCompare(right.projectName),
      );
  }

  /**
   * Every project the hub has seen (bindings, heartbeats, tickets, tasks).
   * Used as the choice list when binding a project to a workspace, so the
   * dashboard never has to ask the user to type a project name.
   */
  const knownProjects = computed(() => {
    const names = new Set<string>();
    for (const project of workspaceProjects.value) {
      names.add(project.projectName);
    }
    for (const env of envs.value) {
      if (env.projectName) names.add(env.projectName);
    }
    for (const task of tasks.value) {
      if (task.projectName) names.add(task.projectName);
    }
    for (const ticket of tickets.value) {
      if (ticket.projectName) names.add(ticket.projectName);
    }
    return [...names].sort((left, right) => left.localeCompare(right));
  });

  /**
   * Replace every slice of dashboard state with one server snapshot.
   * The snapshot is built from the same repository calls the individual
   * endpoints used, so the shapes are identical.
   */
  function applySnapshot(state: SyncState): void {
    envs.value = state.envs;
    agents.value = state.agents;
    exchanges.value = state.exchanges;
    tickets.value = state.tickets;
    tasks.value = state.tasks;
    workspaceProjects.value = state.projects;
  }

  /**
   * Force a snapshot right now (login, manual refresh, after a mutation).
   * `after=0` sidesteps the long poll: the server always answers with state.
   */
  async function refresh(options: { manual?: boolean } = {}): Promise<void> {
    if (!token.value || refreshing.value) return;

    refreshing.value = true;
    if (options.manual) manualRefreshing.value = true;
    try {
      const response = await api.sync(token.value, 0, 0);
      rev.value = response.rev;
      if (response.changed && response.state) {
        applySnapshot(response.state);
      }
      lastSyncAt.value = Date.now();
      lastError.value = '';
      connection.value = 'online';
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        logout('登录已过期，请重新输入 Token');
        return;
      }
      connection.value = 'offline';
      lastError.value = describeError(error);
    } finally {
      refreshing.value = false;
      if (options.manual) manualRefreshing.value = false;
    }
  }

  /**
   * One held request instead of six polls: the server only answers when the
   * dashboard data changed (or after the timeout, which re-arms the poll).
   */
  async function runSyncLoop(generation: number): Promise<void> {
    while (generation === syncGeneration && token.value) {
      try {
        const response = await api.sync(
          token.value,
          rev.value,
          SYNC_TIMEOUT_MS,
        );
        if (generation !== syncGeneration) return;

        rev.value = response.rev;
        if (response.changed && response.state) {
          applySnapshot(response.state);
        }
        lastSyncAt.value = Date.now();
        lastError.value = '';
        connection.value = 'online';
      } catch (error) {
        if (generation !== syncGeneration) return;
        if (error instanceof ApiError && error.status === 401) {
          logout('登录已过期，请重新输入 Token');
          return;
        }

        connection.value = 'offline';
        lastError.value = describeError(error);
        await new Promise((resolve) =>
          setTimeout(resolve, SYNC_RETRY_MS),
        );
      }
    }
  }

  async function login(candidate: string): Promise<boolean> {
    const value = candidate.trim();
    if (!value) {
      authError.value = '请输入 Token';
      return false;
    }

    authenticating.value = true;
    authError.value = '';

    try {
      const status = await api.status(value);
      token.value = value;
      persistToken(value);
      envs.value = status.envs;
      lastSyncAt.value = Date.now();
      connection.value = 'online';
      start();
      pushToast('登录成功，已开始同步', 'success');
      return true;
    } catch (error) {
      authError.value =
        error instanceof ApiError && error.status === 401
          ? 'Token 无效，请检查服务端 HUB_SECRET_TOKEN'
          : describeError(error);
      token.value = '';
      return false;
    } finally {
      authenticating.value = false;
    }
  }

  function logout(message = ''): void {
    stop();
    token.value = '';
    clearStoredToken();
    rev.value = 0;
    envs.value = [];
    agents.value = [];
    tickets.value = [];
    tasks.value = [];
    rules.value = null;
    ruleCandidates.value = [];
    workspaceProjects.value = [];
    lastSyncAt.value = 0;
    lastError.value = '';
    connection.value = 'idle';
    authError.value = message;
  }

  function start(): void {
    stop();
    if (!token.value) return;
    void runSyncLoop(syncGeneration);
  }

  function stop(): void {
    syncGeneration += 1;
  }

  function fail(error: unknown, fallback: string): void {
    if (error instanceof ApiError && error.status === 401) {
      logout('登录已过期，请重新输入 Token');
      return;
    }
    pushToast(describeError(error) || fallback, 'error');
  }

  async function resolveTicket(
    ticketId: string,
    selectedOption: string,
    customInstruction?: string,
    confirmDestructive = false,
  ): Promise<boolean> {
    const input: ResolveTicketInput = {
      selectedOption,
      ...(customInstruction ? { customInstruction } : {}),
      ...(confirmDestructive ? { confirmDestructive: true } : {}),
    };

    try {
      const response = await api.resolve(token.value, ticketId, input);
      tickets.value = tickets.value.map((ticket) =>
        ticket.id === ticketId ? response.ticket : ticket,
      );
      pushToast(`已批准 #${ticketId} · 方案 ${selectedOption}`, 'success');
      void refresh();
      return true;
    } catch (error) {
      fail(error, '审批失败');
      return false;
    }
  }

  async function batchResolveTickets(
    ticketIds: string[],
    confirmDestructive = false,
  ): Promise<boolean> {
    if (batchResolving.value || ticketIds.length === 0) return false;

    batchResolving.value = true;
    try {
      const response = await api.batchResolve(token.value, {
        ticketIds,
        ...(confirmDestructive ? { confirmDestructive: true } : {}),
      });
      const updated = new Map(
        response.tickets.map((ticket) => [ticket.id, ticket]),
      );
      tickets.value = tickets.value.map(
        (ticket) => updated.get(ticket.id) ?? ticket,
      );

      const skipped = response.skipped.length;
      if (response.tickets.length === 0) {
        pushToast(
          skipped > 0
            ? `没有可准奏的工单：${response.skipped[0]?.reason ?? '已被处理'}`
            : '没有可准奏的工单',
          'error',
        );
      } else {
        pushToast(
          `已准奏 ${response.tickets.length} 封${
            skipped > 0 ? `，跳过 ${skipped} 封` : ''
          }`,
          'success',
        );
      }
      void refresh();
      return response.tickets.length > 0;
    } catch (error) {
      fail(error, '批量审批失败');
      return false;
    } finally {
      batchResolving.value = false;
    }
  }

  async function extendTicket(
    ticketId: string,
    minutes = 10,
  ): Promise<boolean> {
    try {
      const response = await api.extendTicket(token.value, ticketId, {
        minutes,
      });
      tickets.value = tickets.value.map((ticket) =>
        ticket.id === ticketId ? response.ticket : ticket,
      );
      pushToast(`已延长 #${ticketId} 的自动裁决时限 ${minutes} 分钟`, 'success');
      return true;
    } catch (error) {
      fail(error, '延长时限失败');
      return false;
    }
  }

  async function cancelTicket(ticketId: string): Promise<boolean> {
    try {
      const response = await api.cancelTicket(token.value, ticketId);
      tickets.value = tickets.value.map((ticket) =>
        ticket.id === ticketId ? response.ticket : ticket,
      );
      pushToast(`已取消工单 #${ticketId}`, 'success');
      void refresh();
      return true;
    } catch (error) {
      fail(error, '取消工单失败');
      return false;
    }
  }

  async function createTask(input: CreateTaskInput): Promise<boolean> {
    try {
      const response = await api.createTask(token.value, input);
      tasks.value = [response.task, ...tasks.value];
      pushToast(`已下发任务 #${response.task.id}`, 'success');
      void refresh();
      return true;
    } catch (error) {
      fail(error, '任务下发失败');
      return false;
    }
  }

  async function cancelTask(taskId: string): Promise<boolean> {
    try {
      const response = await api.cancelTask(token.value, taskId);
      tasks.value = tasks.value.map((task) =>
        task.id === taskId ? response.task : task,
      );
      pushToast(`已取消任务 #${taskId}`, 'success');
      void refresh();
      return true;
    } catch (error) {
      fail(error, '取消任务失败');
      return false;
    }
  }

  async function bindProject(
    env: string,
    projectName: string,
  ): Promise<boolean> {
    if (bindingProject.value) return false;

    bindingProject.value = true;
    try {
      const response = await api.bindWorkspaceProject(token.value, {
        env,
        projectName,
      });
      workspaceProjects.value = [
        ...workspaceProjects.value.filter(
          (project) =>
            !(project.env === env && project.projectName === projectName),
        ),
        response.project,
      ];
      pushToast(`${env} 已绑定项目 ${projectName}`, 'success');
      return true;
    } catch (error) {
      fail(error, '项目绑定失败');
      return false;
    } finally {
      bindingProject.value = false;
    }
  }

  async function unbindProject(projectId: string): Promise<boolean> {
    if (unbindingProjectId.value) return false;

    unbindingProjectId.value = projectId;
    try {
      await api.unbindWorkspaceProject(token.value, projectId);
      workspaceProjects.value = workspaceProjects.value.filter(
        (project) => project.id !== projectId,
      );
      pushToast('已解除项目绑定', 'success');
      return true;
    } catch (error) {
      fail(error, '解除绑定失败');
      return false;
    } finally {
      unbindingProjectId.value = '';
    }
  }

  async function registerAgent(input: CreateAgentInput): Promise<boolean> {
    if (agentActionEnv.value) return false;

    agentActionEnv.value = input.env;
    try {
      const response = await api.createAgent(token.value, input);
      agents.value = [
        ...agents.value.filter((agent) => agent.env !== response.agent.env),
        response.agent,
      ];
      pushToast(`已登记接入端 ${response.agent.env}`, 'success');
      void refresh();
      return true;
    } catch (error) {
      fail(error, '登记接入端失败');
      return false;
    } finally {
      agentActionEnv.value = '';
    }
  }

  async function updateAgent(
    env: string,
    patch: UpdateAgentInput,
  ): Promise<boolean> {
    if (agentActionEnv.value) return false;

    agentActionEnv.value = env;
    try {
      const response = await api.updateAgent(token.value, env, patch);
      agents.value = agents.value.map((agent) =>
        agent.env === env ? response.agent : agent,
      );
      pushToast('接入端配置已更新', 'success');
      return true;
    } catch (error) {
      fail(error, '更新接入端失败');
      return false;
    } finally {
      agentActionEnv.value = '';
    }
  }

  async function deleteAgent(env: string): Promise<boolean> {
    if (agentActionEnv.value) return false;

    agentActionEnv.value = env;
    try {
      await api.deleteAgent(token.value, env);
      agents.value = agents.value.filter((agent) => agent.env !== env);
      envs.value = envs.value.filter((item) => item.env !== env);
      pushToast(`已删除接入端 ${env}`, 'success');
      return true;
    } catch (error) {
      fail(error, '删除接入端失败');
      return false;
    } finally {
      agentActionEnv.value = '';
    }
  }

  /** Returns the plaintext token once; the caller must show it immediately. */
  async function issueAgentToken(env: string): Promise<string | null> {
    if (agentActionEnv.value) return null;

    agentActionEnv.value = env;
    try {
      const response = await api.issueAgentToken(token.value, env);
      agents.value = [
        ...agents.value.filter((agent) => agent.env !== env),
        response.agent,
      ];
      pushToast('已签发新的 Agent Token（仅显示一次）', 'success');
      return response.token;
    } catch (error) {
      fail(error, '签发 Token 失败');
      return null;
    } finally {
      agentActionEnv.value = '';
    }
  }

  async function revokeAgentToken(env: string): Promise<boolean> {
    if (agentActionEnv.value) return false;

    agentActionEnv.value = env;
    try {
      const response = await api.revokeAgentToken(token.value, env);
      agents.value = agents.value.map((agent) =>
        agent.env === env ? response.agent : agent,
      );
      pushToast('已吊销 Agent Token', 'success');
      return true;
    } catch (error) {
      fail(error, '吊销 Token 失败');
      return false;
    } finally {
      agentActionEnv.value = '';
    }
  }

  async function loadAgents(): Promise<void> {
    if (!token.value || agentsLoading.value) return;

    agentsLoading.value = true;
    try {
      const response = await api.listAgents(token.value);
      agents.value = response.agents;
    } catch (error) {
      fail(error, '接入端加载失败');
    } finally {
      agentsLoading.value = false;
    }
  }

  async function loadRules(force = false): Promise<void> {
    if (!token.value) return;
    if (rules.value && !force) return;

    rulesLoading.value = true;
    try {
      rules.value = await api.getRules(token.value);
    } catch (error) {
      fail(error, '规则加载失败');
    } finally {
      rulesLoading.value = false;
    }
  }

  async function saveRules(content: string): Promise<boolean> {
    savingRules.value = true;
    try {
      rules.value = await api.saveRules(token.value, content);
      pushToast('规则已保存，Meta-Agent 立即生效', 'success');
      return true;
    } catch (error) {
      fail(error, '规则保存失败');
      return false;
    } finally {
      savingRules.value = false;
    }
  }

  async function loadRuleCandidates(): Promise<void> {
    if (!token.value || ruleCandidatesLoading.value) return;

    ruleCandidatesLoading.value = true;
    try {
      const response = await api.listRuleCandidates(token.value, undefined, 100);
      ruleCandidates.value = response.candidates;
    } catch (error) {
      fail(error, '候选规则加载失败');
    } finally {
      ruleCandidatesLoading.value = false;
    }
  }

  async function acceptRuleCandidate(candidateId: string): Promise<boolean> {
    if (ruleCandidateActionId.value) return false;

    ruleCandidateActionId.value = candidateId;
    try {
      const response = await api.acceptRuleCandidate(token.value, candidateId);
      ruleCandidates.value = ruleCandidates.value.map((candidate) =>
        candidate.id === candidateId ? response.candidate : candidate,
      );
      if (response.rules) rules.value = response.rules;
      pushToast(`规则 #${candidateId} 已并入 GLOBAL_RULES.md`, 'success');
      return true;
    } catch (error) {
      fail(error, '采纳规则失败');
      return false;
    } finally {
      ruleCandidateActionId.value = '';
    }
  }

  async function dismissRuleCandidate(candidateId: string): Promise<boolean> {
    if (ruleCandidateActionId.value) return false;

    ruleCandidateActionId.value = candidateId;
    try {
      const response = await api.dismissRuleCandidate(token.value, candidateId);
      ruleCandidates.value = ruleCandidates.value.map((candidate) =>
        candidate.id === candidateId ? response.candidate : candidate,
      );
      pushToast(`已忽略候选规则 #${candidateId}`, 'success');
      return true;
    } catch (error) {
      fail(error, '忽略规则失败');
      return false;
    } finally {
      ruleCandidateActionId.value = '';
    }
  }

  return reactive({
    token,
    envs,
    agents: sortedAgents,
    exchanges,
    rules,
    tasks,
    ruleCandidates,
    workspaceProjects,
    knownProjects,
    pendingTickets,
    historyTickets,
    activeTasks,
    finishedTasks,
    onlineCount,
    pendingRuleCandidates,
    authenticating,
    refreshing,
    manualRefreshing,
    rulesLoading,
    savingRules,
    ruleCandidatesLoading,
    ruleCandidateActionId,
    batchResolving,
    bindingProject,
    unbindingProjectId,
    agentActionEnv,
    agentsLoading,
    connection,
    rev,
    lastSyncAt,
    lastError,
    authError,
    login,
    logout,
    refresh,
    start,
    stop,
    resolveTicket,
    batchResolveTickets,
    extendTicket,
    cancelTicket,
    createTask,
    cancelTask,
    bindProject,
    unbindProject,
    registerAgent,
    updateAgent,
    deleteAgent,
    issueAgentToken,
    revokeAgentToken,
    loadAgents,
    projectsForEnv,
    latestExchangeFor,
    loadRules,
    saveRules,
    loadRuleCandidates,
    acceptRuleCandidate,
    dismissRuleCandidate,
  });
}

export type HubStore = ReturnType<typeof createHubStore>;

let store: HubStore | null = null;

export function useHubStore(): HubStore {
  store ??= createHubStore();
  return store;
}
