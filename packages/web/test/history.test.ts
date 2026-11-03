import { describe, expect, it } from 'vitest';

import type { DecisionTicket } from '@zhunzou/shared';

import {
  filterHistory,
  HISTORY_FILTERS,
  ticketSearchText,
} from '../src/lib/history';

function ticket(overrides: Partial<DecisionTicket> = {}): DecisionTicket {
  return {
    id: '104',
    env: 'company-cursor',
    projectName: 'yikuaomed-erp',
    status: 'HUMAN_RESOLVED',
    doneSummary: '完成登录页',
    blockerQuestion: 'Toast 还是行内？',
    nextStepPlan: '接入错误处理',
    options: [
      { key: 'A', label: 'Toast 提示' },
      { key: 'B', label: '行内文案' },
    ],
    recommendedOption: 'A',
    selectedOption: 'B',
    resolvedBy: 'HUMAN',
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  };
}

const tickets = [
  ticket(),
  ticket({
    id: '103',
    projectName: 'payment-service',
    status: 'AUTO_RESOLVED',
    blockerQuestion: '是否引入 Redis 锁？',
    selectedOption: 'A',
    resolvedBy: 'META_AGENT',
    resolutionReason: '符合规范',
  }),
  ticket({
    id: '102',
    projectName: 'infra',
    status: 'CANCELLED',
    selectedOption: undefined,
    resolvedBy: undefined,
    blockerQuestion: '是否开放生产权限？',
  }),
  ticket({
    id: '101',
    projectName: 'ops',
    status: 'AUTO_RESOLVED',
    options: [
      { key: 'A', label: '自动重试' },
      { key: 'B', label: '人工介入' },
    ],
    resolvedBy: 'TIMEOUT',
    resolutionReason: '超过自动裁决时限',
  }),
];

describe('filterHistory', () => {
  it('exposes all real filters', () => {
    expect(HISTORY_FILTERS.map((item) => item.key)).toEqual([
      'all',
      'human',
      'meta',
      'timeout',
      'cancelled',
    ]);
  });

  it('filters by resolver and cancellation', () => {
    expect(filterHistory(tickets, '', 'all')).toHaveLength(4);
    expect(filterHistory(tickets, '', 'human').map((item) => item.id)).toEqual(['104']);
    expect(filterHistory(tickets, '', 'meta').map((item) => item.id)).toEqual(['103']);
    expect(filterHistory(tickets, '', 'timeout').map((item) => item.id)).toEqual([
      '101',
    ]);
    expect(filterHistory(tickets, '', 'cancelled').map((item) => item.id)).toEqual([
      '102',
    ]);
  });

  it('searches project, question, option label and reason', () => {
    expect(filterHistory(tickets, 'payment', 'all').map((item) => item.id)).toEqual([
      '103',
    ]);
    expect(filterHistory(tickets, 'redis', 'all').map((item) => item.id)).toEqual([
      '103',
    ]);
    expect(filterHistory(tickets, '行内文案', 'all').map((item) => item.id)).toEqual([
      '104',
    ]);
    expect(filterHistory(tickets, '符合规范', 'all')).toHaveLength(1);
  });

  it('combines search and filter, and ignores surrounding spaces', () => {
    expect(filterHistory(tickets, '  redis  ', 'human')).toHaveLength(0);
    expect(filterHistory(tickets, '  redis  ', 'meta')).toHaveLength(1);
  });

  it('builds a lowercase search corpus', () => {
    const text = ticketSearchText(ticket());
    expect(text).toContain('104');
    expect(text).toContain('yikuaomed-erp');
    expect(text).toContain('行内文案');
  });
});
