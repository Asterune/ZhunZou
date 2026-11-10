import { describe, expect, it } from 'vitest';

import type { ChatMessage, DecisionTicket } from '@zhunzou/shared';

import {
  queuedUserMessages,
  ticketsForSession,
} from '../src/lib/chat';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: '1',
    sessionId: '7',
    role: 'user',
    content: 'hello',
    status: 'PENDING',
    origin: 'human',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function ticket(overrides: Partial<DecisionTicket> = {}): DecisionTicket {
  return {
    id: '104',
    env: 'company-cursor',
    projectName: 'erp',
    status: 'PENDING_HUMAN',
    doneSummary: 'done',
    blockerQuestion: 'which one?',
    nextStepPlan: 'ship it',
    options: [
      { key: 'A', label: 'A' },
      { key: 'B', label: 'B' },
    ],
    recommendedOption: 'A',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('ticketsForSession', () => {
  it('returns nothing without a session', () => {
    expect(ticketsForSession(null, [ticket()])).toEqual([]);
  });

  it('matches the session environment and project', () => {
    const tickets = [
      ticket({ id: '1', env: 'company-cursor', projectName: 'erp' }),
      ticket({ id: '2', env: 'company-cursor', projectName: 'crm' }),
      ticket({ id: '3', env: 'company-claude', projectName: 'erp' }),
    ];

    expect(
      ticketsForSession(
        { env: 'company-cursor', projectName: 'erp' },
        tickets,
      ).map((item) => item.id),
    ).toEqual(['1']);
  });

  it('falls back to the whole environment when the chat has no project', () => {
    const tickets = [
      ticket({ id: '1', env: 'company-cursor', projectName: 'erp' }),
      ticket({ id: '2', env: 'company-cursor', projectName: 'crm' }),
      ticket({ id: '3', env: 'company-claude', projectName: 'erp' }),
    ];

    expect(
      ticketsForSession(
        { env: 'company-cursor', projectName: '' },
        tickets,
      ).map((item) => item.id),
    ).toEqual(['1', '2']);
  });
});

describe('queuedUserMessages', () => {
  it('only queues user messages that are still pending', () => {
    const messages = [
      message({ id: '1', status: 'DONE' }),
      message({ id: '2', status: 'PENDING' }),
      message({ id: '3', role: 'assistant', status: 'PENDING' }),
    ];

    expect(queuedUserMessages(messages).map((item) => item.id)).toEqual(['2']);
  });
});
