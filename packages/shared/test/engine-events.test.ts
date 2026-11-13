import { describe, expect, it } from 'vitest';

import {
  agentTaskSchema,
  ENGINE_EVENT_KINDS,
  engineEventSchema,
  engineSessionIdSchema,
  listTaskEventsQuerySchema,
  reportTaskEventsSchema,
  taskEventSchema,
} from '../src/index.js';

describe('engineEventSchema', () => {
  it('normalises the three kinds the blueprint asks for', () => {
    expect(ENGINE_EVENT_KINDS).toEqual([
      'tool_call',
      'permission_required',
      'session',
    ]);
  });

  it('accepts a tool call that names its tool and engine', () => {
    const parsed = engineEventSchema.parse({
      kind: 'tool_call',
      engine: 'claude-code',
      tool: 'Bash',
    });
    expect(parsed).toEqual({
      kind: 'tool_call',
      engine: 'claude-code',
      tool: 'Bash',
    });
  });

  it('requires the session id on a session event', () => {
    expect(
      engineEventSchema.safeParse({ kind: 'session', engine: 'qoder' }).success,
    ).toBe(false);
    expect(
      engineEventSchema.safeParse({
        kind: 'session',
        sessionId: 'abc-123',
      }).success,
    ).toBe(true);
  });

  it('requires a tool name on a tool call event', () => {
    expect(engineEventSchema.safeParse({ kind: 'tool_call' }).success).toBe(
      false,
    );
  });

  it('accepts a permission request with an action or with only a tool name', () => {
    expect(
      engineEventSchema.safeParse({
        kind: 'permission_required',
        tool: 'Bash',
        action: { kind: 'command', command: 'rm -rf /' },
      }).success,
    ).toBe(true);
    expect(
      engineEventSchema.safeParse({
        kind: 'permission_required',
        tool: 'Write',
      }).success,
    ).toBe(true);
    expect(
      engineEventSchema.safeParse({ kind: 'permission_required' }).success,
    ).toBe(false);
  });

  it('re-derives outsideWorkspace instead of trusting the reported flag', () => {
    const parsed = engineEventSchema.parse({
      kind: 'permission_required',
      action: {
        kind: 'file_change',
        paths: ['/Users/qiliu/code/pte-dojo/src/App.vue', '~/.ssh/id_rsa'],
        workspaceRoot: '/Users/qiliu/code/pte-dojo',
        outsideWorkspace: false,
      },
    });
    expect(parsed.action?.outsideWorkspace).toBe(true);
  });

  it('rejects an unknown engine', () => {
    expect(
      engineEventSchema.safeParse({
        kind: 'tool_call',
        engine: 'midjourney',
        tool: 'paint',
      }).success,
    ).toBe(false);
  });
});

describe('engineSessionIdSchema', () => {
  it('keeps ids that are safe to hand to a child process as an argument', () => {
    for (const value of ['abc-123', 'ses.deadbeef', 'session_1-x.2']) {
      expect(engineSessionIdSchema.safeParse(value).success, value).toBe(true);
    }
  });

  it('rejects ids that could carry an option, a space, or a shell metacharacter', () => {
    for (const value of [
      '--resume=other',
      '-x',
      'has space',
      '$(id)',
      '/Users/me/.claude/sessions/abc',
      'a'.repeat(129),
      '',
    ]) {
      expect(engineSessionIdSchema.safeParse(value).success, value).toBe(false);
    }
  });
});

describe('reportTaskEventsSchema', () => {
  const event = { kind: 'tool_call', tool: 'Read' } as const;

  it('accepts a batch and rejects an empty or oversized one', () => {
    expect(reportTaskEventsSchema.safeParse({ events: [event] }).success).toBe(
      true,
    );
    expect(reportTaskEventsSchema.safeParse({ events: [] }).success).toBe(false);
    expect(
      reportTaskEventsSchema.safeParse({
        events: Array.from({ length: 51 }, () => event),
      }).success,
    ).toBe(false);
    expect(
      reportTaskEventsSchema.safeParse({
        events: Array.from({ length: 50 }, () => event),
      }).success,
    ).toBe(true);
  });

  it('rejects a batch where a single event is unusable', () => {
    expect(
      reportTaskEventsSchema.safeParse({
        events: [event, { kind: 'session' }],
      }).success,
    ).toBe(false);
  });
});

describe('taskEventSchema', () => {
  it('reads back a stored event with its hub-side identity', () => {
    const parsed = taskEventSchema.parse({
      id: 7,
      taskId: '12',
      kind: 'session',
      engine: 'cursor',
      sessionId: 'abc-123',
      createdAt: 1_700_000_000_000,
    });
    expect(parsed.taskId).toBe('12');
    expect(parsed.sessionId).toBe('abc-123');
  });

  it('still accepts an event that carries no engine', () => {
    expect(
      taskEventSchema.safeParse({
        id: 1,
        taskId: '1',
        kind: 'tool_call',
        tool: 'Bash',
        createdAt: 1,
      }).success,
    ).toBe(true);
  });
});

describe('listTaskEventsQuerySchema', () => {
  it('defaults to a fresh tail read and clamps the page size', () => {
    expect(listTaskEventsQuerySchema.parse({})).toEqual({
      after: 0,
      limit: 200,
    });
    expect(listTaskEventsQuerySchema.parse({ after: '12', limit: '500' })).toEqual(
      { after: 12, limit: 500 },
    );
    expect(listTaskEventsQuerySchema.safeParse({ limit: 501 }).success).toBe(
      false,
    );
  });
});

describe('agentTaskSchema', () => {
  it('keeps sessionId optional so existing task payloads still parse', () => {
    const base = {
      id: '1',
      env: 'claude-code-pte-dojo',
      title: 'Fix the flaky test',
      instruction: 'make it green',
      status: 'PENDING',
      attempts: 0,
      origin: 'HUB_DISPATCH',
      managedBySupervisor: false,
      retryCount: 0,
      createdAt: 1,
      updatedAt: 1,
    } as const;

    expect(agentTaskSchema.parse(base).sessionId).toBeUndefined();
    expect(agentTaskSchema.parse({ ...base, sessionId: 'abc-123' }).sessionId).toBe(
      'abc-123',
    );
  });
});
