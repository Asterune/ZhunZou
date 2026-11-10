import type {
  AgentKind,
  AgentTask,
  DecisionTicket,
  EnvHeartbeat,
  EnvStatus,
  TaskStatus,
  TicketStatus,
} from '@zhunzou/shared';

import { t } from './i18n';

export function ticketStatusLabel(status: TicketStatus): string {
  return t(`ticketStatus.${status}`);
}

export const TICKET_STATUS_CLASSES: Record<TicketStatus, string> = {
  PENDING_META:
    'bg-surface-container-high text-on-surface-variant ring-1 ring-inset ring-outline-variant/60',
  PENDING_HUMAN:
    'bg-tertiary-fixed text-on-tertiary-fixed ring-1 ring-inset ring-tertiary/15',
  AUTO_RESOLVED:
    'bg-secondary-container text-on-secondary-container ring-1 ring-inset ring-secondary/15',
  HUMAN_RESOLVED:
    'bg-secondary-container text-on-secondary-container ring-1 ring-inset ring-secondary/15',
  CANCELLED:
    'bg-surface-container text-on-surface-variant ring-1 ring-inset ring-outline-variant/60',
};

export function taskStatusLabel(status: TaskStatus): string {
  return t(`taskStatus.${status}`);
}

export const TASK_STATUS_CLASSES: Record<TaskStatus, string> = {
  PENDING:
    'bg-tertiary-fixed text-on-tertiary-fixed ring-1 ring-inset ring-tertiary/15',
  CLAIMED:
    'bg-secondary-container text-on-secondary-container ring-1 ring-inset ring-secondary/15',
  DONE: 'bg-secondary-container text-on-secondary-container ring-1 ring-inset ring-secondary/15',
  FAILED:
    'bg-error-container text-on-error-container ring-1 ring-inset ring-error/15',
  CANCELLED:
    'bg-surface-container text-on-surface-variant ring-1 ring-inset ring-outline-variant/60',
};

export function isActiveTask(task: AgentTask): boolean {
  return task.status === 'PENDING' || task.status === 'CLAIMED';
}

export function envStatusLabel(status: EnvStatus): string {
  return t(`envStatus.${status}`);
}

export const ENV_STATUS_CLASSES: Record<EnvStatus, string> = {
  Running: 'bg-secondary-container text-on-secondary-container',
  Blocked: 'bg-tertiary-fixed text-on-tertiary-fixed',
  Idle: 'bg-surface-container-high text-on-surface-variant',
};

export const ENV_DOT_CLASSES: Record<EnvStatus, string> = {
  Running: 'bg-secondary',
  Blocked: 'bg-tertiary',
  Idle: 'bg-outline',
};

export function isAwaitingTicket(ticket: DecisionTicket): boolean {
  return ticket.status === 'PENDING_META' || ticket.status === 'PENDING_HUMAN';
}

export function isTerminalTicket(ticket: DecisionTicket): boolean {
  return (
    ticket.status === 'AUTO_RESOLVED' ||
    ticket.status === 'HUMAN_RESOLVED' ||
    ticket.status === 'CANCELLED'
  );
}

export function optionLabel(ticket: DecisionTicket, key: string | undefined): string {
  if (!key) return '—';
  return ticket.options.find((option) => option.key === key)?.label ?? key;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatDate(timestamp: number): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Compact countdown label for the auto-resolve SLA. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00';

  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

export function formatDateTime(timestamp: number): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  return `${formatDate(timestamp)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Human-friendly relative time for dashboard labels. */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  if (!timestamp) return '—';

  const diff = now - timestamp;
  if (diff <= 0) return t('time.justNow');

  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return t('time.justNow');
  if (seconds < 60) return t('time.secondsAgo', { count: seconds });

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { count: hours });

  const days = Math.floor(hours / 24);
  if (days < 7) return t('time.daysAgo', { count: days });

  return formatDate(timestamp);
}

/** Coarse elapsed time, for "this process has been up for…" labels. */
export function formatUptime(ms: number): string {
  if (ms < 0) return t('time.justNow');
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return t('time.secondsAgo', { count: Math.max(seconds, 1) });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { count: hours });
  return t('time.daysAgo', { count: Math.floor(hours / 24) });
}

/**
 * Client types are product names, so only the catch-all needs translating.
 * A hub may know a type this board was built without; it shows as its id.
 */
const CLIENT_KIND_LABELS: Record<AgentKind, string> = {
  cursor: 'Cursor',
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  qoder: 'Qoder',
  windsurf: 'Windsurf',
  other: 'Other',
};

export function clientKindLabel(kind: AgentKind): string {
  if (kind === 'other') return t('agents.kind.other');
  return CLIENT_KIND_LABELS[kind] ?? kind;
}

export function envDotClass(env: EnvHeartbeat): string {
  return env.online ? ENV_DOT_CLASSES[env.status] : 'bg-outline-variant';
}

export function envBadgeClass(env: EnvHeartbeat): string {
  return env.online
    ? ENV_STATUS_CLASSES[env.status]
    : 'bg-surface-container text-on-surface-variant';
}
