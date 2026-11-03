import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  sql,
} from 'drizzle-orm';

import type {
  Agent,
  AgentMeta,
  AgentTask,
  AppendChatEventInput,
  AppendTaskLogInput,
  ChatEvent,
  ChatEventListResponse,
  ChatMessage,
  ChatMessageResponse,
  ChatSession,
  CompleteChatMessageInput,
  CompleteTaskInput,
  CreateAgentInput,
  CreateChatSessionInput,
  CreateTaskInput,
  CreateTicketInput,
  DecisionTicket,
  EnvHeartbeat,
  HeartbeatInput,
  ListAgentsQuery,
  ListChatEventsQuery,
  ListChatSessionsQuery,
  ListRuleCandidatesQuery,
  ListTaskLogsQuery,
  ListTasksQuery,
  ListTicketsQuery,
  ListWorkspaceProjectsQuery,
  ResolveTicketInput,
  RuleCandidate,
  SendChatMessageInput,
  TaskLog,
  TaskLogListResponse,
  TicketStatus,
  UpdateAgentInput,
  WorkspaceProject,
} from '@zhunzou/shared';
import { HEARTBEAT_ONLINE_WINDOW_MS } from '@zhunzou/shared';

import type { DrizzleDatabase } from './db/client.js';
import {
  agentTasks,
  agents,
  chatEvents,
  chatMessages,
  chatSessions,
  envHeartbeats,
  ruleCandidates,
  taskLogs,
  tickets,
  workspaceProjects,
  type AgentRow,
  type AgentTaskRow,
  type ChatEventRow,
  type ChatMessageRow,
  type ChatSessionRow,
  type HeartbeatRow,
  type RuleCandidateRow,
  type TaskLogRow,
  type TicketRow,
  type WorkspaceProjectRow,
} from './db/schema.js';
import { BadRequestError, ConflictError } from './errors.js';

const AWAITING: TicketStatus[] = ['PENDING_META', 'PENDING_HUMAN'];

/** Keep each task's live log bounded; older chunks are trimmed on append. */
const MAX_TASK_LOG_BYTES = 256 * 1024;
const MAX_CHAT_EVENT_BYTES = 256 * 1024;

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

function toAgent(
  row: AgentRow,
  heartbeat: HeartbeatRow | undefined,
  now: number,
): Agent {
  const lastSeenAt = heartbeat?.lastSeenAt ?? row.lastSeenAt ?? undefined;

  return {
    env: row.env,
    name: row.name,
    kind: row.kind,
    status: row.status,
    ...(row.version ? { version: row.version } : {}),
    ...(row.host ? { host: row.host } : {}),
    ...(row.os ? { os: row.os } : {}),
    ...(row.tokenPrefix ? { tokenPrefix: row.tokenPrefix } : {}),
    hasToken: Boolean(row.tokenHash),
    online:
      row.status === 'active' &&
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

function toChatSession(row: ChatSessionRow, messageCount?: number): ChatSession {
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
  };
}

function toChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    role: row.role,
    content: row.content,
    status: row.status,
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

function toWorkspaceProject(row: WorkspaceProjectRow): WorkspaceProject {
  return {
    id: String(row.id),
    env: row.env,
    projectName: row.projectName,
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

export interface TicketStore {
  create(
    input: CreateTicketInput,
    now?: number,
    expiresAt?: number,
  ): DecisionTicket;
  get(id: number): DecisionTicket | null;
  list(query: ListTicketsQuery): { tickets: DecisionTicket[]; total: number };
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
  updateAgent(env: string, input: UpdateAgentInput, now?: number): Agent | null;
  deleteAgent(env: string): boolean;
  setAgentToken(
    env: string,
    tokenHash: string,
    tokenPrefix: string,
    now?: number,
  ): Agent | null;
  clearAgentToken(env: string, now?: number): Agent | null;
  findAgentByTokenHash(tokenHash: string): Agent | null;
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
  claimNextChatMessage(
    env: string,
    now?: number,
  ): { session: ChatSession; message: ChatMessage } | null;
  completeChatMessage(
    sessionId: number,
    messageId: number,
    input: CompleteChatMessageInput,
    now?: number,
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
  failStaleChatMessages(
    onlineEnvs: Set<string>,
    cutoff: number,
    now?: number,
  ): number;
  retryChatMessage(
    sessionId: number,
    messageId: number,
    now?: number,
  ): ChatMessage | null;
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
  constructor(private readonly db: DrizzleDatabase) {}

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

  registerAgent(input: CreateAgentInput, now = Date.now()): Agent {
    const row = this.db
      .insert(agents)
      .values({
        env: input.env,
        name: input.name ?? input.env,
        kind: input.kind ?? 'other',
        status: 'active',
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agents.env,
        set: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
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
        updatedAt: now,
      })
      .where(eq(agents.env, env))
      .returning()
      .get();

    return row ? this.getAgent(env, now) : null;
  }

  deleteAgent(env: string): boolean {
    const result = this.db.delete(agents).where(eq(agents.env, env)).run();
    return result.changes > 0;
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

  recordAgentPresence(
    env: string,
    meta: AgentMeta | undefined,
    now = Date.now(),
  ): void {
    this.db
      .insert(agents)
      .values({
        env,
        name: env,
        kind: meta?.kind ?? 'other',
        status: 'active',
        ...(meta?.version ? { version: meta.version } : {}),
        ...(meta?.host ? { host: meta.host } : {}),
        ...(meta?.os ? { os: meta.os } : {}),
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agents.env,
        set: {
          ...(meta?.kind ? { kind: meta.kind } : {}),
          ...(meta?.version ? { version: meta.version } : {}),
          ...(meta?.host ? { host: meta.host } : {}),
          ...(meta?.os ? { os: meta.os } : {}),
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
    return toChatSession(row, 0);
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

    const counts = new Map(
      this.db
        .select({ sessionId: chatMessages.sessionId, value: count() })
        .from(chatMessages)
        .groupBy(chatMessages.sessionId)
        .all()
        .map((row) => [row.sessionId, Number(row.value)]),
    );

    return rows.map((row) =>
      toChatSession(row, counts.get(row.id) ?? 0),
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
    return toChatSession(row, Number(countRow?.value ?? 0));
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
  ): ChatMessageResponse {
    const row = this.db
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
        error: '端侧离线，执行已中断；可以重试',
        updatedAt: now,
      })
      .where(inArray(chatMessages.id, ids))
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
}
