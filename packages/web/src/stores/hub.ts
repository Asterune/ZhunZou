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
import { t } from '../lib/i18n';

const TOKEN_KEY = 'zhunzou.token';
const LEGACY_TOKEN_KEY = 'agent-hub.token';
/** Held long-poll window; must stay below the nginx 75s read timeout. */
const SYNC_TIMEOUT_MS = 25_000;
/** Backoff after a network/5xx error before re-arming the long poll. */
const SYNC_RETRY_MS = 4_000;
/** Backoff before asking for a fresh realtime ticket and reconnecting. */
const REALTIME_RETRY_MS = 4_000;

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
    return error.status === 0 ? t('store.networkError') : error.message;
  }
  return error instanceof Error ? error.message : t('store.unknownError');
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
  const realtimeState = ref<'idle' | 'connecting' | 'online' | 'offline'>('idle');
  const lastSyncAt = ref(0);
  const lastError = ref('');
  const authError = ref('');

  let syncGeneration = 0;
  let realtimeGeneration = 0;
  let realtimeSocket: WebSocket | null = null;

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
        logout(t('store.sessionExpired'));
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
      // The realtime gateway pushes snapshots; keep the long poll as a
      // fallback only while the socket is not healthy.
      if (realtimeState.value === 'online') {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
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
          logout(t('store.sessionExpired'));
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

  /**
   * Optional realtime presence channel.
   *
   * The dashboard already has a reliable `/api/sync` long poll; this socket
   * makes device online/offline and capability changes appear immediately.
   * If the gateway is disabled or the ticket expires, the long poll keeps the
   * UI correct, so this loop is deliberately best-effort.
   */
  async function runRealtimeLoop(generation: number): Promise<void> {
    const SocketCtor = globalThis.WebSocket;
    if (!SocketCtor) {
      realtimeState.value = 'idle';
      return;
    }

    while (generation === realtimeGeneration && token.value) {
      let ticket: string;
      try {
        const response = await api.createRealtimeTicket(token.value);
        ticket = response.ticket;
      } catch (error) {
        if (generation !== realtimeGeneration) return;
        if (error instanceof ApiError && error.status === 401) {
          logout(t('store.sessionExpired'));
          return;
        }
        if (error instanceof ApiError && error.code === 'REALTIME_DISABLED') {
          realtimeState.value = 'idle';
          return;
        }
        realtimeState.value = 'offline';
        await new Promise((resolve) => setTimeout(resolve, REALTIME_RETRY_MS));
        continue;
      }

      if (generation !== realtimeGeneration || !token.value) return;

      const protocol =
        globalThis.location?.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = globalThis.location?.host ?? '127.0.0.1:8787';
      const socket = new SocketCtor(
        `${protocol}//${host}/ws/realtime?ticket=${encodeURIComponent(ticket)}`,
      );
      realtimeSocket = socket;
      realtimeState.value = 'connecting';

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };

        socket.addEventListener('open', () => {
          if (generation !== realtimeGeneration) return;
          realtimeState.value = 'online';
          socket.send(JSON.stringify({ type: 'sync.request' }));
        });
        socket.addEventListener('message', (event) => {
          try {
            const frame = JSON.parse(String(event.data)) as {
              type?: string;
              rev?: number;
              state?: SyncState;
            };
            if (frame.type === 'sync.snapshot' && frame.state) {
              applySnapshot(frame.state);
              rev.value = frame.rev ?? rev.value;
              lastSyncAt.value = Date.now();
              lastError.value = '';
              connection.value = 'online';
              return;
            }
            if (frame.type === 'sync.changed') {
              lastSyncAt.value = Date.now();
              connection.value = 'online';
              socket.send(JSON.stringify({ type: 'sync.request' }));
              return;
            }
            if (frame.type === 'device.updated' || frame.type === 'device.offline') {
              void refresh();
            }
          } catch {
            // Ignore malformed frames; the long poll is still authoritative.
          }
        });
        socket.addEventListener('close', finish);
        socket.addEventListener('error', finish);
      });

      if (realtimeSocket === socket) realtimeSocket = null;
      if (generation !== realtimeGeneration) return;
      realtimeState.value = 'offline';
      await new Promise((resolve) => setTimeout(resolve, REALTIME_RETRY_MS));
    }
  }

  async function login(candidate: string): Promise<boolean> {
    const value = candidate.trim();
    if (!value) {
      authError.value = t('store.enterToken');
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
      pushToast(t('store.loginSuccess'), 'success');
      return true;
    } catch (error) {
      authError.value =
        error instanceof ApiError && error.status === 401
          ? t('store.invalidToken')
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
    void runRealtimeLoop(realtimeGeneration);
  }

  function stop(): void {
    syncGeneration += 1;
    realtimeGeneration += 1;
    realtimeSocket?.close();
    realtimeSocket = null;
    realtimeState.value = 'idle';
  }

  function fail(error: unknown, fallback: string): void {
    if (error instanceof ApiError && error.status === 401) {
      logout(t('store.sessionExpired'));
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
      pushToast(t('store.approved', { id: ticketId, option: selectedOption }), 'success');
      void refresh();
      return true;
    } catch (error) {
      fail(error, t('store.approveFailed'));
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
            ? t('store.noApprovableWithReason', {
                reason: response.skipped[0]?.reason ?? t('store.alreadyHandled'),
              })
            : t('store.noApprovable'),
          'error',
        );
      } else {
        pushToast(
          `${t('store.batchApproved', { count: response.tickets.length })}${
            skipped > 0 ? t('store.batchSkipped', { count: skipped }) : ''
          }`,
          'success',
        );
      }
      void refresh();
      return response.tickets.length > 0;
    } catch (error) {
      fail(error, t('store.batchApproveFailed'));
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
      pushToast(t('store.extended', { id: ticketId, minutes }), 'success');
      return true;
    } catch (error) {
      fail(error, t('store.extendFailed'));
      return false;
    }
  }

  async function cancelTicket(ticketId: string): Promise<boolean> {
    try {
      const response = await api.cancelTicket(token.value, ticketId);
      tickets.value = tickets.value.map((ticket) =>
        ticket.id === ticketId ? response.ticket : ticket,
      );
      pushToast(t('store.ticketCancelled', { id: ticketId }), 'success');
      void refresh();
      return true;
    } catch (error) {
      fail(error, t('store.ticketCancelFailed'));
      return false;
    }
  }

  async function createTask(input: CreateTaskInput): Promise<boolean> {
    try {
      const response = await api.createTask(token.value, input);
      tasks.value = [response.task, ...tasks.value];
      pushToast(t('store.taskDispatched', { id: response.task.id }), 'success');
      void refresh();
      return true;
    } catch (error) {
      fail(error, t('store.taskDispatchFailed'));
      return false;
    }
  }

  async function cancelTask(taskId: string): Promise<boolean> {
    try {
      const response = await api.cancelTask(token.value, taskId);
      tasks.value = tasks.value.map((task) =>
        task.id === taskId ? response.task : task,
      );
      pushToast(t('store.taskCancelled', { id: taskId }), 'success');
      void refresh();
      return true;
    } catch (error) {
      fail(error, t('store.taskCancelFailed'));
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
      pushToast(t('store.projectBound', { env, project: projectName }), 'success');
      return true;
    } catch (error) {
      fail(error, t('store.projectBindFailed'));
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
      pushToast(t('store.projectUnbound'), 'success');
      return true;
    } catch (error) {
      fail(error, t('store.projectUnbindFailed'));
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
      pushToast(t('store.agentRegistered', { env: response.agent.env }), 'success');
      void refresh();
      return true;
    } catch (error) {
      fail(error, t('store.agentRegisterFailed'));
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
      pushToast(t('store.agentUpdated'), 'success');
      return true;
    } catch (error) {
      fail(error, t('store.agentUpdateFailed'));
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
      pushToast(t('store.agentDeleted', { env }), 'success');
      return true;
    } catch (error) {
      fail(error, t('store.agentDeleteFailed'));
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
      pushToast(t('store.tokenIssued'), 'success');
      return response.token;
    } catch (error) {
      fail(error, t('store.tokenIssueFailed'));
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
      pushToast(t('store.tokenRevoked'), 'success');
      return true;
    } catch (error) {
      fail(error, t('store.tokenRevokeFailed'));
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
      fail(error, t('store.agentsLoadFailed'));
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
      fail(error, t('store.rulesLoadFailed'));
    } finally {
      rulesLoading.value = false;
    }
  }

  async function saveRules(content: string): Promise<boolean> {
    savingRules.value = true;
    try {
      rules.value = await api.saveRules(token.value, content);
      pushToast(t('store.rulesSaved'), 'success');
      return true;
    } catch (error) {
      fail(error, t('store.rulesSaveFailed'));
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
      fail(error, t('store.candidatesLoadFailed'));
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
      pushToast(t('store.candidateAccepted', { id: candidateId }), 'success');
      return true;
    } catch (error) {
      fail(error, t('store.candidateAcceptFailed'));
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
      pushToast(t('store.candidateDismissed', { id: candidateId }), 'success');
      return true;
    } catch (error) {
      fail(error, t('store.candidateDismissFailed'));
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
    realtimeState,
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
