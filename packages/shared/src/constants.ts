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
  'DONE',
  'FAILED',
  'CANCELLED',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Output streams a claimed task can report while it runs. */
export const TASK_LOG_STREAMS = ['stdout', 'stderr', 'system'] as const;
export type TaskLogStream = (typeof TASK_LOG_STREAMS)[number];

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

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return (ACTIVE_TASK_STATUSES as readonly TaskStatus[]).includes(status);
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
  'windsurf',
  'other',
] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

/** Disabled agents keep their history but their tokens stop working. */
export const AGENT_STATUSES = ['active', 'disabled'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Prefix of every per-agent bearer token issued by the hub. */
export const AGENT_TOKEN_PREFIX = 'zz_';

/** Display helper: 104 -> "#104". */
export function formatTicketId(id: string | number): string {
  return `#${id}`;
}
