import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import type {
  AgentKind,
  AgentStatus,
  ChatMessageStatus,
  ChatMessageOrigin,
  ChatMessageDecision,
  ChatRole,
  ChatSessionStatus,
  DeviceCapabilities,
  DeviceStats,
  DeviceTransport,
  EngineEventKind,
  EnvStatus,
  FleetWorkspaceStatus,
  LearnedRuleAction,
  LearnedRulePatternType,
  LearnedRuleSource,
  NodeRepo,
  NodeRole,
  PermissionAction,
  PermissionActionKind,
  RuleCandidateStatus,
  TaskEngine,
  TaskLogStream,
  TaskOrigin,
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

    /** Claimed task this decision was raised under, if any. */
    taskId: integer('task_id'),

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
    index('idx_tickets_task').on(table.taskId),
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
 * Which chat runner instance currently owns an env's message queue.
 *
 * The bridge sends a fresh id when a session loop starts. A changed id means
 * the previous process/loop died mid-turn, so messages it left RUNNING can be
 * failed and retried instead of waiting forever.
 */
export const envRunners = sqliteTable('env_runners', {
  env: text('env').primaryKey(),
  runnerId: text('runner_id').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

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
    /** Machine this agent runs on; see `devices`. Null only for legacy rows. */
    deviceId: text('device_id'),

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
    index('idx_agents_device').on(table.deviceId),
  ],
);

/**
 * A machine the hub has seen.
 *
 * Agents are processes; a device is the box they run on. `id` is the key the
 * hub uses: the client's own fingerprint when it reported one, otherwise
 * derived from its hostname. `machineId` stays null until that machine proves
 * it is the one behind the fingerprint, which lets an older client's row be
 * adopted rather than duplicated when it upgrades.
 */
export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    /** Client-generated fingerprint (`~/.zhunzou/machine.json`), if ever reported. */
    machineId: text('machine_id'),
    host: text('host'),
    os: text('os'),
    /** JSON inventory: OS/arch, PTY capability, local CLI tools. */
    capabilities: text('capabilities', {
      mode: 'json',
    }).$type<DeviceCapabilities>(),
    /** JSON CPU / memory / load snapshot. */
    deviceStats: text('device_stats', { mode: 'json' }).$type<DeviceStats>(),
    /**
     * Placement profile, kept as columns (not one JSON blob) so the scheduler
     * can rank nodes without loading every card. Null means never reported;
     * the reader substitutes the worker defaults the protocol promises.
     */
    role: text('role').$type<NodeRole>(),
    tags: text('tags', { mode: 'json' }).$type<string[]>(),
    maxConcurrency: integer('max_concurrency'),
    freeMemoryMB: integer('free_memory_mb'),
    repos: text('repos', { mode: 'json' }).$type<NodeRepo[]>(),
    /** ws while a device daemon is attached, http for legacy heartbeat-only bridges. */
    transport: text('transport').$type<DeviceTransport>(),
    lastSeenAt: integer('last_seen_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_devices_machine_id').on(table.machineId),
    index('idx_devices_host').on(table.host),
    index('idx_devices_seen').on(table.lastSeenAt),
  ],
);

/**
 * Command patterns a human already approved (or refused). The L1 guard reads
 * this table instead of the model, so a repeated approval costs no tokens.
 */
export const learnedRules = sqliteTable(
  'learned_rules',
  {
    id: text('id').primaryKey(),
    pattern: text('pattern').notNull(),
    patternType: text('pattern_type').$type<LearnedRulePatternType>().notNull(),
    action: text('action').$type<LearnedRuleAction>().notNull(),
    /** Narrow to one permission kind; null matches any kind. */
    kind: text('kind').$type<PermissionActionKind>(),
    source: text('source').$type<LearnedRuleSource>().notNull(),
    enabled: integer('enabled').notNull().default(1),
    hits: integer('hits').notNull().default(0),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    // Re-approving the same command updates one row instead of stacking copies.
    uniqueIndex('idx_learned_rules_pattern').on(table.pattern, table.action),
    index('idx_learned_rules_enabled').on(table.enabled),
  ],
);

/**
 * One-time codes that turn "install the bridge" into a single command.
 *
 * Only a hash of the code is stored, so a database leak cannot be replayed.
 * The admin creates a code from the dashboard; the installer exchanges it for
 * a scoped agent token, which means end users never see HUB_SECRET_TOKEN.
 */
export const enrollmentCodes = sqliteTable(
  'enrollment_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    codeHash: text('code_hash').notNull(),
    codePrefix: text('code_prefix').notNull(),
    env: text('env'),
    label: text('label'),
    projectName: text('project_name'),
    kind: text('kind').$type<AgentKind>(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    usedEnv: text('used_env'),
    usedHost: text('used_host'),
    /** One machine, several clients: each redemption consumes one slot. */
    maxUses: integer('max_uses').notNull().default(1),
    useCount: integer('use_count').notNull().default(0),
    /** JSON array of envs this code has produced, for auditing. */
    usedEnvs: text('used_envs'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_enrollment_code_hash').on(table.codeHash),
    index('idx_enrollment_expires').on(table.expiresAt),
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
    /** Repository the scheduler routed this task on. */
    repoName: text('repo_name'),
    /** Which local CLI runs it. */
    engine: text('engine').$type<TaskEngine>(),
    origin: text('origin').$type<TaskOrigin>().notNull().default('HUB_DISPATCH'),
    /** Engine-native session id, so a resumed task continues in place. */
    sessionId: text('session_id'),
    /** Whether the hub supervisor may answer this task's requests unattended. */
    managedBySupervisor: integer('managed_by_supervisor')
      .notNull()
      .default(0),
    /** L2 self-healing retries so far; the circuit breaker compares it to its ceiling. */
    retryCount: integer('retry_count').notNull().default(0),
    /** Absolute path on the node that ran it; the hub only stores the string. */
    workspacePath: text('workspace_path'),
    /** The L2 fix prompt the next claim hands to the engine, then clears. */
    fixPrompt: text('fix_prompt'),

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
    index('idx_agent_tasks_repo').on(table.repoName),
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
    /** Normalised error text, so two retries can be compared for a dead loop. */
    errorSignature: text('error_signature'),
    /** The L2 diagnosis in one line, kept beside the line it explains. */
    diagnosis: text('diagnosis'),
    /** Git diff hash that produced this line, so unchanged work shows up. */
    diffHash: text('diff_hash'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_task_logs_task').on(table.taskId, table.id)],
);

/**
 * Normalised engine events for a claimed task (bounded by the server).
 *
 * `task_logs` keeps what the human reads; this keeps the three facts the hub
 * acts on, so a parked run can be resumed and an audited later.
 */
export const taskEvents = sqliteTable(
  'task_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id').notNull(),
    kind: text('kind').$type<EngineEventKind>().notNull(),
    engine: text('engine').$type<TaskEngine>(),
    tool: text('tool'),
    /** The engine-native id, mirrored onto the task so the next claim carries it. */
    sessionId: text('session_id'),
    /** JSON `permissionActionSchema`: what the engine wanted approved. */
    action: text('action', { mode: 'json' }).$type<PermissionAction>(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_task_events_task').on(table.taskId, table.id)],
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
    /** `AUTO` when the hub adopted it, `HUMAN` when a person did. */
    decision: text('decision').$type<ChatMessageDecision>(),
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

export const fleetCandidates = sqliteTable(
  'fleet_candidates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    host: text('host').notNull(),
    path: text('path').notNull(),
    projectName: text('project_name').notNull(),
    env: text('env').notNull(),
    adapter: text('adapter'),
    associated: integer('associated', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_fleet_candidates_host_path').on(table.host, table.path),
    index('idx_fleet_candidates_host').on(table.host),
  ],
);

export const fleetWorkspaces = sqliteTable(
  'fleet_workspaces',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    host: text('host').notNull(),
    env: text('env').notNull(),
    path: text('path').notNull(),
    projectName: text('project_name').notNull(),
    adapter: text('adapter'),
    status: text('status').$type<FleetWorkspaceStatus>().notNull(),
    error: text('error'),
    token: text('token'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_fleet_workspaces_host_path').on(table.host, table.path),
    uniqueIndex('idx_fleet_workspaces_env').on(table.env),
    index('idx_fleet_workspaces_host').on(table.host),
    index('idx_fleet_workspaces_status').on(table.status),
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
export type LearnedRuleRow = typeof learnedRules.$inferSelect;
export type LearnedRuleInsert = typeof learnedRules.$inferInsert;
export type RuleCandidateInsert = typeof ruleCandidates.$inferInsert;
export type TicketInsert = typeof tickets.$inferInsert;
export type HeartbeatRow = typeof envHeartbeats.$inferSelect;
export type EnvRunnerRow = typeof envRunners.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type AgentInsert = typeof agents.$inferInsert;
export type DeviceRow = typeof devices.$inferSelect;
export type EnrollmentRow = typeof enrollmentCodes.$inferSelect;
export type EnrollmentInsert = typeof enrollmentCodes.$inferInsert;
export type AgentTaskRow = typeof agentTasks.$inferSelect;
export type AgentTaskInsert = typeof agentTasks.$inferInsert;
export type TaskLogRow = typeof taskLogs.$inferSelect;
export type TaskEventRow = typeof taskEvents.$inferSelect;
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
export type FleetCandidateRow = typeof fleetCandidates.$inferSelect;
export type FleetCandidateInsert = typeof fleetCandidates.$inferInsert;
export type FleetWorkspaceRow = typeof fleetWorkspaces.$inferSelect;
export type FleetWorkspaceInsert = typeof fleetWorkspaces.$inferInsert;
