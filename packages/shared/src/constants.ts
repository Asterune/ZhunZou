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

/** Display helper: 104 -> "#104". */
export function formatTicketId(id: string | number): string {
  return `#${id}`;
}
