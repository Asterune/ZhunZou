import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import type {
  AgentKind,
  AgentStatus,
  ChatMessageStatus,
  ChatMessageOrigin,
  ChatRole,
  ChatSessionStatus,
  DeviceCapabilities,
  DeviceStats,
  DeviceTransport,
  EnvStatus,
  RuleCandidateStatus,
  TaskLogStream,
  TaskStatus,
  TerminalAuditKind,
  TerminalSessionStatus,
  TicketOption,
  TicketStatus,
} from '@zhunzou/shared';

export const tickets = sqliteTable(
  'tickets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    env: text('env').notNull(),
    projectName: text('project_name').notNull(),
    status: text('status').$type<TicketStatus>().notNull(),

    doneSummary: text('done_summary').notNull(),
    blockerQuestion: text('blocker_question').notNull(),
    nextStepPlan: text('next_step_plan').notNull(),

    options: text('options', { mode: 'json' }).$type<TicketOption[]>().notNull(),
    recommendedOption: text('recommended_option').notNull(),

    selectedOption: text('selected_option'),
    customInstruction: text('custom_instruction'),
    resolvedBy: text('resolved_by').$type<'META_AGENT' | 'HUMAN' | 'TIMEOUT'>(),
    resolutionReason: text('resolution_reason'),

    /** Auto-resolve deadline; null/undefined disables the SLA. */
    expiresAt: integer('expires_at'),

    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_tickets_status').on(table.status),
    index('idx_tickets_project').on(table.projectName),
    index('idx_tickets_created').on(table.createdAt),
    index('idx_tickets_updated').on(table.updatedAt),
  ],
);

export const envHeartbeats = sqliteTable(
  'env_heartbeats',
  {
    env: text('env').primaryKey(),
    status: text('status').$type<EnvStatus>().notNull(),
    projectName: text('project_name'),
    currentTask: text('current_task'),
    note: text('note'),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (table) => [index('idx_env_heartbeats_seen').on(table.lastSeenAt)],
);

/**
 * Registry of bridges/agents. `env` stays the identity used by tickets and
 * tasks, so existing deployments keep working; the extra columns make agents
 * manageable from the console and let each agent carry its own token.
 */
export const agents = sqliteTable(
  'agents',
  {
    env: text('env').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind').$type<AgentKind>().notNull(),
    status: text('status').$type<AgentStatus>().notNull(),

    version: text('version'),
    host: text('host'),
    os: text('os'),

    /** Realtime device protocol version (null for legacy HTTP bridges). */
    protocolVersion: integer('protocol_version'),
    /** JSON inventory: OS/arch, PTY capability, local CLI tools. */
    capabilities: text('capabilities', { mode: 'json' }).$type<DeviceCapabilities>(),
    /** JSON CPU / memory / load snapshot. */
    deviceStats: text('device_stats', { mode: 'json' }).$type<DeviceStats>(),
    /** ws while a device daemon is attached, http for legacy heartbeat-only bridges. */
    transport: text('transport').$type<DeviceTransport>(),
    /** Start of the current WS connection. */
    connectedAt: integer('connected_at'),

    /** Per-device policy: allow interactive terminals. */
    terminalEnabled: integer('terminal_enabled').notNull().default(1),

    /** sha256(token); the plaintext is returned once at issuance. */
    tokenHash: text('token_hash'),
    tokenPrefix: text('token_prefix'),
    tokenCreatedAt: integer('token_created_at'),

    lastSeenAt: integer('last_seen_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_agents_token_hash').on(table.tokenHash),
    index('idx_agents_status').on(table.status),
    index('idx_agents_kind').on(table.kind),
    index('idx_agents_updated').on(table.updatedAt),
  ],
);

export const agentTasks = sqliteTable(  'agent_tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    env: text('env').notNull(),
    projectName: text('project_name'),
    title: text('title').notNull(),
    instruction: text('instruction').notNull(),
    status: text('status').$type<TaskStatus>().notNull(),
    attempts: integer('attempts').notNull().default(0),

    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    claimedAt: integer('claimed_at'),
    /** Last time the agent proved it is still working on the task. */
    leaseAt: integer('lease_at'),
    completedAt: integer('completed_at'),
    result: text('result'),
  },
  (table) => [
    index('idx_agent_tasks_status').on(table.status),
    index('idx_agent_tasks_env').on(table.env),
    index('idx_agent_tasks_created').on(table.createdAt),
    index('idx_agent_tasks_updated').on(table.updatedAt),
  ],
);

/** Append-only execution output for a claimed task (bounded by the server). */
export const taskLogs = sqliteTable(
  'task_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id').notNull(),
    stream: text('stream').$type<TaskLogStream>().notNull(),
    chunk: text('chunk').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_task_logs_task').on(table.taskId, table.id)],
);

export const chatSessions = sqliteTable(
  'chat_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    env: text('env').notNull(),
    projectName: text('project_name'),
    title: text('title').notNull(),
    status: text('status').$type<ChatSessionStatus>().notNull(),
    /** CLI-native session id (OpenCode --session / Cursor --resume). */
    externalId: text('external_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastMessageAt: integer('last_message_at'),
  },
  (table) => [
    index('idx_chat_sessions_env').on(table.env),
    index('idx_chat_sessions_status').on(table.status),
    index('idx_chat_sessions_updated').on(table.updatedAt),
  ],
);

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id').notNull(),
    role: text('role').$type<ChatRole>().notNull(),
    content: text('content').notNull(),
    status: text('status').$type<ChatMessageStatus>().notNull(),
    /** `human` for typed messages, `agent` for hub-drafted proposals. */
    origin: text('origin').$type<ChatMessageOrigin>().notNull().default('human'),
    /** Why the agent drafted this reply; null for human messages. */
    rationale: text('rationale'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_chat_messages_session').on(table.sessionId, table.id),
    index('idx_chat_messages_status').on(table.status),
    index('idx_chat_messages_updated').on(table.updatedAt),
  ],
);

export const chatEvents = sqliteTable(
  'chat_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id').notNull(),
    messageId: integer('message_id').notNull(),
    stream: text('stream').$type<TaskLogStream>().notNull(),
    chunk: text('chunk').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_chat_events_session').on(table.sessionId, table.id),
  ],
);

/** Terminal sessions are the PTY equivalent of chat sessions. */
export const terminalSessions = sqliteTable(
  'terminal_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    env: text('env').notNull(),
    projectName: text('project_name'),
    title: text('title').notNull(),
    shell: text('shell'),
    cwd: text('cwd'),
    cols: integer('cols').notNull(),
    rows: integer('rows').notNull(),
    status: text('status').$type<TerminalSessionStatus>().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastActiveAt: integer('last_active_at').notNull(),
    closedAt: integer('closed_at'),
    exitCode: integer('exit_code'),
    error: text('error'),
  },
  (table) => [
    index('idx_terminal_sessions_env').on(table.env),
    index('idx_terminal_sessions_status').on(table.status),
    index('idx_terminal_sessions_updated').on(table.updatedAt),
  ],
);

/** Audited actions on terminal sessions (input, claim, resize, close). */
export const terminalAudit = sqliteTable(
  'terminal_audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id').notNull(),
    env: text('env').notNull(),
    kind: text('kind').$type<TerminalAuditKind>().notNull(),
    viewerId: text('viewer_id'),
    data: text('data'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_terminal_audit_session').on(table.sessionId, table.id),
    index('idx_terminal_audit_env').on(table.env),
    index('idx_terminal_audit_created').on(table.createdAt),
  ],
);

export const exchanges = sqliteTable(
  'exchanges',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    env: text('env').notNull(),
    projectName: text('project_name'),
    question: text('question'),
    conclusion: text('conclusion'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_exchanges_env').on(table.env, table.id),
    index('idx_exchanges_project').on(table.projectName, table.id),
    index('idx_exchanges_created').on(table.createdAt),
  ],
);

export const workspaceProjects = sqliteTable(
  'workspace_projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    env: text('env').notNull(),
    projectName: text('project_name').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_workspace_projects_env_project').on(
      table.env,
      table.projectName,
    ),
    index('idx_workspace_projects_env').on(table.env),
  ],
);

export const ruleCandidates = sqliteTable(
  'rule_candidates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ticketId: integer('ticket_id').notNull(),
    content: text('content').notNull(),
    status: text('status').$type<RuleCandidateStatus>().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_rule_candidates_status').on(table.status),
    index('idx_rule_candidates_ticket').on(table.ticketId),
    index('idx_rule_candidates_created').on(table.createdAt),
  ],
);

export type TicketRow = typeof tickets.$inferSelect;
export type RuleCandidateRow = typeof ruleCandidates.$inferSelect;
export type RuleCandidateInsert = typeof ruleCandidates.$inferInsert;
export type TicketInsert = typeof tickets.$inferInsert;
export type HeartbeatRow = typeof envHeartbeats.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type AgentInsert = typeof agents.$inferInsert;
export type AgentTaskRow = typeof agentTasks.$inferSelect;
export type AgentTaskInsert = typeof agentTasks.$inferInsert;
export type TaskLogRow = typeof taskLogs.$inferSelect;
export type TaskLogInsert = typeof taskLogs.$inferInsert;
export type ChatSessionRow = typeof chatSessions.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type ChatEventRow = typeof chatEvents.$inferSelect;
export type ExchangeRow = typeof exchanges.$inferSelect;
export type ExchangeInsert = typeof exchanges.$inferInsert;
export type TerminalSessionRow = typeof terminalSessions.$inferSelect;
export type TerminalSessionInsert = typeof terminalSessions.$inferInsert;
export type TerminalAuditRow = typeof terminalAudit.$inferSelect;
export type TerminalAuditInsert = typeof terminalAudit.$inferInsert;
export type WorkspaceProjectRow = typeof workspaceProjects.$inferSelect;
export type WorkspaceProjectInsert = typeof workspaceProjects.$inferInsert;
