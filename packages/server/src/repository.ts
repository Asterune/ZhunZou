import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  like,
  lte,
  sql,
} from 'drizzle-orm';

import type {
  Agent,
  AgentKind,
  AgentMeta,
  AgentTask,
  AppendChatEventInput,
  AppendTaskLogInput,
  ChatEvent,
  ChatEventListResponse,
  ChatMessage,
  ChatMessageDecision,
  ChatMessageResponse,
  ChatMessageStatus,
  ChatSession,
  CompleteChatMessageInput,
  CompleteTaskInput,
  CreateAgentInput,
  CreateChatSessionInput,
  CreateTaskInput,
  CreateTerminalInput,
  CreateEnrollmentInput,
  CreateTicketInput,
  DecisionTicket,
  Device,
  DeviceCapabilities,
  DeviceConnectionInput,
  DeviceStats,
  DeviceTransport,
  Enrollment,
  EnvHeartbeat,
  Exchange,
  FleetCandidate,
  FleetCandidateInput,
  FleetWorkspace,
  FleetWorkspaceStatus,
  HeartbeatInput,
  ListAgentsQuery,
  ListChatEventsQuery,
  ListChatSessionsQuery,
  ListExchangesQuery,
  ListRuleCandidatesQuery,
  ListTerminalAuditQuery,
  ListTaskLogsQuery,
  ListTasksQuery,
  ListTerminalsQuery,
  ListTicketsQuery,
  ListWorkspaceProjectsQuery,
  ReportExchangeInput,
  ResolveTicketInput,
  RuleCandidate,
  SendChatMessageInput,
  TaskLog,
  TaskLogListResponse,
  TerminalAuditEntry,
  TerminalAuditKind,
  TerminalAuditListResponse,
  TerminalSession,
  TerminalSessionStatus,
  TicketStatus,
  UpdateAgentInput,
  WorkspaceProject,
} from '@zhunzou/shared';
import { HEARTBEAT_ONLINE_WINDOW_MS } from '@zhunzou/shared';

import { normalizeHost, sameMachine } from './env-allocator.js';
import type { MachineFacts } from './env-allocator.js';

import type { DrizzleDatabase } from './db/client.js';
import {
  agentTasks,
  agents,
  chatEvents,
  chatMessages,
  chatSessions,
  devices,
  enrollmentCodes,
  envHeartbeats,
  envRunners,
  exchanges,
  fleetCandidates,
  fleetWorkspaces,
  ruleCandidates,
  taskLogs,
  terminalAudit,
  terminalSessions,
  tickets,
  workspaceProjects,
  type AgentRow,
  type AgentTaskRow,
  type ChatEventRow,
  type FleetCandidateRow,
  type FleetWorkspaceRow,
  type ChatMessageRow,
  type ChatSessionRow,
  type DeviceRow,
  type EnrollmentRow,
  type ExchangeRow,
  type HeartbeatRow,
  type RuleCandidateRow,
  type TaskLogRow,
  type TerminalAuditRow,
  type TerminalSessionRow,
  type TicketRow,
  type WorkspaceProjectRow,
} from './db/schema.js';
import { BadRequestError, ConflictError } from './errors.js';

const AWAITING: TicketStatus[] = ['PENDING_META', 'PENDING_HUMAN'];

/** Chat messages that have not settled yet; drives the session-list dot. */
const CHAT_PENDING_STATUSES: ChatMessageStatus[] = [
  'PROPOSED',
  'PENDING',
  'FAILED',
];

/** Keep each task's live log bounded; older chunks are trimmed on append. */
const MAX_TASK_LOG_BYTES = 256 * 1024;
const MAX_CHAT_EVENT_BYTES = 256 * 1024;

/**
 * Marks a turn the hub gave up on because the client vanished mid-flight.
 * The bridge may still hold the real answer and replay it with `force`.
 */
export const CHAT_INTERRUPTED_PREFIX = '执行已中断';

/** Input for minting a one-time enrollment code (plaintext stays in the API). */
export interface CreateEnrollmentCodeInput {
  codeHash: string;
  codePrefix: string;
  ttlMs: number;
  env?: string;
  label?: string;
  projectName?: string;
  kind?: AgentKind;
  /** Client slots; defaults to 1 for a strict one-shot code. */
  maxUses?: number;
}

/** Enrollment code as stored; never carries the plaintext secret. */
export interface StoredEnrollment {
  id: number;
  env?: string;
  label?: string;
  projectName?: string;
  kind?: AgentKind;
  expiresAt: number;
  createdAt: number;
  maxUses: number;
  useCount: number;
  /** Machine this code is bound to after the first redemption. */
  usedHost?: string;
  /** Envs already produced by this code (same machine, several clients). */
  usedEnvs: string[];
}

function parseUsedEnvs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function toEnrollment(row: EnrollmentRow): StoredEnrollment {
  return {
    id: row.id,
    ...(row.env ? { env: row.env } : {}),
    ...(row.label ? { label: row.label } : {}),
    ...(row.projectName ? { projectName: row.projectName } : {}),
    ...(row.kind ? { kind: row.kind } : {}),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    maxUses: row.maxUses ?? 1,
    useCount: row.useCount ?? 0,
    ...(row.usedHost ? { usedHost: row.usedHost } : {}),
    usedEnvs: parseUsedEnvs(row.usedEnvs ?? null),
  };
}
/** Per-env history cap for mirrored IDE exchanges. */
const MAX_EXCHANGES_PER_ENV = 200;

/**
 * Older bridge builds hard-coded this label before task reporting existed.
 * Normalize it so the dashboard never claims the agent is idle while the user
 * is actually working in the IDE.
 */
const LEGACY_IDLE_TASK = 'MCP 已连接，等待任务';
const LEGACY_IDLE_TASK_LABEL = 'MCP 已连接';

function toTicket(row: TicketRow): DecisionTicket {
  return {
    id: String(row.id),
    env: row.env,
    projectName: row.projectName,
    status: row.status,
    doneSummary: row.doneSummary,
    blockerQuestion: row.blockerQuestion,
    nextStepPlan: row.nextStepPlan,
    options: row.options,
    recommendedOption: row.recommendedOption,
    ...(row.selectedOption ? { selectedOption: row.selectedOption } : {}),
    ...(row.customInstruction ? { customInstruction: row.customInstruction } : {}),
    ...(row.resolvedBy ? { resolvedBy: row.resolvedBy } : {}),
    ...(row.resolutionReason ? { resolutionReason: row.resolutionReason } : {}),
    ...(row.expiresAt !== null ? { expiresAt: row.expiresAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toHeartbeat(row: HeartbeatRow, now: number): EnvHeartbeat {
  return {
    env: row.env,
    status: row.status,
    ...(row.projectName ? { projectName: row.projectName } : {}),
    ...(row.currentTask ? { currentTask: row.currentTask } : {}),
    ...(row.note ? { note: row.note } : {}),
    lastSeenAt: row.lastSeenAt,
    online: now - row.lastSeenAt <= HEARTBEAT_ONLINE_WINDOW_MS,
  };
}

function toDevice(row: DeviceRow, envs: string[], now: number): Device {
  return {
    id: row.id,
    ...(row.host ? { host: row.host } : {}),
    ...(row.os ? { os: row.os } : {}),
    ...(row.capabilities ? { capabilities: row.capabilities } : {}),
    ...(row.deviceStats ? { deviceStats: row.deviceStats } : {}),
    ...(row.transport ? { transport: row.transport } : {}),
    online:
      row.lastSeenAt !== null &&
      now - row.lastSeenAt <= HEARTBEAT_ONLINE_WINDOW_MS,
    ...(row.lastSeenAt !== null ? { lastSeenAt: row.lastSeenAt } : {}),
    envs,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAgent(
  row: AgentRow,
  heartbeat: HeartbeatRow | undefined,
  now: number,
): Agent {
  const heartbeatSeenAt = heartbeat?.lastSeenAt;
  const lastSeenAt =
    Math.max(row.lastSeenAt ?? 0, heartbeatSeenAt ?? 0) || undefined;
  const wsConnected =
    row.transport === 'ws' ? row.connectedAt !== null : undefined;

  return {
    env: row.env,
    name: row.name,
    kind: row.kind,
    status: row.status,
    ...(row.version ? { version: row.version } : {}),
    ...(row.host ? { host: row.host } : {}),
    ...(row.os ? { os: row.os } : {}),
    ...(row.deviceId ? { deviceId: row.deviceId } : {}),
    ...(row.protocolVersion ? { protocolVersion: row.protocolVersion } : {}),
    ...(row.capabilities ? { capabilities: row.capabilities } : {}),
    ...(row.deviceStats ? { deviceStats: row.deviceStats } : {}),
    ...(row.transport ? { transport: row.transport } : {}),
    ...(wsConnected !== undefined ? { connected: wsConnected } : {}),
    terminalEnabled: row.terminalEnabled !== 0,
    ...(row.connectedAt ? { connectedAt: row.connectedAt } : {}),
    ...(row.tokenPrefix ? { tokenPrefix: row.tokenPrefix } : {}),
    hasToken: Boolean(row.tokenHash),
    online:
      row.status === 'active' &&
      wsConnected !== false &&
      lastSeenAt !== undefined &&
      now - lastSeenAt <= HEARTBEAT_ONLINE_WINDOW_MS,
    ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
    ...(heartbeat?.projectName ? { projectName: heartbeat.projectName } : {}),
    ...(heartbeat?.currentTask ? { currentTask: heartbeat.currentTask } : {}),
    ...(heartbeat?.note ? { note: heartbeat.note } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toTask(row: AgentTaskRow): AgentTask {
  return {
    id: String(row.id),
    env: row.env,
    ...(row.projectName ? { projectName: row.projectName } : {}),
    title: row.title,
    instruction: row.instruction,
    status: row.status,
    attempts: row.attempts ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.claimedAt !== null ? { claimedAt: row.claimedAt } : {}),
    ...(row.leaseAt !== null ? { leaseAt: row.leaseAt } : {}),
    ...(row.completedAt !== null ? { completedAt: row.completedAt } : {}),
    ...(row.result ? { result: row.result } : {}),
  };
}

function toTaskLog(row: TaskLogRow): TaskLog {
  return {
    id: row.id,
    taskId: String(row.taskId),
    stream: row.stream,
    chunk: row.chunk,
    createdAt: row.createdAt,
  };
}

function toChatSession(
  row: ChatSessionRow,
  messageCount?: number,
  pendingCount?: number,
): ChatSession {
  return {
    id: String(row.id),
    env: row.env,
    ...(row.projectName ? { projectName: row.projectName } : {}),
    title: row.title,
    status: row.status,
    ...(row.externalId ? { externalId: row.externalId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.lastMessageAt !== null ? { lastMessageAt: row.lastMessageAt } : {}),
    ...(messageCount !== undefined ? { messageCount } : {}),
    ...(pendingCount !== undefined ? { pendingCount } : {}),
  };
}

function toChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    role: row.role,
    content: row.content,
    status: row.status,
    origin: row.origin,
    ...(row.rationale ? { rationale: row.rationale } : {}),
    ...(row.decision ? { decision: row.decision } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toChatEvent(row: ChatEventRow): ChatEvent {
  return {
    id: row.id,
    sessionId: String(row.sessionId),
    messageId: String(row.messageId),
    stream: row.stream,
    chunk: row.chunk,
    createdAt: row.createdAt,
  };
}

function toTerminalSession(row: TerminalSessionRow): TerminalSession {
  return {
    id: String(row.id),
    env: row.env,
    ...(row.projectName ? { projectName: row.projectName } : {}),
    title: row.title,
    ...(row.shell ? { shell: row.shell } : {}),
    ...(row.cwd ? { cwd: row.cwd } : {}),
    cols: row.cols,
    rows: row.rows,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActiveAt: row.lastActiveAt,
    ...(row.closedAt !== null ? { closedAt: row.closedAt } : {}),
    ...(row.exitCode !== null ? { exitCode: row.exitCode } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

function toTerminalAudit(row: TerminalAuditRow): TerminalAuditEntry {
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    env: row.env,
    kind: row.kind,
    ...(row.viewerId ? { viewerId: row.viewerId } : {}),
    ...(row.data ? { data: row.data } : {}),
    createdAt: row.createdAt,
  };
}

function toRuleCandidate(row: RuleCandidateRow): RuleCandidate {
  return {
    id: String(row.id),
    ticketId: String(row.ticketId),
    content: row.content,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toExchange(row: ExchangeRow): Exchange {
  return {
    id: String(row.id),
    env: row.env,
    ...(row.projectName ? { projectName: row.projectName } : {}),
    ...(row.question ? { question: row.question } : {}),
    ...(row.conclusion ? { conclusion: row.conclusion } : {}),
    createdAt: row.createdAt,
  };
}

function toWorkspaceProject(row: WorkspaceProjectRow): WorkspaceProject {
  return {
    id: String(row.id),
    env: row.env,
    projectName: row.projectName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toFleetCandidate(row: FleetCandidateRow): FleetCandidate {
  return {
    id: String(row.id),
    host: row.host,
    path: row.path,
    projectName: row.projectName,
    env: row.env,
    ...(row.adapter ? { adapter: row.adapter } : {}),
    associated: row.associated,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toFleetWorkspace(row: FleetWorkspaceRow): FleetWorkspace {
  return {
    id: String(row.id),
    host: row.host,
    env: row.env,
    path: row.path,
    projectName: row.projectName,
    ...(row.adapter ? { adapter: row.adapter } : {}),
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeSimilarityText(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function charBigrams(text: string): Set<string> {
  const chars = Array.from(normalizeSimilarityText(text));
  const grams = new Set<string>();
  if (chars.length === 0) return grams;
  if (chars.length === 1) {
    grams.add(chars[0]!);
    return grams;
  }
  for (let index = 0; index < chars.length - 1; index += 1) {
    grams.add(`${chars[index]}${chars[index + 1]}`);
  }
  return grams;
}

/**
 * Cheap, dependency-free similarity for short Chinese/English questions.
 * Character bigrams + containment work surprisingly well for reformulations
 * ("Toast 还是行内" vs "错误提示用 Toast 还是行内文案？").
 */
export function textSimilarity(left: string, right: string): number {
  const a = charBigrams(left);
  const b = charBigrams(right);
  if (a.size === 0 || b.size === 0) return 0;

  let overlap = 0;
  for (const gram of a) {
    if (b.has(gram)) overlap += 1;
  }
  return overlap / Math.min(a.size, b.size);
}

export function parseTicketId(raw: string): number {
  const id = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== raw) {
    throw new BadRequestError(`invalid ticket id: ${raw}`, 'INVALID_ID');
  }
  return id;
}

/** A contact whose reported machine facts belong to a different machine. */
export interface IdentityConflict {
  env: string;
  owner: MachineFacts;
  claimed: MachineFacts;
}

export interface RepositoryHooks {
  onIdentityConflict?: (conflict: IdentityConflict) => void;
}

export interface TicketStore {
  create(
    input: CreateTicketInput,
    now?: number,
    expiresAt?: number,
  ): DecisionTicket;
  get(id: number): DecisionTicket | null;
  list(query: ListTicketsQuery): { tickets: DecisionTicket[]; total: number };
  /**
   * Cheap value that changes whenever anything the dashboard renders changes.
   * Used by GET /api/sync to decide whether a long-poll should wake.
   */
  syncFingerprint(): string;
  resolve(id: number, input: ResolveTicketInput, now?: number): DecisionTicket;
  markAutoResolved(
    id: number,
    selectedOption: string,
    reason: string,
    now?: number,
  ): DecisionTicket | null;
  markPendingHuman(id: number, reason: string, now?: number): DecisionTicket | null;
  cancel(id: number, now?: number): DecisionTicket | null;
  /** Pending tickets whose SLA deadline has passed. */
  findDueTickets(now?: number, limit?: number): DecisionTicket[];
  /** Atomically apply the timeout default. Never touches resolved tickets. */
  markTimedOut(
    id: number,
    selectedOption: string,
    reason: string,
    now?: number,
  ): DecisionTicket | null;
  /** Drop the SLA so a high-risk ticket is never auto-approved. */
  clearExpiry(id: number, now?: number): void;
  /** Push the SLA deadline out by N minutes; only pending tickets. */
  extend(id: number, minutes: number, now?: number): DecisionTicket | null;
  recordHeartbeat(input: HeartbeatInput, now?: number): EnvHeartbeat;
  listHeartbeats(now?: number): EnvHeartbeat[];

  /* Agent registry */
  registerAgent(input: CreateAgentInput, now?: number): Agent;
  getAgent(env: string, now?: number): Agent | null;
  listAgents(query?: ListAgentsQuery, now?: number): Agent[];
  /** Machine facts recorded for an env, or null when the agent is unknown. */
  getAgentMachine(
    env: string,
  ): (MachineFacts & { deviceId?: string | null }) | null;
  /** Machines the hub has seen, each with the agent identities it runs. */
  listDevices(now?: number): Device[];
  updateAgent(env: string, input: UpdateAgentInput, now?: number): Agent | null;
  /**
   * Remove the agent and its live presence state. Returns true when anything
   * was deleted, so callers can clear a leftover heartbeat whose agent row is
   * already gone.
   */
  deleteAgent(env: string): boolean;
  setAgentToken(
    env: string,
    tokenHash: string,
    tokenPrefix: string,
    now?: number,
  ): Agent | null;
  clearAgentToken(env: string, now?: number): Agent | null;
  findAgentByTokenHash(tokenHash: string): Agent | null;

  /* One-time enrollment codes */
  createEnrollmentCode(
    input: CreateEnrollmentCodeInput,
    now?: number,
  ): StoredEnrollment;
  findEnrollmentByHash(codeHash: string): StoredEnrollment | null;
  /**
   * Claim one redemption slot. Multiple clients on the same machine may share
   * a single code, so callers must check `useCount` / `maxUses` and host
   * binding before spending a slot. False when no slot is left.
   */
  consumeEnrollmentCode(
    id: number,
    usedEnv: string,
    usedHost: string | undefined,
    now?: number,
  ): boolean;
  /** Persist the hello frame from a device daemon and mark it connected. */
  recordDeviceConnection(input: DeviceConnectionInput, now?: number): Agent;
  /** Persist a heartbeat snapshot without changing capabilities. */
  recordDeviceHeartbeat(
    env: string,
    stats: DeviceStats | undefined,
    now?: number,
  ): Agent | null;
  /** Mark the WS peer as gone without deleting its capability inventory. */
  markDeviceDisconnected(env: string, now?: number): Agent | null;
  recordAgentPresence(
    env: string,
    meta: AgentMeta | undefined,
    now?: number,
  ): void;
  /** Refresh the lease of every CLAIMED task owned by this env. */
  renewTaskLease(env: string, now?: number): number;

  createTask(input: CreateTaskInput, now?: number): AgentTask;
  getTask(id: number): AgentTask | null;
  listTasks(query: ListTasksQuery): { tasks: AgentTask[]; total: number };
  claimNextTask(env: string, now?: number): AgentTask | null;
  completeTask(id: number, input: CompleteTaskInput, now?: number): AgentTask;
  cancelTask(id: number, now?: number): AgentTask | null;
  /** CLAIMED tasks, oldest claim first (used by the stale-task sweeper). */
  listClaimedTasks(limit?: number): AgentTask[];
  /** Requeue a lost task, or fail it after too many attempts. */
  releaseTask(
    id: number,
    requeue: boolean,
    reason: string,
    now?: number,
  ): AgentTask | null;
  /** Pending/CLAIMED tasks for an env, for bridge restart recovery. */
  listActiveTasks(env: string, limit?: number): AgentTask[];
  appendTaskLog(
    taskId: number,
    input: AppendTaskLogInput,
    now?: number,
  ): TaskLog;
  listTaskLogs(taskId: number, query: ListTaskLogsQuery): TaskLogListResponse;

  /* Interactive sessions */
  createChatSession(input: CreateChatSessionInput, now?: number): ChatSession;
  listChatSessions(query: ListChatSessionsQuery, now?: number): ChatSession[];
  getChatSession(id: number, now?: number): ChatSession | null;
  getChatMessage(id: number): ChatMessage | null;
  listChatMessages(sessionId: number, limit?: number): ChatMessage[];
  sendChatMessage(
    sessionId: number,
    input: SendChatMessageInput,
    now?: number,
  ): ChatMessage;
  findLatestActiveChatSession(env: string): ChatSession | null;
  createChatProposal(
    sessionId: number,
    input: { content: string; rationale?: string },
    now?: number,
  ): ChatMessage;
  queueChatReply(
    sessionId: number,
    input: {
      content: string;
      rationale?: string;
      decision?: ChatMessageDecision;
    },
    now?: number,
  ): ChatMessage;
  adoptChatProposal(
    sessionId: number,
    messageId: number,
    input: { content?: string },
    now?: number,
  ): ChatMessage | null;
  discardChatProposal(
    sessionId: number,
    messageId: number,
    now?: number,
  ): ChatMessage | null;
  claimNextChatMessage(
    env: string,
    now?: number,
  ): { session: ChatSession; message: ChatMessage } | null;
  completeChatMessage(
    sessionId: number,
    messageId: number,
    input: CompleteChatMessageInput,
    now?: number,
    force?: boolean,
  ): ChatMessageResponse;
  appendChatEvent(
    sessionId: number,
    messageId: number,
    input: AppendChatEventInput,
    now?: number,
  ): ChatEvent;
  listChatEvents(
    sessionId: number,
    query: ListChatEventsQuery,
  ): ChatEventListResponse;
  closeChatSession(sessionId: number, now?: number): ChatSession | null;
  deleteChatSession(sessionId: number): boolean;
  failStaleChatMessages(
    onlineEnvs: Set<string>,
    cutoff: number,
    now?: number,
  ): number;
  /**
   * Remember the chat runner instance serving an env and return the previous
   * one. A different id means the old runner died, so its RUNNING messages are
   * safe to fail and retry.
   */
  claimRunner(env: string, runnerId: string, now?: number): string | null;
  failRunningChatMessages(
    env: string,
    now?: number,
    error?: string,
  ): number;
  retryChatMessage(
    sessionId: number,
    messageId: number,
    now?: number,
  ): ChatMessage | null;

  /* Terminal sessions */
  createTerminalSession(
    input: CreateTerminalInput & { title: string },
    now?: number,
  ): TerminalSession;
  getTerminalSession(id: number, now?: number): TerminalSession | null;
  listTerminalSessions(
    query: ListTerminalsQuery,
    now?: number,
  ): { sessions: TerminalSession[]; total: number };
  listActiveTerminalSessions(
    env?: string,
    now?: number,
  ): TerminalSession[];
  countActiveTerminalSessions(env?: string): number;
  updateTerminalSession(
    id: number,
    patch: {
      status?: TerminalSessionStatus;
      lastActiveAt?: number;
      closedAt?: number | null;
      exitCode?: number | null;
      error?: string | null;
    },
    now?: number,
  ): TerminalSession | null;
  appendTerminalAudit(
    input: {
      sessionId: number;
      env: string;
      kind: TerminalAuditKind;
      viewerId?: string;
      data?: string;
    },
    now?: number,
  ): TerminalAuditEntry;
  listTerminalAudit(
    sessionId: number,
    query: ListTerminalAuditQuery,
  ): TerminalAuditListResponse;

  /** Record the question/conclusion summary of one IDE conversation turn. */
  createExchange(
    env: string,
    input: Omit<ReportExchangeInput, 'env'>,
    now?: number,
  ): Exchange;
  listExchanges(query: ListExchangesQuery): Exchange[];
  /** Awaiting tickets plus recently terminal ones, for bridge restart recovery. */
  listResumeTickets(env: string, since: number, limit?: number): DecisionTicket[];

  /** Bind a project to a workspace/env (idempotent). */
  bindWorkspaceProject(
    env: string,
    projectName: string,
    now?: number,
  ): WorkspaceProject;
  listWorkspaceProjects(query?: ListWorkspaceProjectsQuery): {
    projects: WorkspaceProject[];
    total: number;
  };
  getWorkspaceProject(id: number): WorkspaceProject | null;
  unbindWorkspaceProject(id: number): WorkspaceProject | null;

  /* Fleet directory association */
  /** Replace one host's candidate list with the latest bridge scan. */
  replaceFleetCandidates(
    host: string,
    candidates: FleetCandidateInput[],
    now?: number,
  ): FleetCandidate[];
  listFleetCandidates(host?: string): {
    candidates: FleetCandidate[];
    total: number;
  };
  getFleetCandidate(id: number): FleetCandidate | null;
  createFleetWorkspace(input: {
    host: string;
    env: string;
    path: string;
    projectName: string;
    adapter?: string;
  }, now?: number): FleetWorkspace;
  listFleetWorkspaces(host?: string): {
    workspaces: FleetWorkspace[];
    total: number;
  };
  getFleetWorkspace(id: number): FleetWorkspace | null;
  getFleetWorkspaceByEnv(env: string): FleetWorkspace | null;
  getFleetWorkspaceByHostPath(host: string, path: string): FleetWorkspace | null;
  /** Plaintext token is only kept until the bridge reports APPLIED. */
  getFleetWorkspaceToken(id: number): string | null;
  updateFleetWorkspace(
    id: number,
    input: {
      status?: FleetWorkspaceStatus;
      error?: string | null;
      token?: string | null;
    },
    now?: number,
  ): FleetWorkspace | null;
  deleteFleetWorkspace(id: number): FleetWorkspace | null;

  /** Recent resolved tickets in the same project, ranked by text similarity. */
  findSimilarTickets(input: {
    projectName: string;
    blockerQuestion: string;
    excludeId?: number;
    limit?: number;
  }): DecisionTicket[];

  createRuleCandidate(
    ticketId: number,
    content: string,
    now?: number,
  ): RuleCandidate | null;
  getRuleCandidate(id: number): RuleCandidate | null;
  listRuleCandidates(query: ListRuleCandidatesQuery): {
    candidates: RuleCandidate[];
    total: number;
  };
  markRuleCandidate(
    id: number,
    status: 'ACCEPTED' | 'DISMISSED',
    now?: number,
  ): RuleCandidate | null;
}

export class TicketRepository implements TicketStore {
  constructor(
    private readonly db: DrizzleDatabase,
    private readonly hooks: RepositoryHooks = {},
  ) {}

  /**
   * A client cannot be allowed to rewrite another machine's inventory, but a
   * silent refusal leaves the operator with a stale card and no explanation.
   */
  private reportConflict(
    owner: MachineFacts | null,
    claimed: MachineFacts,
    env: string,
  ): void {
    if (!owner || sameMachine(owner, claimed)) return;
    this.hooks.onIdentityConflict?.({ env, owner, claimed });
  }

  create(
    input: CreateTicketInput,
    now = Date.now(),
    expiresAt?: number,
  ): DecisionTicket {
    const row = this.db
      .insert(tickets)
      .values({
        env: input.env,
        projectName: input.projectName,
        status: 'PENDING_META',
        doneSummary: input.doneSummary,
        blockerQuestion: input.blockerQuestion,
        nextStepPlan: input.nextStepPlan,
        options: input.options,
        recommendedOption: input.recommendedOption,
        expiresAt: expiresAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    // Every ticket implies the workspace works on this project; keep the
    // dispatch dropdown in sync without asking the human to bind it twice.
    this.bindWorkspaceProject(input.env, input.projectName, now);

    return toTicket(row);
  }

  get(id: number): DecisionTicket | null {
    const row = this.db.select().from(tickets).where(eq(tickets.id, id)).get();
    return row ? toTicket(row) : null;
  }

  list(query: ListTicketsQuery): { tickets: DecisionTicket[]; total: number } {
    const filters = [
      ...(query.status ? [eq(tickets.status, query.status)] : []),
      ...(query.projectName ? [eq(tickets.projectName, query.projectName)] : []),
      ...(query.env ? [eq(tickets.env, query.env)] : []),
    ];
    const where = filters.length > 0 ? and(...filters) : undefined;

    const rows = this.db
      .select()
      .from(tickets)
      .where(where)
      .orderBy(desc(tickets.createdAt), desc(tickets.id))
      .limit(query.limit)
      .all();

    const countRow = this.db
      .select({ value: count() })
      .from(tickets)
      .where(where)
      .get();

    return {
      tickets: rows.map(toTicket),
      total: countRow?.value ?? 0,
    };
  }

  /**
   * Apply a human decision. Fails if the ticket was already resolved or
   * cancelled (prevents double-approval from two browser tabs).
   */
  resolve(id: number, input: ResolveTicketInput, now = Date.now()): DecisionTicket {
    const current = this.get(id);
    if (!current) {
      throw new ConflictError(`ticket #${id} not found`, 'NOT_FOUND');
    }
    if (!AWAITING.includes(current.status)) {
      throw new ConflictError(
        `ticket #${id} is already ${current.status}`,
        'ALREADY_FINALIZED',
      );
    }
    const selected = current.options.find(
      (option) => option.key === input.selectedOption,
    );
    if (!selected) {
      throw new ConflictError(
        `option "${input.selectedOption}" does not exist on ticket #${id}`,
        'INVALID_OPTION',
      );
    }
    if (selected.risk === 'destructive' && input.confirmDestructive !== true) {
      throw new ConflictError(
        `option "${input.selectedOption}" is destructive and requires confirmation`,
        'DESTRUCTIVE_OPTION_REQUIRES_CONFIRMATION',
      );
    }

    const row = this.db
      .update(tickets)
      .set({
        status: 'HUMAN_RESOLVED',
        selectedOption: input.selectedOption,
        customInstruction: input.customInstruction ?? null,
        resolvedBy: 'HUMAN',
        resolutionReason: null,
        updatedAt: now,
      })
      .where(and(eq(tickets.id, id), inArray(tickets.status, AWAITING)))
      .returning()
      .get();

    if (!row) {
      throw new ConflictError(`ticket #${id} changed while resolving`, 'RACE_LOST');
    }

    return toTicket(row);
  }

  /** Only a still-pending ticket can be auto-resolved by the Meta-Agent. */
  markAutoResolved(
    id: number,
    selectedOption: string,
    reason: string,
    now = Date.now(),
  ): DecisionTicket | null {
    const row = this.db
      .update(tickets)
      .set({
        status: 'AUTO_RESOLVED',
        selectedOption,
        resolvedBy: 'META_AGENT',
        resolutionReason: reason,
        updatedAt: now,
      })
      .where(and(eq(tickets.id, id), inArray(tickets.status, AWAITING)))
      .returning()
      .get();

    return row ? toTicket(row) : null;
  }

  markPendingHuman(id: number, reason: string, now = Date.now()): DecisionTicket | null {
    const row = this.db
      .update(tickets)
      .set({
        status: 'PENDING_HUMAN',
        resolutionReason: reason,
        updatedAt: now,
      })
      .where(and(eq(tickets.id, id), eq(tickets.status, 'PENDING_META')))
      .returning()
      .get();

    return row ? toTicket(row) : null;
  }

  cancel(id: number, now = Date.now()): DecisionTicket | null {
    const row = this.db
      .update(tickets)
      .set({ status: 'CANCELLED', updatedAt: now })
      .where(and(eq(tickets.id, id), inArray(tickets.status, AWAITING)))
      .returning()
      .get();

    return row ? toTicket(row) : null;
  }

  findDueTickets(now = Date.now(), limit = 50): DecisionTicket[] {
    return this.db
      .select()
      .from(tickets)
      .where(
        and(
          inArray(tickets.status, AWAITING),
          isNotNull(tickets.expiresAt),
          lte(tickets.expiresAt, now),
        ),
      )
      .orderBy(asc(tickets.expiresAt), asc(tickets.id))
      .limit(limit)
      .all()
      .map(toTicket);
  }

  markTimedOut(
    id: number,
    selectedOption: string,
    reason: string,
    now = Date.now(),
  ): DecisionTicket | null {
    const row = this.db
      .update(tickets)
      .set({
        status: 'AUTO_RESOLVED',
        selectedOption,
        resolvedBy: 'TIMEOUT',
        resolutionReason: reason,
        updatedAt: now,
      })
      .where(
        and(
          eq(tickets.id, id),
          inArray(tickets.status, AWAITING),
          isNotNull(tickets.expiresAt),
          lte(tickets.expiresAt, now),
        ),
      )
      .returning()
      .get();

    return row ? toTicket(row) : null;
  }

  clearExpiry(id: number, now = Date.now()): void {
    this.db
      .update(tickets)
      .set({ expiresAt: null, updatedAt: now })
      .where(and(eq(tickets.id, id), inArray(tickets.status, AWAITING)))
      .run();
  }

  extend(id: number, minutes: number, now = Date.now()): DecisionTicket | null {
    const row = this.db
      .update(tickets)
      .set({ expiresAt: now + minutes * 60_000, updatedAt: now })
      .where(and(eq(tickets.id, id), inArray(tickets.status, AWAITING)))
      .returning()
      .get();

    return row ? toTicket(row) : null;
  }

  recordHeartbeat(input: HeartbeatInput, now = Date.now()): EnvHeartbeat {
    const currentTask =
      input.currentTask === LEGACY_IDLE_TASK
        ? LEGACY_IDLE_TASK_LABEL
        : (input.currentTask ?? null);

    const row = this.db
      .insert(envHeartbeats)
      .values({
        env: input.env,
        status: input.status,
        projectName: input.projectName ?? null,
        currentTask,
        note: input.note ?? null,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: envHeartbeats.env,
        set: {
          status: input.status,
          projectName: input.projectName ?? null,
          currentTask,
          note: input.note ?? null,
          lastSeenAt: now,
        },
      })
      .returning()
      .get();

    if (input.projectName) {
      this.bindWorkspaceProject(input.env, input.projectName, now);
    }

    // An active agent proves the task is still being worked on, so refresh
    // the lease. Idle agents do not, which keeps stale-task recovery honest.
    if (input.status !== 'Idle') {
      this.renewTaskLease(input.env, now);
    }
    this.recordAgentPresence(input.env, input.agent, now);

    return toHeartbeat(row, now);
  }

  listHeartbeats(now = Date.now()): EnvHeartbeat[] {
    return this.db
      .select()
      .from(envHeartbeats)
      .orderBy(envHeartbeats.env)
      .all()
      .map((row) => toHeartbeat(row, now));
  }

  /* ---------------------------------------------------------------- */
  /* Agent registry                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Machine facts the hub holds for an env, including the device row.
   *
   * Callers compare these against a newcomer's report before letting it rewrite
   * anything: `env` is the primary key, so an unguarded write would move one
   * machine's identity onto another box.
   */
  getAgentMachine(env: string): (MachineFacts & { deviceId?: string | null }) | null {
    const row = this.db
      .select({
        host: agents.host,
        machineId: devices.machineId,
        deviceId: agents.deviceId,
      })
      .from(agents)
      .leftJoin(devices, eq(devices.id, agents.deviceId))
      .where(eq(agents.env, env))
      .get();
    return row ?? null;
  }

  /**
   * Find or create the card for the machine an agent reported.
   *
   * A client-generated fingerprint is the key, so one box keeps its card across
   * a hostname rename and imaged clones never merge. Without a fingerprint the
   * hostname is all there is, and `host:<hostname>` is the same id the migration
   * backfills, so upgrading a hub does not split a machine in two.
   */
  private upsertDevice(
    facts: MachineFacts,
    machine: {
      os?: string | null;
      capabilities?: DeviceCapabilities | null;
      deviceStats?: DeviceStats | null;
      transport?: DeviceTransport | null;
    },
    now: number,
  ): string | null {
    const host = normalizeHost(facts.host);
    const fingerprint = facts.machineId?.trim() ?? '';
    if (!fingerprint && !host) return null;

    // A fingerprint is the strongest handle a client can offer, so it is the
    // key. Without one the hostname is only an alias for whatever card already
    // exists — an older client must not move its agent onto a worse id.
    const id = fingerprint || this.deviceIdForHost(host) || `host:${host}`;
    const reported = {
      ...(facts.host ? { host: facts.host.trim() } : {}),
      ...(machine.os ? { os: machine.os } : {}),
      ...(machine.capabilities ? { capabilities: machine.capabilities } : {}),
      ...(machine.deviceStats ? { deviceStats: machine.deviceStats } : {}),
      ...(machine.transport ? { transport: machine.transport } : {}),
    };

    this.db
      .insert(devices)
      .values({
        id,
        ...(fingerprint ? { machineId: fingerprint } : {}),
        ...reported,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: devices.id,
        set: {
          ...reported,
          ...(fingerprint ? { machineId: fingerprint } : {}),
          lastSeenAt: now,
          updatedAt: now,
        },
      })
      .run();

    // The hostname-derived card was a stand-in for this very machine; once it
    // has proven its fingerprint, leaving it behind would show two cards.
    if (fingerprint && host) this.releaseDeviceAlias(host);
    return id;
  }

  /** The card already filed under this hostname, whichever key it uses. */
  private deviceIdForHost(host: string): string | null {
    if (!host) return null;
    return (
      this.db
        .select({ id: devices.id })
        .from(devices)
        .where(sql`lower(trim(${devices.host})) = ${host}`)
        .get()?.id ?? null
    );
  }

  private releaseDeviceAlias(host: string): void {
    this.dropDeviceIfIdle(`host:${host}`);
  }

  /** Forget a card once nothing runs on it; the next report brings it back. */
  private dropDeviceIfIdle(id: string): void {
    const stillUsed = this.db
      .select({ env: agents.env })
      .from(agents)
      .where(eq(agents.deviceId, id))
      .get();
    if (stillUsed) return;

    this.db.delete(devices).where(eq(devices.id, id)).run();
  }

  registerAgent(input: CreateAgentInput, now = Date.now()): Agent {
    const deviceId = this.upsertDevice(
      { host: input.host, machineId: input.machineId },
      { os: input.os },
      now,
    );
    const machine = {
      ...(input.host ? { host: input.host } : {}),
      ...(input.os ? { os: input.os } : {}),
      ...(deviceId ? { deviceId } : {}),
    };

    const row = this.db
      .insert(agents)
      .values({
        env: input.env,
        name: input.name ?? input.env,
        kind: input.kind ?? 'other',
        status: 'active',
        ...machine,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agents.env,
        set: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ...machine,
          updatedAt: now,
        },
      })
      .returning()
      .get();

    return toAgent(row, undefined, now);
  }

  getAgent(env: string, now = Date.now()): Agent | null {
    const row = this.db.select().from(agents).where(eq(agents.env, env)).get();
    if (!row) return null;
    const heartbeat = this.db
      .select()
      .from(envHeartbeats)
      .where(eq(envHeartbeats.env, env))
      .get();
    return toAgent(row, heartbeat, now);
  }

  listAgents(query: ListAgentsQuery = {}, now = Date.now()): Agent[] {
    const rows = this.db
      .select()
      .from(agents)
      .where(query.status ? eq(agents.status, query.status) : undefined)
      .orderBy(asc(agents.env))
      .all();

    const heartbeats = new Map(
      this.db
        .select()
        .from(envHeartbeats)
        .all()
        .map((row) => [row.env, row]),
    );

    return rows.map((row) => toAgent(row, heartbeats.get(row.env), now));
  }

  listDevices(now = Date.now()): Device[] {
    const rows = this.db
      .select()
      .from(devices)
      .orderBy(desc(devices.lastSeenAt), asc(devices.id))
      .all();

    const envsByDevice = new Map<string, string[]>();
    for (const link of this.db
      .select({ deviceId: agents.deviceId, env: agents.env })
      .from(agents)
      .where(isNotNull(agents.deviceId))
      .orderBy(asc(agents.env))
      .all()) {
      if (!link.deviceId) continue;
      const list = envsByDevice.get(link.deviceId);
      if (list) list.push(link.env);
      else envsByDevice.set(link.deviceId, [link.env]);
    }

    return rows.map((row) => toDevice(row, envsByDevice.get(row.id) ?? [], now));
  }

  updateAgent(
    env: string,
    input: UpdateAgentInput,
    now = Date.now(),
  ): Agent | null {
    const row = this.db
      .update(agents)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.terminalEnabled !== undefined
          ? { terminalEnabled: input.terminalEnabled ? 1 : 0 }
          : {}),
        updatedAt: now,
      })
      .where(eq(agents.env, env))
      .returning()
      .get();

    return row ? this.getAgent(env, now) : null;
  }

  deleteAgent(env: string): boolean {
    const deviceId = this.db
      .select({ deviceId: agents.deviceId })
      .from(agents)
      .where(eq(agents.env, env))
      .get()?.deviceId;
    const agent = this.db.delete(agents).where(eq(agents.env, env)).run();
    // Presence rows are not history: they only describe whether the env is
    // online right now. Without this cleanup a deleted env keeps showing up as
    // a greyed-out "offline" card on the dashboard until the DB is wiped.
    const heartbeat = this.db
      .delete(envHeartbeats)
      .where(eq(envHeartbeats.env, env))
      .run();
    const runner = this.db
      .delete(envRunners)
      .where(eq(envRunners.env, env))
      .run();
    // A device card is only proof that some agent runs there; deleting the
    // last one must not leave a machine that can never be seen again.
    if (deviceId) this.dropDeviceIfIdle(deviceId);
    return (
      agent.changes > 0 || heartbeat.changes > 0 || runner.changes > 0
    );
  }

  setAgentToken(
    env: string,
    tokenHash: string,
    tokenPrefix: string,
    now = Date.now(),
  ): Agent | null {
    const row = this.db
      .update(agents)
      .set({
        tokenHash,
        tokenPrefix,
        tokenCreatedAt: now,
        updatedAt: now,
      })
      .where(eq(agents.env, env))
      .returning()
      .get();

    return row ? this.getAgent(env, now) : null;
  }

  clearAgentToken(env: string, now = Date.now()): Agent | null {
    const row = this.db
      .update(agents)
      .set({
        tokenHash: null,
        tokenPrefix: null,
        tokenCreatedAt: null,
        updatedAt: now,
      })
      .where(eq(agents.env, env))
      .returning()
      .get();

    return row ? this.getAgent(env, now) : null;
  }

  findAgentByTokenHash(tokenHash: string): Agent | null {
    const row = this.db
      .select()
      .from(agents)
      .where(eq(agents.tokenHash, tokenHash))
      .get();
    return row ? toAgent(row, undefined, Date.now()) : null;
  }

  /* ---------------------------------------------------------------- */
  /* One-time enrollment codes                                        */
  /* ---------------------------------------------------------------- */

  createEnrollmentCode(
    input: CreateEnrollmentCodeInput,
    now = Date.now(),
  ): StoredEnrollment {
    const row = this.db
      .insert(enrollmentCodes)
      .values({
        codeHash: input.codeHash,
        codePrefix: input.codePrefix,
        ...(input.env ? { env: input.env } : {}),
        ...(input.label ? { label: input.label } : {}),
        ...(input.projectName ? { projectName: input.projectName } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        expiresAt: now + input.ttlMs,
        maxUses: input.maxUses ?? 1,
        useCount: 0,
        createdAt: now,
      })
      .returning()
      .get();

    return toEnrollment(row);
  }

  findEnrollmentByHash(codeHash: string): StoredEnrollment | null {
    const row = this.db
      .select()
      .from(enrollmentCodes)
      .where(eq(enrollmentCodes.codeHash, codeHash))
      .get();
    return row ? toEnrollment(row) : null;
  }

  consumeEnrollmentCode(
    id: number,
    usedEnv: string,
    usedHost: string | undefined,
    now = Date.now(),
  ): boolean {
    const row = this.db
      .select()
      .from(enrollmentCodes)
      .where(eq(enrollmentCodes.id, id))
      .get();
    if (!row) return false;
    if (row.expiresAt <= now) return false;

    const usedEnvs = parseUsedEnvs(row.usedEnvs ?? null);
    // Re-installing a client this code already enrolled is idempotent: rotate
    // its token without spending another slot, so repeated runs never exhaust
    // the code and never create `-2` ghosts.
    const already = usedEnvs.includes(usedEnv);
    const useCount = row.useCount ?? 0;
    if (!already && useCount >= (row.maxUses ?? 1)) return false;
    // A code belongs to one machine. Reusing it from another host would let a
    // leaked link enroll someone else's computer, so keep the first host.
    // Host names are case-insensitive; compare them normalized.
    if (
      row.usedHost &&
      usedHost &&
      row.usedHost.trim().toLowerCase() !== usedHost.trim().toLowerCase()
    ) {
      return false;
    }

    if (!already) usedEnvs.push(usedEnv);

    const result = this.db
      .update(enrollmentCodes)
      .set({
        usedAt: now,
        usedEnv,
        ...(usedHost ? { usedHost } : {}),
        useCount: already ? useCount : useCount + 1,
        usedEnvs: JSON.stringify(usedEnvs),
      })
      .where(
        and(
          eq(enrollmentCodes.id, id),
          eq(enrollmentCodes.useCount, useCount),
          gt(enrollmentCodes.expiresAt, now),
        ),
      )
      .run();
    return result.changes > 0;
  }

  recordDeviceConnection(
    input: DeviceConnectionInput,
    now = Date.now(),
  ): Agent {
    const os = `${input.capabilities.os}-${input.capabilities.arch}`;
    const owner = this.getAgentMachine(input.env);
    const reported = {
      host: input.capabilities.hostname,
      machineId: input.capabilities.machineId,
    };
    this.reportConflict(owner, reported, input.env);
    const owned = sameMachine(owner ?? {}, reported);
    const deviceId = owned
      ? this.upsertDevice(
          reported,
          {
            os,
            capabilities: input.capabilities,
            deviceStats: input.stats,
            transport: input.transport,
          },
          now,
        )
      : null;
    const machine = owned
      ? {
          host: input.capabilities.hostname,
          os,
          capabilities: input.capabilities,
          ...(deviceId ? { deviceId } : {}),
          ...(input.stats ? { deviceStats: input.stats } : {}),
        }
      : {};

    this.db
      .insert(agents)
      .values({
        env: input.env,
        name: input.env,
        kind: 'other',
        status: 'active',
        host: input.capabilities.hostname,
        os,
        protocolVersion: input.protocolVersion,
        capabilities: input.capabilities,
        deviceStats: input.stats ?? null,
        transport: input.transport,
        connectedAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agents.env,
        set: {
          ...machine,
          protocolVersion: input.protocolVersion,
          transport: input.transport,
          connectedAt: now,
          lastSeenAt: now,
          updatedAt: now,
        },
      })
      .run();

    // Make the device visible in the top status strip as well as the agent
    // registry. If an HTTP heartbeat already owns the status, only refresh the
    // timestamp so a running task is not overwritten with "Idle".
    this.db
      .insert(envHeartbeats)
      .values({
        env: input.env,
        status: 'Idle',
        projectName: input.projectName ?? null,
        currentTask: '反向长连已连接',
        note: null,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: envHeartbeats.env,
        set: {
          lastSeenAt: now,
          ...(input.projectName ? { projectName: input.projectName } : {}),
        },
      })
      .run();

    if (input.projectName) {
      this.bindWorkspaceProject(input.env, input.projectName, now);
    }

    return this.getAgent(input.env, now)!;
  }

  recordDeviceHeartbeat(
    env: string,
    stats: DeviceStats | undefined,
    now = Date.now(),
  ): Agent | null {
    const row = this.db
      .update(agents)
      .set({
        ...(stats ? { deviceStats: stats } : {}),
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(agents.env, env))
      .returning()
      .get();

    this.db
      .update(envHeartbeats)
      .set({ lastSeenAt: now })
      .where(eq(envHeartbeats.env, env))
      .run();

    // The agent beat for the whole box, so the device card ages with it.
    if (row?.deviceId) {
      this.db
        .update(devices)
        .set({ lastSeenAt: now, updatedAt: now })
        .where(eq(devices.id, row.deviceId))
        .run();
    }

    return row ? this.getAgent(env, now) : null;
  }

  markDeviceDisconnected(env: string, now = Date.now()): Agent | null {
    const row = this.db
      .update(agents)
      .set({
        connectedAt: null,
        updatedAt: now,
      })
      .where(eq(agents.env, env))
      .returning()
      .get();

    // The WS connection is the presence signal; do not wait 90s for the
    // heartbeat window before the status strip goes offline.
    this.db
      .update(envHeartbeats)
      .set({ lastSeenAt: now - HEARTBEAT_ONLINE_WINDOW_MS - 1 })
      .where(eq(envHeartbeats.env, env))
      .run();

    return row ? this.getAgent(env, now) : null;
  }

  recordAgentPresence(
    env: string,
    meta: AgentMeta | undefined,
    now = Date.now(),
  ): void {
    // A heartbeat cannot be re-labelled by the hub, so machine metadata is only
    // accepted from the machine that already owns this env. Without the guard
    // two machines sharing a label overwrite each other on every beat.
    const owner = this.getAgentMachine(env);
    const reported = { host: meta?.host, machineId: meta?.machineId };
    this.reportConflict(owner, reported, env);
    const owned = sameMachine(owner ?? {}, reported);
    const deviceId = owned ? this.upsertDevice(reported, {}, now) : null;
    const machine = {
      ...(owned && meta?.host ? { host: meta.host } : {}),
      ...(owned && meta?.os ? { os: meta.os } : {}),
      ...(owned && deviceId ? { deviceId } : {}),
    };

    this.db
      .insert(agents)
      .values({
        env,
        name: env,
        kind: meta?.kind ?? 'other',
        status: 'active',
        ...(meta?.version ? { version: meta.version } : {}),
        ...machine,
        transport: 'http',
        connectedAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agents.env,
        set: {
          // "other" means "client did not say" — keep a more specific kind that
          // the console or a newer bridge already reported, otherwise an old
          // client would relabel an OpenCode agent as "other" on every beat.
          ...(meta?.kind && meta.kind !== 'other' ? { kind: meta.kind } : {}),
          ...(meta?.version ? { version: meta.version } : {}),
          ...machine,
          transport: 'http',
          connectedAt: now,
          lastSeenAt: now,
          updatedAt: now,
        },
      })
      .run();
  }

  renewTaskLease(env: string, now = Date.now()): number {
    return this.db
      .update(agentTasks)
      .set({ leaseAt: now, updatedAt: now })
      .where(and(eq(agentTasks.env, env), eq(agentTasks.status, 'CLAIMED')))
      .run().changes;
  }

  /* ---------------------------------------------------------------- */
  /* Task execution logs                                              */
  /* ---------------------------------------------------------------- */

  appendTaskLog(
    taskId: number,
    input: AppendTaskLogInput,
    now = Date.now(),
  ): TaskLog {
    const row = this.db
      .insert(taskLogs)
      .values({
        taskId,
        stream: input.stream,
        chunk: input.chunk,
        createdAt: now,
      })
      .returning()
      .get();

    this.trimTaskLogs(taskId);
    return toTaskLog(row);
  }

  listTaskLogs(
    taskId: number,
    query: ListTaskLogsQuery,
  ): TaskLogListResponse {
    const rows = this.db
      .select()
      .from(taskLogs)
      .where(and(eq(taskLogs.taskId, taskId), gt(taskLogs.id, query.after)))
      .orderBy(asc(taskLogs.id))
      .limit(query.limit)
      .all();

    const logs = rows.map(toTaskLog);
    return {
      logs,
      nextAfter: logs.length > 0 ? logs[logs.length - 1]!.id : query.after,
      truncated: rows.length === query.limit,
    };
  }

  private trimTaskLogs(taskId: number): void {
    const rows = this.db
      .select({
        id: taskLogs.id,
        size: sql<number>`length(${taskLogs.chunk})`,
      })
      .from(taskLogs)
      .where(eq(taskLogs.taskId, taskId))
      .orderBy(asc(taskLogs.id))
      .all();

    let total = rows.reduce((sum, row) => sum + Number(row.size), 0);
    let remove = 0;
    while (total > MAX_TASK_LOG_BYTES && remove < rows.length) {
      total -= Number(rows[remove]!.size);
      remove += 1;
    }
    if (remove === 0) return;

    this.db
      .delete(taskLogs)
      .where(
        and(
          eq(taskLogs.taskId, taskId),
          inArray(
            taskLogs.id,
            rows.slice(0, remove).map((row) => row.id),
          ),
        ),
      )
      .run();
  }

  /* ---------------------------------------------------------------- */
  /* Interactive sessions                                            */
  /* ---------------------------------------------------------------- */

  createChatSession(
    input: CreateChatSessionInput,
    now = Date.now(),
  ): ChatSession {
    const title =
      input.title?.trim() ||
      `${input.projectName ?? input.env} 会话`;
    const row = this.db
      .insert(chatSessions)
      .values({
        env: input.env,
        projectName: input.projectName ?? null,
        title,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    if (input.projectName) {
      this.bindWorkspaceProject(input.env, input.projectName, now);
    }
    return toChatSession(row, 0, 0);
  }

  listChatSessions(
    query: ListChatSessionsQuery,
    now = Date.now(),
  ): ChatSession[] {
    const rows = this.db
      .select()
      .from(chatSessions)
      .where(query.env ? eq(chatSessions.env, query.env) : undefined)
      .orderBy(desc(chatSessions.updatedAt), desc(chatSessions.id))
      .limit(query.limit)
      .all();

    const sessionIds = rows.map((row) => row.id);
    const counts = new Map(
      rows.length === 0
        ? []
        : this.db
            .select({ sessionId: chatMessages.sessionId, value: count() })
            .from(chatMessages)
            .where(inArray(chatMessages.sessionId, sessionIds))
            .groupBy(chatMessages.sessionId)
            .all()
            .map((row) => [row.sessionId, Number(row.value)]),
    );
    const pendingCounts = new Map(
      rows.length === 0
        ? []
        : this.db
            .select({ sessionId: chatMessages.sessionId, value: count() })
            .from(chatMessages)
            .where(
              and(
                inArray(chatMessages.sessionId, sessionIds),
                inArray(chatMessages.status, CHAT_PENDING_STATUSES),
              ),
            )
            .groupBy(chatMessages.sessionId)
            .all()
            .map((row) => [row.sessionId, Number(row.value)]),
    );

    return rows.map((row) =>
      toChatSession(
        row,
        counts.get(row.id) ?? 0,
        pendingCounts.get(row.id) ?? 0,
      ),
    );
  }

  getChatSession(id: number, now = Date.now()): ChatSession | null {
    const row = this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, id))
      .get();
    if (!row) return null;

    const countRow = this.db
      .select({ value: count() })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, id))
      .get();
    const pendingRow = this.db
      .select({ value: count() })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.sessionId, id),
          inArray(chatMessages.status, CHAT_PENDING_STATUSES),
        ),
      )
      .get();
    return toChatSession(
      row,
      Number(countRow?.value ?? 0),
      Number(pendingRow?.value ?? 0),
    );
  }

  getChatMessage(id: number): ChatMessage | null {
    const row = this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, id))
      .get();
    return row ? toChatMessage(row) : null;
  }

  listChatMessages(sessionId: number, limit = 200): ChatMessage[] {
    const rows = this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(desc(chatMessages.id))
      .limit(limit)
      .all();
    return rows.reverse().map(toChatMessage);
  }

  sendChatMessage(
    sessionId: number,
    input: SendChatMessageInput,
    now = Date.now(),
  ): ChatMessage {
    const row = this.db
      .insert(chatMessages)
      .values({
        sessionId,
        role: 'user',
        content: input.content,
        status: 'PENDING',
        origin: 'human',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    this.db
      .update(chatSessions)
      .set({ updatedAt: now, lastMessageAt: now })
      .where(eq(chatSessions.id, sessionId))
      .run();

    return toChatMessage(row);
  }

  findLatestActiveChatSession(env: string): ChatSession | null {
    const row = this.db
      .select()
      .from(chatSessions)
      .where(
        and(eq(chatSessions.env, env), eq(chatSessions.status, 'ACTIVE')),
      )
      .orderBy(desc(chatSessions.updatedAt), desc(chatSessions.id))
      .get();
    return row ? toChatSession(row) : null;
  }

  /**
   * Store an agent-drafted reply. It sits in `PROPOSED` and is invisible to
   * `claimNextChatMessage`, so the bridge never delivers it until a human
   * adopts it.
   */
  createChatProposal(
    sessionId: number,
    input: { content: string; rationale?: string },
    now = Date.now(),
  ): ChatMessage {
    const row = this.db
      .insert(chatMessages)
      .values({
        sessionId,
        role: 'user',
        content: input.content,
        status: 'PROPOSED',
        origin: 'agent',
        rationale: input.rationale ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    this.db
      .update(chatSessions)
      .set({ updatedAt: now })
      .where(eq(chatSessions.id, sessionId))
      .run();

    return toChatMessage(row);
  }

  /**
   * Queue an agent-authored reply directly. Only the hub's decision policy may
   * call this: it is the `AUTO` path where no human reviewed the text first.
   */
  queueChatReply(
    sessionId: number,
    input: {
      content: string;
      rationale?: string;
      decision?: ChatMessageDecision;
    },
    now = Date.now(),
  ): ChatMessage {
    const row = this.db
      .insert(chatMessages)
      .values({
        sessionId,
        role: 'user',
        content: input.content,
        status: 'PENDING',
        origin: 'agent',
        decision: input.decision ?? 'AUTO',
        rationale: input.rationale ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    this.db
      .update(chatSessions)
      .set({ updatedAt: now, lastMessageAt: now })
      .where(eq(chatSessions.id, sessionId))
      .run();

    return toChatMessage(row);
  }

  /** Turn a draft into a real queued user message (optionally human-edited). */
  adoptChatProposal(
    sessionId: number,
    messageId: number,
    input: { content?: string },
    now = Date.now(),
  ): ChatMessage | null {
    const current = this.db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.sessionId, sessionId),
          eq(chatMessages.status, 'PROPOSED'),
        ),
      )
      .get();
    if (!current) return null;

    const row = this.db
      .update(chatMessages)
      .set({
        status: 'PENDING',
        content: input.content ?? current.content,
        decision: 'HUMAN',
        updatedAt: now,
      })
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.status, 'PROPOSED'),
        ),
      )
      .returning()
      .get();
    if (!row) return null;

    this.db
      .update(chatSessions)
      .set({ updatedAt: now, lastMessageAt: now })
      .where(eq(chatSessions.id, sessionId))
      .run();

    return toChatMessage(row);
  }

  /** Reject a draft without deleting it, so the transcript stays auditable. */
  discardChatProposal(
    sessionId: number,
    messageId: number,
    now = Date.now(),
  ): ChatMessage | null {
    const row = this.db
      .update(chatMessages)
      .set({ status: 'DISCARDED', updatedAt: now })
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.sessionId, sessionId),
          eq(chatMessages.status, 'PROPOSED'),
        ),
      )
      .returning()
      .get();

    if (!row) return null;

    this.db
      .update(chatSessions)
      .set({ updatedAt: now })
      .where(eq(chatSessions.id, sessionId))
      .run();

    return toChatMessage(row);
  }

  claimNextChatMessage(
    env: string,
    now = Date.now(),
  ): { session: ChatSession; message: ChatMessage } | null {
    const row = this.db
      .select({ session: chatSessions, message: chatMessages })
      .from(chatMessages)
      .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
      .where(
        and(
          eq(chatSessions.env, env),
          eq(chatSessions.status, 'ACTIVE'),
          eq(chatMessages.role, 'user'),
          eq(chatMessages.status, 'PENDING'),
        ),
      )
      .orderBy(asc(chatMessages.id))
      .limit(1)
      .get();

    if (!row) return null;

    const updated = this.db
      .update(chatMessages)
      .set({ status: 'RUNNING', updatedAt: now })
      .where(
        and(
          eq(chatMessages.id, row.message.id),
          eq(chatMessages.status, 'PENDING'),
        ),
      )
      .returning()
      .get();
    if (!updated) return null;

    this.db
      .update(chatSessions)
      .set({ updatedAt: now, lastMessageAt: now })
      .where(eq(chatSessions.id, row.session.id))
      .run();

    return {
      session: toChatSession(row.session),
      message: toChatMessage(updated),
    };
  }

  completeChatMessage(
    sessionId: number,
    messageId: number,
    input: CompleteChatMessageInput,
    now = Date.now(),
    force = false,
  ): ChatMessageResponse {
    let row = this.db
      .update(chatMessages)
      .set({
        status: input.status,
        error: input.error ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.sessionId, sessionId),
          eq(chatMessages.status, 'RUNNING'),
        ),
      )
      .returning()
      .get();

    // The hub already gave this turn up while the client was unreachable.
    // `force` lets a replayed answer replace that placeholder; a genuine
    // failure or an already-recorded turn stays untouched.
    if (!row && force) {
      row = this.db
        .update(chatMessages)
        .set({
          status: input.status,
          error: input.error ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(chatMessages.id, messageId),
            eq(chatMessages.sessionId, sessionId),
            eq(chatMessages.role, 'user'),
            eq(chatMessages.status, 'FAILED'),
            like(chatMessages.error, `${CHAT_INTERRUPTED_PREFIX}%`),
          ),
        )
        .returning()
        .get();
    }

    if (!row) {
      throw new ConflictError(
        `session message #${messageId} is not running`,
        'INVALID_MESSAGE_STATUS',
      );
    }

    let assistant: ChatMessageRow | undefined;
    if (input.status === 'DONE') {
      assistant = this.db
        .insert(chatMessages)
        .values({
          sessionId,
          role: 'assistant',
          content: input.content?.trim() || '（无输出）',
          status: 'DONE',
          origin: 'agent',
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    }

    const sessionRow = this.db
      .update(chatSessions)
      .set({
        updatedAt: now,
        lastMessageAt: now,
        ...(input.externalId ? { externalId: input.externalId } : {}),
      })
      .where(eq(chatSessions.id, sessionId))
      .returning()
      .get();

    if (!sessionRow) {
      throw new ConflictError(
        `session #${sessionId} not found`,
        'NOT_FOUND',
      );
    }

    return {
      session: toChatSession(sessionRow),
      message: toChatMessage(row),
      ...(assistant ? { assistant: toChatMessage(assistant) } : {}),
    };
  }

  appendChatEvent(
    sessionId: number,
    messageId: number,
    input: AppendChatEventInput,
    now = Date.now(),
  ): ChatEvent {
    const row = this.db
      .insert(chatEvents)
      .values({
        sessionId,
        messageId,
        stream: input.stream,
        chunk: input.chunk,
        createdAt: now,
      })
      .returning()
      .get();

    this.trimChatEvents(sessionId);
    return toChatEvent(row);
  }

  listChatEvents(
    sessionId: number,
    query: ListChatEventsQuery,
  ): ChatEventListResponse {
    const rows = this.db
      .select()
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.sessionId, sessionId),
          ...(query.messageId
            ? [eq(chatEvents.messageId, Number(query.messageId))]
            : []),
          gt(chatEvents.id, query.after),
        ),
      )
      .orderBy(asc(chatEvents.id))
      .limit(query.limit)
      .all();

    const events = rows.map(toChatEvent);
    return {
      events,
      nextAfter:
        events.length > 0 ? events[events.length - 1]!.id : query.after,
      truncated: rows.length === query.limit,
    };
  }

  closeChatSession(sessionId: number, now = Date.now()): ChatSession | null {
    const row = this.db
      .update(chatSessions)
      .set({ status: 'CLOSED', updatedAt: now })
      .where(
        and(
          eq(chatSessions.id, sessionId),
          eq(chatSessions.status, 'ACTIVE'),
        ),
      )
      .returning()
      .get();
    return row ? toChatSession(row) : null;
  }

  /**
   * Hard-delete a session together with its transcript and streamed output.
   * The tables have no foreign keys, so children are removed first.
   */
  deleteChatSession(sessionId: number): boolean {
    this.db.delete(chatEvents).where(eq(chatEvents.sessionId, sessionId)).run();
    this.db
      .delete(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .run();
    return (
      this.db.delete(chatSessions).where(eq(chatSessions.id, sessionId)).run()
        .changes > 0
    );
  }

  /**
   * A runner that died mid-turn leaves the message RUNNING forever. Only fail
   * messages whose env stopped sending heartbeats, so a slow model on a live
   * runner is never interrupted.
   */
  failStaleChatMessages(
    onlineEnvs: Set<string>,
    cutoff: number,
    now = Date.now(),
  ): number {
    const rows = this.db
      .select({ id: chatMessages.id, env: chatSessions.env })
      .from(chatMessages)
      .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
      .where(
        and(
          eq(chatMessages.role, 'user'),
          eq(chatMessages.status, 'RUNNING'),
          lte(chatMessages.updatedAt, cutoff),
        ),
      )
      .all();

    const ids = rows
      .filter((row) => !onlineEnvs.has(row.env))
      .map((row) => row.id);
    if (ids.length === 0) return 0;

    return this.db
      .update(chatMessages)
      .set({
        status: 'FAILED',
        error: `${CHAT_INTERRUPTED_PREFIX}：端侧离线，可以重试`,
        updatedAt: now,
      })
      .where(inArray(chatMessages.id, ids))
      .run().changes;
  }

  claimRunner(env: string, runnerId: string, now = Date.now()): string | null {
    const current = this.db
      .select({ runnerId: envRunners.runnerId })
      .from(envRunners)
      .where(eq(envRunners.env, env))
      .get();

    if (current?.runnerId === runnerId) return runnerId;

    this.db
      .insert(envRunners)
      .values({ env, runnerId, updatedAt: now })
      .onConflictDoUpdate({
        target: envRunners.env,
        set: { runnerId, updatedAt: now },
      })
      .run();

    return current?.runnerId ?? null;
  }

  failRunningChatMessages(
    env: string,
    now = Date.now(),
    error = `${CHAT_INTERRUPTED_PREFIX}：端侧 runner 已重启，可以重试（会恢复原 CLI 会话）`,
  ): number {
    const rows = this.db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
      .where(
        and(
          eq(chatSessions.env, env),
          eq(chatMessages.role, 'user'),
          eq(chatMessages.status, 'RUNNING'),
        ),
      )
      .all();

    if (rows.length === 0) return 0;

    return this.db
      .update(chatMessages)
      .set({ status: 'FAILED', error, updatedAt: now })
      .where(
        inArray(
          chatMessages.id,
          rows.map((row) => row.id),
        ),
      )
      .run().changes;
  }

  retryChatMessage(
    sessionId: number,
    messageId: number,
    now = Date.now(),
  ): ChatMessage | null {
    const row = this.db
      .update(chatMessages)
      .set({ status: 'PENDING', error: null, updatedAt: now })
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.sessionId, sessionId),
          eq(chatMessages.role, 'user'),
          eq(chatMessages.status, 'FAILED'),
        ),
      )
      .returning()
      .get();

    if (!row) return null;

    this.db
      .update(chatSessions)
      .set({ updatedAt: now, lastMessageAt: now })
      .where(eq(chatSessions.id, sessionId))
      .run();
    return toChatMessage(row);
  }

  /* ---------------------------------------------------------------- */
  /* Terminal sessions                                                */
  /* ---------------------------------------------------------------- */

  createTerminalSession(
    input: CreateTerminalInput & { title: string },
    now = Date.now(),
  ): TerminalSession {
    const row = this.db
      .insert(terminalSessions)
      .values({
        env: input.env,
        projectName: input.projectName ?? null,
        title: input.title,
        shell: input.shell ?? null,
        cwd: input.cwd ?? null,
        cols: input.cols,
        rows: input.rows,
        status: 'STARTING',
        createdAt: now,
        updatedAt: now,
        lastActiveAt: now,
      })
      .returning()
      .get();

    return toTerminalSession(row);
  }

  getTerminalSession(id: number, now = Date.now()): TerminalSession | null {
    const row = this.db
      .select()
      .from(terminalSessions)
      .where(eq(terminalSessions.id, id))
      .get();
    void now;
    return row ? toTerminalSession(row) : null;
  }

  listTerminalSessions(
    query: ListTerminalsQuery,
    now = Date.now(),
  ): { sessions: TerminalSession[]; total: number } {
    void now;
    const where = and(
      query.env ? eq(terminalSessions.env, query.env) : undefined,
      query.status ? eq(terminalSessions.status, query.status) : undefined,
    );

    const rows = this.db
      .select()
      .from(terminalSessions)
      .where(where)
      .orderBy(desc(terminalSessions.updatedAt))
      .limit(query.limit)
      .all();

    const total =
      this.db
        .select({ value: count() })
        .from(terminalSessions)
        .where(where)
        .get()?.value ?? 0;

    return {
      sessions: rows.map(toTerminalSession),
      total: Number(total),
    };
  }

  listActiveTerminalSessions(
    env?: string,
    now = Date.now(),
  ): TerminalSession[] {
    void now;
    const activeStatuses: TerminalSessionStatus[] = [
      'STARTING',
      'ACTIVE',
      'DETACHED',
    ];
    const rows = this.db
      .select()
      .from(terminalSessions)
      .where(
        and(
          inArray(terminalSessions.status, activeStatuses),
          env ? eq(terminalSessions.env, env) : undefined,
        ),
      )
      .orderBy(desc(terminalSessions.updatedAt))
      .all();

    return rows.map(toTerminalSession);
  }

  countActiveTerminalSessions(env?: string): number {
    const activeStatuses: TerminalSessionStatus[] = [
      'STARTING',
      'ACTIVE',
      'DETACHED',
    ];
    const row = this.db
      .select({ value: count() })
      .from(terminalSessions)
      .where(
        and(
          inArray(terminalSessions.status, activeStatuses),
          env ? eq(terminalSessions.env, env) : undefined,
        ),
      )
      .get();

    return Number(row?.value ?? 0);
  }

  updateTerminalSession(
    id: number,
    patch: {
      status?: TerminalSessionStatus;
      lastActiveAt?: number;
      closedAt?: number | null;
      exitCode?: number | null;
      error?: string | null;
    },
    now = Date.now(),
  ): TerminalSession | null {
    const row = this.db
      .update(terminalSessions)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.lastActiveAt !== undefined
          ? { lastActiveAt: patch.lastActiveAt }
          : {}),
        ...(patch.closedAt !== undefined ? { closedAt: patch.closedAt } : {}),
        ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        updatedAt: now,
      })
      .where(eq(terminalSessions.id, id))
      .returning()
      .get();

    return row ? toTerminalSession(row) : null;
  }

  appendTerminalAudit(
    input: {
      sessionId: number;
      env: string;
      kind: TerminalAuditKind;
      viewerId?: string;
      data?: string;
    },
    now = Date.now(),
  ): TerminalAuditEntry {
    const row = this.db
      .insert(terminalAudit)
      .values({
        sessionId: input.sessionId,
        env: input.env,
        kind: input.kind,
        viewerId: input.viewerId ?? null,
        data: input.data ?? null,
        createdAt: now,
      })
      .returning()
      .get();

    return toTerminalAudit(row);
  }

  listTerminalAudit(
    sessionId: number,
    query: ListTerminalAuditQuery,
  ): TerminalAuditListResponse {
    const rows = this.db
      .select()
      .from(terminalAudit)
      .where(
        and(
          eq(terminalAudit.sessionId, sessionId),
          gt(terminalAudit.id, query.after),
        ),
      )
      .orderBy(asc(terminalAudit.id))
      .limit(query.limit + 1)
      .all();

    const truncated = rows.length > query.limit;
    const entries = rows.slice(0, query.limit).map(toTerminalAudit);
    const last = entries.at(-1);

    return {
      entries,
      nextAfter: last ? Number(last.id) : query.after,
      truncated,
    };
  }

  createExchange(
    env: string,
    input: Omit<ReportExchangeInput, 'env'>,
    now = Date.now(),
  ): Exchange {
    const row = this.db
      .insert(exchanges)
      .values({
        env,
        projectName: input.projectName ?? null,
        question: input.question ?? null,
        conclusion: input.conclusion ?? null,
        createdAt: now,
      })
      .returning()
      .get();

    if (input.projectName) {
      this.bindWorkspaceProject(env, input.projectName, now);
    }
    this.trimExchanges(env);
    return toExchange(row);
  }

  listExchanges(query: ListExchangesQuery): Exchange[] {
    const filters = [
      ...(query.env ? [eq(exchanges.env, query.env)] : []),
      ...(query.projectName
        ? [eq(exchanges.projectName, query.projectName)]
        : []),
    ];

    const rows = this.db
      .select()
      .from(exchanges)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(exchanges.id))
      .limit(query.limit)
      .all();

    return rows.map(toExchange);
  }

  /** Keep only the newest N exchanges per env so the table stays bounded. */
  private trimExchanges(env: string): void {
    const rows = this.db
      .select({ id: exchanges.id })
      .from(exchanges)
      .where(eq(exchanges.env, env))
      .orderBy(desc(exchanges.id))
      .all();

    const overflow = rows
      .slice(MAX_EXCHANGES_PER_ENV)
      .map((row) => row.id);
    if (overflow.length === 0) return;

    this.db.delete(exchanges).where(inArray(exchanges.id, overflow)).run();
  }

  private trimChatEvents(sessionId: number): void {
    const rows = this.db
      .select({
        id: chatEvents.id,
        size: sql<number>`length(${chatEvents.chunk})`,
      })
      .from(chatEvents)
      .where(eq(chatEvents.sessionId, sessionId))
      .orderBy(asc(chatEvents.id))
      .all();

    let total = rows.reduce((sum, row) => sum + Number(row.size), 0);
    let remove = 0;
    while (total > MAX_CHAT_EVENT_BYTES && remove < rows.length) {
      total -= Number(rows[remove]!.size);
      remove += 1;
    }
    if (remove === 0) return;

    this.db
      .delete(chatEvents)
      .where(
        and(
          eq(chatEvents.sessionId, sessionId),
          inArray(
            chatEvents.id,
            rows.slice(0, remove).map((row) => row.id),
          ),
        ),
      )
      .run();
  }

  /* ---------------------------------------------------------------- */
  /* Human → Agent tasks                                              */
  /* ---------------------------------------------------------------- */

  createTask(input: CreateTaskInput, now = Date.now()): AgentTask {
    const row = this.db
      .insert(agentTasks)
      .values({
        env: input.env,
        projectName: input.projectName ?? null,
        title: input.title,
        instruction: input.instruction,
        status: 'PENDING',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    if (input.projectName) {
      this.bindWorkspaceProject(input.env, input.projectName, now);
    }

    return toTask(row);
  }

  getTask(id: number): AgentTask | null {
    const row = this.db.select().from(agentTasks).where(eq(agentTasks.id, id)).get();
    return row ? toTask(row) : null;
  }

  listTasks(query: ListTasksQuery): { tasks: AgentTask[]; total: number } {
    const filters = [
      ...(query.env ? [eq(agentTasks.env, query.env)] : []),
      ...(query.status ? [eq(agentTasks.status, query.status)] : []),
    ];
    const where = filters.length > 0 ? and(...filters) : undefined;

    const rows = this.db
      .select()
      .from(agentTasks)
      .where(where)
      .orderBy(desc(agentTasks.createdAt), desc(agentTasks.id))
      .limit(query.limit)
      .all();

    const countRow = this.db
      .select({ value: count() })
      .from(agentTasks)
      .where(where)
      .get();

    return {
      tasks: rows.map(toTask),
      total: countRow?.value ?? 0,
    };
  }

  /**
   * Atomically claim the oldest pending task for an env. If another bridge
   * wins the race, try the next pending task until none remain.
   */
  claimNextTask(env: string, now = Date.now()): AgentTask | null {
    for (;;) {
      const candidate = this.db
        .select()
        .from(agentTasks)
        .where(and(eq(agentTasks.env, env), eq(agentTasks.status, 'PENDING')))
        .orderBy(asc(agentTasks.createdAt), asc(agentTasks.id))
        .limit(1)
        .get();

      if (!candidate) return null;

      const row = this.db
        .update(agentTasks)
        .set({
          status: 'CLAIMED',
          claimedAt: now,
          leaseAt: now,
          updatedAt: now,
          attempts: sql`${agentTasks.attempts} + 1`,
        })
        .where(and(eq(agentTasks.id, candidate.id), eq(agentTasks.status, 'PENDING')))
        .returning()
        .get();

      if (row) return toTask(row);
    }
  }

  completeTask(id: number, input: CompleteTaskInput, now = Date.now()): AgentTask {
    const current = this.getTask(id);
    if (!current) {
      throw new ConflictError(`task #${id} not found`, 'NOT_FOUND');
    }
    if (current.status !== 'CLAIMED') {
      throw new ConflictError(
        `task #${id} is ${current.status}, expected CLAIMED`,
        'INVALID_TASK_STATUS',
      );
    }

    const row = this.db
      .update(agentTasks)
      .set({
        status: input.status,
        result: input.result ?? null,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(eq(agentTasks.id, id), eq(agentTasks.status, 'CLAIMED')))
      .returning()
      .get();

    if (!row) {
      throw new ConflictError(`task #${id} changed while completing`, 'RACE_LOST');
    }

    return toTask(row);
  }

  cancelTask(id: number, now = Date.now()): AgentTask | null {
    const row = this.db
      .update(agentTasks)
      .set({ status: 'CANCELLED', updatedAt: now })
      .where(
        and(
          eq(agentTasks.id, id),
          inArray(agentTasks.status, ['PENDING', 'CLAIMED']),
        ),
      )
      .returning()
      .get();

    return row ? toTask(row) : null;
  }

  listClaimedTasks(limit = 100): AgentTask[] {
    return this.db
      .select()
      .from(agentTasks)
      .where(eq(agentTasks.status, 'CLAIMED'))
      .orderBy(asc(agentTasks.claimedAt), asc(agentTasks.id))
      .limit(limit)
      .all()
      .map(toTask);
  }

  releaseTask(
    id: number,
    requeue: boolean,
    reason: string,
    now = Date.now(),
  ): AgentTask | null {
    const row = this.db
      .update(agentTasks)
      .set(
        requeue
          ? {
              status: 'PENDING',
              claimedAt: null,
              leaseAt: null,
              completedAt: null,
              updatedAt: now,
            }
          : {
              status: 'FAILED',
              result: reason,
              completedAt: now,
              updatedAt: now,
            },
      )
      .where(and(eq(agentTasks.id, id), eq(agentTasks.status, 'CLAIMED')))
      .returning()
      .get();

    return row ? toTask(row) : null;
  }

  listActiveTasks(env: string, limit = 50): AgentTask[] {
    return this.db
      .select()
      .from(agentTasks)
      .where(
        and(
          eq(agentTasks.env, env),
          inArray(agentTasks.status, ['PENDING', 'CLAIMED']),
        ),
      )
      .orderBy(asc(agentTasks.createdAt), asc(agentTasks.id))
      .limit(limit)
      .all()
      .map(toTask);
  }

  listResumeTickets(
    env: string,
    since: number,
    limit = 20,
  ): DecisionTicket[] {
    return this.db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.env, env),
          sql`(${tickets.status} IN ('PENDING_META', 'PENDING_HUMAN') OR ${tickets.updatedAt} >= ${since})`,
        ),
      )
      .orderBy(
        sql`CASE WHEN ${tickets.status} IN ('PENDING_META', 'PENDING_HUMAN') THEN 0 ELSE 1 END`,
        desc(tickets.updatedAt),
        desc(tickets.id),
      )
      .limit(limit)
      .all()
      .map(toTicket);
  }

  /* ---------------------------------------------------------------- */
  /* Workspace ↔ project bindings                                     */
  /* ---------------------------------------------------------------- */

  bindWorkspaceProject(
    env: string,
    projectName: string,
    now = Date.now(),
  ): WorkspaceProject {
    const row = this.db
      .insert(workspaceProjects)
      .values({
        env,
        projectName,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [workspaceProjects.env, workspaceProjects.projectName],
        set: { updatedAt: now },
      })
      .returning()
      .get();

    return toWorkspaceProject(row);
  }

  listWorkspaceProjects(query: ListWorkspaceProjectsQuery = {}): {
    projects: WorkspaceProject[];
    total: number;
  } {
    const where = query.env ? eq(workspaceProjects.env, query.env) : undefined;

    const rows = this.db
      .select()
      .from(workspaceProjects)
      .where(where)
      .orderBy(asc(workspaceProjects.env), asc(workspaceProjects.projectName))
      .all();

    const countRow = this.db
      .select({ value: count() })
      .from(workspaceProjects)
      .where(where)
      .get();

    return {
      projects: rows.map(toWorkspaceProject),
      total: countRow?.value ?? 0,
    };
  }

  getWorkspaceProject(id: number): WorkspaceProject | null {
    const row = this.db
      .select()
      .from(workspaceProjects)
      .where(eq(workspaceProjects.id, id))
      .get();
    return row ? toWorkspaceProject(row) : null;
  }

  unbindWorkspaceProject(id: number): WorkspaceProject | null {
    const row = this.db
      .delete(workspaceProjects)
      .where(eq(workspaceProjects.id, id))
      .returning()
      .get();
    return row ? toWorkspaceProject(row) : null;
  }

  /* ---------------------------------------------------------------- */
  /* Fleet directory association                                      */
  /* ---------------------------------------------------------------- */

  replaceFleetCandidates(
    host: string,
    candidates: FleetCandidateInput[],
    now = Date.now(),
  ): FleetCandidate[] {
    this.db.delete(fleetCandidates).where(eq(fleetCandidates.host, host)).run();
    if (candidates.length === 0) return [];

    const rows = this.db
      .insert(fleetCandidates)
      .values(
        candidates.map((candidate) => ({
          host,
          path: candidate.path,
          projectName: candidate.projectName,
          env: candidate.env,
          ...(candidate.adapter ? { adapter: candidate.adapter } : {}),
          associated: candidate.associated ?? false,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning()
      .all();

    return rows.map(toFleetCandidate);
  }

  listFleetCandidates(host?: string): {
    candidates: FleetCandidate[];
    total: number;
  } {
    const where = host ? eq(fleetCandidates.host, host) : undefined;
    const rows = this.db
      .select()
      .from(fleetCandidates)
      .where(where)
      .orderBy(asc(fleetCandidates.host), asc(fleetCandidates.path))
      .all();
    const countRow = this.db
      .select({ value: count() })
      .from(fleetCandidates)
      .where(where)
      .get();

    return {
      candidates: rows.map(toFleetCandidate),
      total: countRow?.value ?? 0,
    };
  }

  getFleetCandidate(id: number): FleetCandidate | null {
    const row = this.db
      .select()
      .from(fleetCandidates)
      .where(eq(fleetCandidates.id, id))
      .get();
    return row ? toFleetCandidate(row) : null;
  }

  createFleetWorkspace(
    input: {
      host: string;
      env: string;
      path: string;
      projectName: string;
      adapter?: string;
    },
    now = Date.now(),
  ): FleetWorkspace {
    const row = this.db
      .insert(fleetWorkspaces)
      .values({
        host: input.host,
        env: input.env,
        path: input.path,
        projectName: input.projectName,
        ...(input.adapter ? { adapter: input.adapter } : {}),
        status: 'PENDING',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    return toFleetWorkspace(row);
  }

  listFleetWorkspaces(host?: string): {
    workspaces: FleetWorkspace[];
    total: number;
  } {
    const where = host ? eq(fleetWorkspaces.host, host) : undefined;
    const rows = this.db
      .select()
      .from(fleetWorkspaces)
      .where(where)
      .orderBy(asc(fleetWorkspaces.host), asc(fleetWorkspaces.path))
      .all();
    const countRow = this.db
      .select({ value: count() })
      .from(fleetWorkspaces)
      .where(where)
      .get();

    return {
      workspaces: rows.map(toFleetWorkspace),
      total: countRow?.value ?? 0,
    };
  }

  getFleetWorkspace(id: number): FleetWorkspace | null {
    const row = this.db
      .select()
      .from(fleetWorkspaces)
      .where(eq(fleetWorkspaces.id, id))
      .get();
    return row ? toFleetWorkspace(row) : null;
  }

  getFleetWorkspaceByEnv(env: string): FleetWorkspace | null {
    const row = this.db
      .select()
      .from(fleetWorkspaces)
      .where(eq(fleetWorkspaces.env, env))
      .get();
    return row ? toFleetWorkspace(row) : null;
  }

  getFleetWorkspaceByHostPath(host: string, path: string): FleetWorkspace | null {
    const row = this.db
      .select()
      .from(fleetWorkspaces)
      .where(
        and(eq(fleetWorkspaces.host, host), eq(fleetWorkspaces.path, path)),
      )
      .get();
    return row ? toFleetWorkspace(row) : null;
  }

  getFleetWorkspaceToken(id: number): string | null {
    const row = this.db
      .select({ token: fleetWorkspaces.token })
      .from(fleetWorkspaces)
      .where(eq(fleetWorkspaces.id, id))
      .get();
    return row?.token ?? null;
  }

  updateFleetWorkspace(
    id: number,
    input: {
      status?: FleetWorkspaceStatus;
      error?: string | null;
      token?: string | null;
    },
    now = Date.now(),
  ): FleetWorkspace | null {
    const row = this.db
      .update(fleetWorkspaces)
      .set({
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.token !== undefined ? { token: input.token } : {}),
        updatedAt: now,
      })
      .where(eq(fleetWorkspaces.id, id))
      .returning()
      .get();
    return row ? toFleetWorkspace(row) : null;
  }

  deleteFleetWorkspace(id: number): FleetWorkspace | null {
    const row = this.db
      .delete(fleetWorkspaces)
      .where(eq(fleetWorkspaces.id, id))
      .returning()
      .get();
    return row ? toFleetWorkspace(row) : null;
  }

  /* ---------------------------------------------------------------- */
  /* Decision memory & rule candidates                                */
  /* ---------------------------------------------------------------- */

  findSimilarTickets(input: {
    projectName: string;
    blockerQuestion: string;
    excludeId?: number;
    limit?: number;
  }): DecisionTicket[] {
    const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
    const rows = this.db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.projectName, input.projectName),
          inArray(tickets.status, ['AUTO_RESOLVED', 'HUMAN_RESOLVED']),
        ),
      )
      .orderBy(desc(tickets.updatedAt), desc(tickets.id))
      .limit(120)
      .all();

    return rows
      .filter((row) => row.id !== input.excludeId)
      .map((row) => ({
        row,
        score: textSimilarity(input.blockerQuestion, row.blockerQuestion),
      }))
      .filter((entry) => entry.score >= 0.18)
      .sort(
        (left, right) =>
          right.score - left.score || right.row.updatedAt - left.row.updatedAt,
      )
      .slice(0, limit)
      .map((entry) => toTicket(entry.row));
  }

  createRuleCandidate(
    ticketId: number,
    content: string,
    now = Date.now(),
  ): RuleCandidate | null {
    const normalized = content.trim();
    if (!normalized) return null;

    const duplicate = this.db
      .select()
      .from(ruleCandidates)
      .where(
        and(
          eq(ruleCandidates.content, normalized),
          inArray(ruleCandidates.status, ['PENDING', 'ACCEPTED']),
        ),
      )
      .get();
    if (duplicate) return null;

    const row = this.db
      .insert(ruleCandidates)
      .values({
        ticketId,
        content: normalized,
        status: 'PENDING',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    return toRuleCandidate(row);
  }

  getRuleCandidate(id: number): RuleCandidate | null {
    const row = this.db
      .select()
      .from(ruleCandidates)
      .where(eq(ruleCandidates.id, id))
      .get();
    return row ? toRuleCandidate(row) : null;
  }

  listRuleCandidates(query: ListRuleCandidatesQuery): {
    candidates: RuleCandidate[];
    total: number;
  } {
    const where = query.status
      ? eq(ruleCandidates.status, query.status)
      : undefined;

    const rows = this.db
      .select()
      .from(ruleCandidates)
      .where(where)
      .orderBy(desc(ruleCandidates.createdAt), desc(ruleCandidates.id))
      .limit(query.limit)
      .all();

    const countRow = this.db
      .select({ value: count() })
      .from(ruleCandidates)
      .where(where)
      .get();

    return {
      candidates: rows.map(toRuleCandidate),
      total: countRow?.value ?? 0,
    };
  }

  markRuleCandidate(
    id: number,
    status: 'ACCEPTED' | 'DISMISSED',
    now = Date.now(),
  ): RuleCandidate | null {
    const row = this.db
      .update(ruleCandidates)
      .set({ status, updatedAt: now })
      .where(
        and(eq(ruleCandidates.id, id), eq(ruleCandidates.status, 'PENDING')),
      )
      .returning()
      .get();

    return row ? toRuleCandidate(row) : null;
  }

  /**
   * Dashboard change fingerprint.
   *
   * Every subquery is an indexed `MAX()`/`COUNT()` so this stays O(log n)
   * even as the tables grow. The columns deliberately ignore chat_events
   * (streamed output has its own cheap pager) so streaming does not wake
   * every connected dashboard.
   */
  syncFingerprint(): string {
    const row = this.db.get<Record<string, number>>(sql`
      SELECT
        COALESCE((SELECT MAX(updated_at) FROM tickets), 0) AS tickets_updated,
        COALESCE((SELECT MAX(updated_at) FROM agent_tasks), 0) AS tasks_updated,
        COALESCE((SELECT MAX(updated_at) FROM chat_messages), 0) AS messages_updated,
        COALESCE((SELECT MAX(updated_at) FROM chat_sessions), 0) AS sessions_updated,
        COALESCE((SELECT MAX(updated_at) FROM agents), 0) AS agents_updated,
        COALESCE((SELECT MAX(last_seen_at) FROM env_heartbeats), 0) AS heartbeats_seen,
        COALESCE((SELECT MAX(id) FROM exchanges), 0) AS exchanges_max,
        COALESCE((SELECT MAX(updated_at) FROM fleet_candidates), 0) AS fleet_candidates_updated,
        COALESCE((SELECT MAX(updated_at) FROM fleet_workspaces), 0) AS fleet_workspaces_updated,
        (SELECT COUNT(*) FROM agents) AS agents_count,
        (SELECT COUNT(*) FROM env_heartbeats) AS heartbeats_count,
        (SELECT COUNT(*) FROM workspace_projects) AS projects_count,
        (SELECT COUNT(*) FROM fleet_candidates) AS fleet_candidates_count,
        (SELECT COUNT(*) FROM fleet_workspaces) AS fleet_workspaces_count
    `);
    return row ? Object.values(row).join(':') : '';
  }
}
