import { describe, expect, it } from 'vitest';

import type { ChatMessage, DecisionTicket } from '@zhunzou/shared';

import {
  contextUsagePercent,
  dirName,
  isSendShortcut,
  queuedUserMessages,
  sessionProjectMismatch,
  sameProjectName,
  ticketsForSession,
  workspaceForSession,
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

describe('workspaceForSession', () => {
  const workspaces = [
    { env: 'claude-mac', path: '/Users/qiliu/agent-hub', projectName: 'agent-hub' },
    { env: 'cursor-mac', path: '/Users/qiliu/FitAI-', projectName: 'FitAI-' },
  ];

  it('returns the directory of the session env, not its project label', () => {
    expect(
      workspaceForSession(
        { env: 'claude-mac', projectName: 'FitAI-' },
        workspaces,
      ),
    ).toEqual(workspaces[0]);
  });

  it('has nothing to say about an env the hub never reported', () => {
    expect(
      workspaceForSession({ env: 'ghost-mac', projectName: 'FitAI-' }, workspaces),
    ).toBeNull();
    expect(workspaceForSession(null, workspaces)).toBeNull();
  });
});

describe('sessionProjectMismatch', () => {
  const hub = {
    env: 'claude-mac',
    path: '/Users/qiliu/agent-hub',
    projectName: 'agent-hub',
  };

  it('flags a conversation labelled after another project', () => {
    expect(
      sessionProjectMismatch({ env: 'claude-mac', projectName: 'FitAI-' }, hub),
    ).toBe(true);
  });

  it('accepts the label that names the directory', () => {
    expect(
      sessionProjectMismatch({ env: 'claude-mac', projectName: 'agent-hub' }, hub),
    ).toBe(false);
  });

  it('ignores punctuation and case differences', () => {
    expect(sameProjectName('FitAI-', 'fitai')).toBe(true);
    expect(sameProjectName(' agent-hub ', 'Agent-Hub')).toBe(true);
    expect(sameProjectName('agent-hub', 'erp')).toBe(false);
    expect(
      sessionProjectMismatch(
        { env: 'claude-mac', projectName: 'FitAI-' },
        { path: '/Users/qiliu/FitAI', projectName: 'FitAI' },
      ),
    ).toBe(false);
  });

  it('does not guess when the project or directory is unknown', () => {
    expect(sessionProjectMismatch({ env: 'claude-mac' }, hub)).toBe(false);
    expect(
      sessionProjectMismatch({ env: 'claude-mac', projectName: 'FitAI-' }, null),
    ).toBe(false);
  });

  it('falls back to the folder name when the workspace has no label', () => {
    expect(
      sessionProjectMismatch(
        { env: 'claude-mac', projectName: 'agent-hub' },
        { path: '/Users/qiliu/agent-hub/' },
      ),
    ).toBe(false);
  });
});

describe('dirName', () => {
  it('reads the last segment of either path flavour', () => {
    expect(dirName('/Users/qiliu/FitAI-')).toBe('FitAI-');
    expect(dirName('C:\\work\\erp\\')).toBe('erp');
    expect(dirName('')).toBe('');
  });
});

describe('isSendShortcut', () => {
  const key = (overrides: Record<string, unknown>) => ({
    key: 'Enter',
    shiftKey: false,
    isComposing: false,
    ...overrides,
  });

  it('sends on Shift+Enter', () => {
    expect(isSendShortcut(key({ shiftKey: true }))).toBe(true);
  });

  it('leaves bare Enter (and ⌘/Ctrl+Enter) for a newline', () => {
    expect(isSendShortcut(key({}))).toBe(false);
    expect(isSendShortcut(key({ metaKey: true }))).toBe(false);
    expect(isSendShortcut(key({ ctrlKey: true }))).toBe(false);
  });

  it('never sends while an IME is composing', () => {
    expect(isSendShortcut(key({ shiftKey: true, isComposing: true }))).toBe(
      false,
    );
  });

  it('ignores other keys even with a modifier', () => {
    expect(isSendShortcut(key({ key: 'k', shiftKey: true }))).toBe(false);
  });
});

describe('contextUsagePercent', () => {
  it('reports the spent share of the budget', () => {
    expect(contextUsagePercent(40_000, 80_000)).toBe(50);
    expect(contextUsagePercent(1, 80_000)).toBe(0);
  });

  it('clamps a spent or unknown budget instead of overflowing', () => {
    expect(contextUsagePercent(200_000, 80_000)).toBe(100);
    expect(contextUsagePercent(undefined, 80_000)).toBe(0);
    expect(contextUsagePercent(40_000, undefined)).toBe(0);
    expect(contextUsagePercent(40_000, 0)).toBe(0);
  });
});
