/**
 * Shared constants and state-machine helpers.
 * Kept dependency-free so every package (server / bridge / web) can import it.
 */

export const TICKET_STATUSES = [
  'PENDING_META',
  'PENDING_HUMAN',
  'AUTO_RESOLVED',
  'HUMAN_RESOLVED',
  'CANCELLED',
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Statuses after which a ticket never changes again. */
export const TERMINAL_STATUSES = [
  'AUTO_RESOLVED',
  'HUMAN_RESOLVED',
  'CANCELLED',
] as const satisfies readonly TicketStatus[];

/** Statuses that carry an actual decision the client can act on. */
export const RESOLVED_STATUSES = [
  'AUTO_RESOLVED',
  'HUMAN_RESOLVED',
] as const satisfies readonly TicketStatus[];

export const ENV_STATUSES = ['Running', 'Blocked', 'Idle'] as const;
export type EnvStatus = (typeof ENV_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Rule candidates distilled from human approvals                      */
/* ------------------------------------------------------------------ */

export const RULE_CANDIDATE_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'DISMISSED',
] as const;

export type RuleCandidateStatus = (typeof RULE_CANDIDATE_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Ticket option risk                                                  */
/* ------------------------------------------------------------------ */

export const OPTION_RISKS = ['safe', 'caution', 'destructive'] as const;
export type OptionRisk = (typeof OPTION_RISKS)[number];

/* ------------------------------------------------------------------ */
/* Human → Agent task dispatch                                         */
/* ------------------------------------------------------------------ */

export const TASK_STATUSES = [
  'PENDING',
  'CLAIMED',
  /** Waiting for a decision the supervisor may not make on its own. */
  'BLOCKED',
  /** The supervisor ordered a retry; the engine resumes the same session. */
  'HEALING',
  'DONE',
  'FAILED',
  'CANCELLED',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * The blueprint names the same machine QUEUED / RUNNING; the persisted
 * vocabulary predates it, so this map is the single place the two meet.
 */
export const TASK_STATUS_ALIASES = {
  QUEUED: 'PENDING',
  RUNNING: 'CLAIMED',
  BLOCKED: 'BLOCKED',
  HEALING: 'HEALING',
  DONE: 'DONE',
  FAILED: 'FAILED',
} as const satisfies Partial<Record<string, TaskStatus>>;

/** Output streams a claimed task can report while it runs. */
export const TASK_LOG_STREAMS = ['stdout', 'stderr', 'system'] as const;
export type TaskLogStream = (typeof TASK_LOG_STREAMS)[number];

/** Which local CLI actually runs the task; declared with `AGENT_KINDS` below. */
export type TaskEngine = AgentKind;

/** How a task entered the hub: dispatched from the console or wrapped from a local terminal. */
export const TASK_ORIGINS = ['HUB_DISPATCH', 'LOCAL_WRAP'] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

/* ------------------------------------------------------------------ */
/* Interactive sessions                                                */
/* ------------------------------------------------------------------ */

export const CHAT_ROLES = ['user', 'assistant', 'system'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

export const CHAT_MESSAGE_STATUSES = [
  /** Agent-drafted reply waiting for a human to adopt it. */
  'PROPOSED',
  'PENDING',
  'RUNNING',
  'DONE',
  'FAILED',
  /** A draft that was rejected; kept in the transcript for audit. */
  'DISCARDED',
  /** A queued message the human withdrew before the runner claimed it. */
  'CANCELLED',
] as const;
export type ChatMessageStatus = (typeof CHAT_MESSAGE_STATUSES)[number];

/**
 * Who authored a chat message. `agent` marks drafts the hub proposed on the
 * human's behalf, so the transcript never pretends the human typed them.
 */
export const CHAT_MESSAGE_ORIGINS = ['human', 'agent'] as const;
export type ChatMessageOrigin = (typeof CHAT_MESSAGE_ORIGINS)[number];

/**
 * How an agent-authored reply reached the queue: the hub may adopt it on its
 * own (`AUTO`) or a human may adopt it after review (`HUMAN`).
 */
export const CHAT_MESSAGE_DECISIONS = ['AUTO', 'HUMAN'] as const;
export type ChatMessageDecision = (typeof CHAT_MESSAGE_DECISIONS)[number];

/* ------------------------------------------------------------------ */
/* Hub-side judgment                                                   */
/* ------------------------------------------------------------------ */

/** What the agent is asking the hub to rule on. */
export const DECISION_KINDS = ['reply', 'next_step', 'action'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** `APPROVED` = go ahead, `PENDING` = a ticket is waiting for a human. */
export const DECISION_VERDICTS = ['APPROVED', 'PENDING'] as const;
export type DecisionVerdict = (typeof DECISION_VERDICTS)[number];

/** How aggressively the hub decides on its own. */
export const DECISION_MODES = ['off', 'reply', 'all'] as const;
export type DecisionMode = (typeof DECISION_MODES)[number];

export const CHAT_SESSION_STATUSES = ['ACTIVE', 'CLOSED'] as const;
export type ChatSessionStatus = (typeof CHAT_SESSION_STATUSES)[number];

/** Statuses after which a dispatched task never changes again. */
export const TERMINAL_TASK_STATUSES = [
  'DONE',
  'FAILED',
  'CANCELLED',
] as const satisfies readonly TaskStatus[];

/** Statuses that still need agent attention. */
export const ACTIVE_TASK_STATUSES = [
  'PENDING',
  'CLAIMED',
] as const satisfies readonly TaskStatus[];

/** Statuses the decision inbox has to surface: waiting to run, or waiting on someone. */
export const ATTENTION_TASK_STATUSES = [
  'PENDING',
  'CLAIMED',
  'BLOCKED',
  'HEALING',
] as const satisfies readonly TaskStatus[];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return (ACTIVE_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}

export function isAttentionTaskStatus(status: TaskStatus): boolean {
  return (ATTENTION_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}

export function isTerminalStatus(status: TicketStatus): boolean {
  return (TERMINAL_STATUSES as readonly TicketStatus[]).includes(status);
}

export function isResolvedStatus(status: TicketStatus): boolean {
  return (RESOLVED_STATUSES as readonly TicketStatus[]).includes(status);
}

/** Whether a ticket in this status is still waiting for a decision. */
export function isAwaitingDecision(status: TicketStatus): boolean {
  return status === 'PENDING_META' || status === 'PENDING_HUMAN';
}

/** Default long-poll window (ms). Matches the bridge's 40s single request. */
export const DEFAULT_WAIT_TIMEOUT_MS = 40_000;

/** Upper bound for a single long-poll request (keeps proxies happy). */
export const MAX_WAIT_TIMEOUT_MS = 55_000;

/** An env is shown as online if it sent a heartbeat within this window. */
export const HEARTBEAT_ONLINE_WINDOW_MS = 90_000;

/* ------------------------------------------------------------------ */
/* Agent registry                                                      */
/* ------------------------------------------------------------------ */

/** Local clients the dashboard can recognise. */
export const AGENT_KINDS = [
  'cursor',
  'opencode',
  'claude-code',
  'codex',
  'gemini',
  'qoder',
  'windsurf',
  'other',
] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * What a local engine's output stream turns into once the bridge reads it.
 * Three kinds, each with exactly one consumer: `tool_call` for the audit
 * trail, `permission_required` for parking, `session` for resume.
 */
export const ENGINE_EVENT_KINDS = [
  'tool_call',
  'permission_required',
  'session',
] as const;
export type EngineEventKind = (typeof ENGINE_EVENT_KINDS)[number];

/** Re-exported for task records: an engine is the agent kind that runs it. */
export const TASK_ENGINES = AGENT_KINDS;

/** Disabled agents keep their history but their tokens stop working. */
export const AGENT_STATUSES = ['active', 'disabled'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Prefix of every per-agent bearer token issued by the hub. */
export const AGENT_TOKEN_PREFIX = 'zz_';

/** Display helper: 104 -> "#104". */
export function formatTicketId(id: string | number): string {
  return `#${id}`;
}

/* ------------------------------------------------------------------ */
/* Node placement                                                      */
/* ------------------------------------------------------------------ */

/**
 * What a machine is allowed to do. `portal` only observes and approves, so the
 * scheduler must never land work on it; `worker` takes dispatched tasks;
 * `hybrid` does both.
 */
export const NODE_ROLES = ['portal', 'worker', 'hybrid'] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

/** A node reports its profile and free memory this often. */
export const NODE_HEARTBEAT_REPORT_MS = 15_000;

/** The hub drops a node from the routable set after this silence. */
export const NODE_HEARTBEAT_TIMEOUT_MS = 30_000;

/** Below this many free MB a node is not worth loading another task onto. */
export const ROUTE_MIN_FREE_MEMORY_MB = 2048;

/* ------------------------------------------------------------------ */
/* Supervisor                                                          */
/* ------------------------------------------------------------------ */

/** The kinds of effect an agent asks permission for. */
export const PERMISSION_ACTION_KINDS = [
  'command',
  'file_change',
  'delete',
  'git_operation',
  'network',
] as const;
export type PermissionActionKind = (typeof PERMISSION_ACTION_KINDS)[number];

/** What the supervisor finally rules. */
export const SUPERVISOR_DECISIONS = [
  'APPROVE',
  'DENY',
  'RETRY_WITH_FIX',
  'ESCALATE_TO_HUMAN',
] as const;
export type SupervisorDecisionKind = (typeof SUPERVISOR_DECISIONS)[number];

/** Which layer answered: 0ms rules, the LLM diagnosis, or a human. */
export const SUPERVISOR_LAYERS = ['L1', 'L2', 'HUMAN'] as const;
export type SupervisorLayer = (typeof SUPERVISOR_LAYERS)[number];

/** How a learned allowance came to exist. */
export const LEARNED_RULE_SOURCES = [
  'HUMAN_APPROVAL',
  'RULE_DISTILLER',
  'SEED',
] as const;
export type LearnedRuleSource = (typeof LEARNED_RULE_SOURCES)[number];

export const LEARNED_RULE_PATTERN_TYPES = ['exact', 'glob', 'regex'] as const;
export type LearnedRulePatternType = (typeof LEARNED_RULE_PATTERN_TYPES)[number];

export const LEARNED_RULE_ACTIONS = ['ALLOW', 'DENY'] as const;
export type LearnedRuleAction = (typeof LEARNED_RULE_ACTIONS)[number];

/** How long a node may park a permission request before the hub escalates it. */
export const SUPERVISOR_PERMISSION_TIMEOUT_MS = 55_000;

/** The L2 diagnosis is a one-liner for the inbox card, in characters. */
export const DIAGNOSIS_SUMMARY_MAX_CHARS = 50;

