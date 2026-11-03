import type {
  AgentTask,
  DecisionTicket,
  EnvHeartbeat,
  EnvStatus,
  TaskStatus,
  TicketStatus,
} from '@zhunzou/shared';

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  PENDING_META: '总管预审中',
  PENDING_HUMAN: '待批奏折',
  AUTO_RESOLVED: '总管准奏',
  HUMAN_RESOLVED: '人工准奏',
  CANCELLED: '已取消',
};

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

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  PENDING: '待领取',
  CLAIMED: '执行中',
  DONE: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
};

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

export const ENV_STATUS_LABELS: Record<EnvStatus, string> = {
  Running: '运行中',
  Blocked: '等待决策',
  Idle: '空闲',
};

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
  if (diff <= 0) return '刚刚';

  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;

  return formatDate(timestamp);
}

export function envDotClass(env: EnvHeartbeat): string {
  return env.online ? ENV_DOT_CLASSES[env.status] : 'bg-outline-variant';
}

export function envBadgeClass(env: EnvHeartbeat): string {
  return env.online
    ? ENV_STATUS_CLASSES[env.status]
    : 'bg-surface-container text-on-surface-variant';
}
