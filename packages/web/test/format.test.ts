import { beforeEach, describe, expect, it } from 'vitest';

import type { AgentTask, DecisionTicket, EnvHeartbeat } from '@zhunzou/shared';

import {
  envBadgeClass,
  envDotClass,
  envStatusLabel,
  formatCountdown,
  formatDate,
  formatDateTime,
  isActiveTask,
  isAwaitingTicket,
  isTerminalTicket,
  optionLabel,
  relativeTime,
  taskStatusLabel,
  ticketStatusLabel,
} from '../src/lib/format';
import { setLocale } from '../src/lib/i18n';

beforeEach(() => {
  setLocale('zh');
});

function ticket(overrides: Partial<DecisionTicket> = {}): DecisionTicket {
  return {
    id: '104',
    env: 'company-cursor',
    projectName: 'yikuaomed-erp',
    status: 'PENDING_HUMAN',
    doneSummary: '完成登录页',
    blockerQuestion: 'Toast 还是行内？',
    nextStepPlan: '接入错误处理',
    options: [
      { key: 'A', label: 'Toast 提示' },
      { key: 'B', label: '行内文案' },
    ],
    recommendedOption: 'A',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function env(overrides: Partial<EnvHeartbeat> = {}): EnvHeartbeat {
  return {
    env: 'company-cursor',
    status: 'Running',
    lastSeenAt: 1,
    online: true,
    ...overrides,
  };
}

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: '12',
    env: 'company-windows',
    title: '给登录页补错误提示',
    instruction: '统一使用行内文案。',
    status: 'PENDING',
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('status helpers', () => {
  it('labels every task status', () => {
    expect(taskStatusLabel('PENDING')).toBe('待领取');
    expect(taskStatusLabel('CLAIMED')).toBe('执行中');
    expect(taskStatusLabel('DONE')).toBe('已完成');
    expect(taskStatusLabel('FAILED')).toBe('失败');
    expect(taskStatusLabel('CANCELLED')).toBe('已取消');
  });

  it('classifies active tasks', () => {
    expect(isActiveTask(task())).toBe(true);
    expect(isActiveTask(task({ status: 'CLAIMED' }))).toBe(true);
    expect(isActiveTask(task({ status: 'DONE' }))).toBe(false);
    expect(isActiveTask(task({ status: 'FAILED' }))).toBe(false);
    expect(isActiveTask(task({ status: 'CANCELLED' }))).toBe(false);
  });
  it('labels every ticket status', () => {
    expect(ticketStatusLabel('PENDING_HUMAN')).toBe('待批奏折');
    expect(ticketStatusLabel('AUTO_RESOLVED')).toBe('总管准奏');
    expect(ticketStatusLabel('CANCELLED')).toBe('已取消');
  });

  it('labels env statuses', () => {
    expect(envStatusLabel('Running')).toBe('运行中');
    expect(envStatusLabel('Blocked')).toBe('等待决策');
    expect(envStatusLabel('Idle')).toBe('空闲');
  });

  it('switches labels to English', () => {
    setLocale('en');
    expect(ticketStatusLabel('PENDING_HUMAN')).toBe('Awaiting you');
    expect(taskStatusLabel('CLAIMED')).toBe('Running');
    expect(envStatusLabel('Blocked')).toBe('Blocked');
    expect(relativeTime(Date.now() - 5_000)).toBe('just now');
  });

  it('classifies awaiting vs terminal tickets', () => {
    expect(isAwaitingTicket(ticket())).toBe(true);
    expect(isAwaitingTicket(ticket({ status: 'PENDING_META' }))).toBe(true);
    expect(isTerminalTicket(ticket({ status: 'HUMAN_RESOLVED' }))).toBe(true);
    expect(isTerminalTicket(ticket({ status: 'CANCELLED' }))).toBe(true);
    expect(isTerminalTicket(ticket())).toBe(false);
  });

  it('resolves option labels safely', () => {
    expect(optionLabel(ticket(), 'B')).toBe('行内文案');
    expect(optionLabel(ticket(), 'Z')).toBe('Z');
    expect(optionLabel(ticket(), undefined)).toBe('—');
  });
});

describe('relativeTime', () => {
  const now = new Date(2026, 5, 15, 12, 0, 0).getTime();

  it('handles empty and future timestamps', () => {
    expect(relativeTime(0, now)).toBe('—');
    expect(relativeTime(now + 5_000, now)).toBe('刚刚');
  });

  it('renders seconds, minutes, hours and days', () => {
    expect(relativeTime(now - 5_000, now)).toBe('刚刚');
    expect(relativeTime(now - 25_000, now)).toBe('25 秒前');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2 天前');
  });

  it('falls back to an absolute date after a week', () => {
    expect(relativeTime(now - 30 * 86_400_000, now)).toBe('2026-05-16');
  });
});

describe('formatCountdown', () => {
  it('renders mm:ss and h:mm:ss, and clamps at zero', () => {
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(-5_000)).toBe('00:00');
    expect(formatCountdown(65_000)).toBe('01:05');
    expect(formatCountdown(3_725_000)).toBe('1:02:05');
  });
});

describe('date formatting', () => {
  it('formats local dates and datetimes', () => {
    const timestamp = new Date(2026, 0, 2, 3, 4, 0).getTime();
    expect(formatDate(timestamp)).toBe('2026-01-02');
    expect(formatDateTime(timestamp)).toBe('2026-01-02 03:04');
    expect(formatDate(0)).toBe('—');
  });
});

describe('env visual helpers', () => {
  it('uses status colors only while online', () => {
    expect(envDotClass(env({ status: 'Running' }))).toBe('bg-secondary');
    expect(envDotClass(env({ status: 'Blocked' }))).toBe('bg-tertiary');
    expect(envDotClass(env({ online: false }))).toBe('bg-outline-variant');
    expect(envBadgeClass(env({ online: false }))).toContain('bg-surface-container');
  });
});
