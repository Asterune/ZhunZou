import { describe, expect, it } from 'vitest';

import {
  SUPERVISOR_PERMISSION_TIMEOUT_MS,
  decisionTicketSchema,
  taskEventSchema,
  type DecisionTicket,
  type PermissionActionInput,
  type TaskEvent,
  type TicketOption,
} from '@zhunzou/shared';

import { approveOptionFor, selectPermissionAction } from '../src/supervisor/guard.js';

const CREATED = 1_700_000_000_000;

function event(overrides: Record<string, unknown>): TaskEvent {
  return taskEventSchema.parse({
    taskId: '1',
    kind: 'permission_required',
    createdAt: CREATED,
    ...overrides,
  });
}

function permission(id: number, at: number, action: PermissionActionInput): TaskEvent {
  return event({ id, createdAt: at, action });
}

function ticket(options: TicketOption[], overrides: Record<string, unknown> = {}): DecisionTicket {
  return decisionTicketSchema.parse({
    id: '9',
    env: 'company-cursor',
    projectName: 'yikuaomed-erp',
    status: 'PENDING_META',
    doneSummary: '跑到需要批准的一步',
    blockerQuestion: '是否允许执行？',
    nextStepPlan: '批准后原地续跑。',
    options,
    recommendedOption: options[options.length - 1]!.key,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  });
}

const RM_RF: PermissionActionInput = { kind: 'command', command: 'rm -rf dist' };

describe('linking a ticket to the permission it was raised for', () => {
  it('P1 picks the request the ticket followed', () => {
    const events = [
      event({ id: 1, kind: 'tool_call', tool: 'Read', createdAt: CREATED - 4_000 }),
      permission(2, CREATED - 3_000, RM_RF),
      event({ id: 3, kind: 'session', sessionId: 'sess-1', createdAt: CREATED - 2_000 }),
    ];
    expect(selectPermissionAction(events, { ticketCreatedAt: CREATED, now: CREATED })).toMatchObject({
      command: 'rm -rf dist',
    });
  });

  it('P2 answers the newest request, not the oldest', () => {
    const events = [
      permission(1, CREATED - 5_000, { kind: 'command', command: 'git status' }),
      permission(2, CREATED - 4_000, RM_RF),
    ];
    expect(
      selectPermissionAction(events, { ticketCreatedAt: CREATED, now: CREATED })?.command,
    ).toBe('rm -rf dist');
  });

  it('P3 refuses a request that arrived after the ticket was already open', () => {
    const events = [permission(1, CREATED + 60_000, RM_RF)];
    expect(
      selectPermissionAction(events, { ticketCreatedAt: CREATED, now: CREATED + 61_000 }),
    ).toBeUndefined();
  });

  it('P4 refuses to rule on a request nobody is waiting for any more', () => {
    const events = [permission(1, CREATED, RM_RF)];
    expect(
      selectPermissionAction(events, {
        ticketCreatedAt: CREATED,
        now: CREATED + SUPERVISOR_PERMISSION_TIMEOUT_MS + 1,
      }),
    ).toBeUndefined();
    expect(
      selectPermissionAction(events, {
        ticketCreatedAt: CREATED,
        now: CREATED + SUPERVISOR_PERMISSION_TIMEOUT_MS,
      }),
    ).toBeDefined();
  });

  it('P5 returns nothing when the run never asked', () => {
    expect(
      selectPermissionAction(
        [event({ id: 1, kind: 'tool_call', tool: 'Bash' }), event({ id: 2, kind: 'session', sessionId: 'sess-2' })],
        { ticketCreatedAt: CREATED, now: CREATED },
      ),
    ).toBeUndefined();
  });

  it('P6 reaches the tail of a full retention window', () => {
    const events = Array.from({ length: 499 }, (_, index) =>
      event({ id: index + 1, kind: 'tool_call', tool: 'Read', createdAt: CREATED + index }),
    );
    events.push(permission(500, CREATED + 499, RM_RF));
    expect(
      selectPermissionAction(events, { ticketCreatedAt: CREATED + 500, now: CREATED + 500 })?.command,
    ).toBe('rm -rf dist');
  });
});

describe('mapping an approval onto the ticket that asks for it', () => {
  const GO = (key: string, risk?: TicketOption['risk']): TicketOption => ({
    key,
    label: `选项 ${key}`,
    ...(risk ? { risk } : {}),
  });

  it('O1 knows the park ticket', () => {
    expect(approveOptionFor(ticket([GO('approve', 'caution'), GO('reject', 'safe')]))).toBe('approve');
  });

  it('O2 knows the local handover ticket', () => {
    expect(approveOptionFor(ticket([GO('y', 'caution'), GO('n', 'safe')]))).toBe('y');
  });

  it('O3 knows the decision ticket', () => {
    expect(approveOptionFor(ticket([GO('A'), GO('B')]))).toBe('A');
  });

  it('O4 matches the key whatever case the ticket spells it in', () => {
    expect(approveOptionFor(ticket([GO('a'), GO('b')]))).toBe('a');
  });

  it('O5 will not auto-resolve onto a destructive option', () => {
    expect(approveOptionFor(ticket([GO('approve', 'destructive'), GO('reject')]))).toBeUndefined();
  });

  it('O6 declines to guess the meaning of options nobody standardised', () => {
    expect(approveOptionFor(ticket([GO('go'), GO('later')]))).toBeUndefined();
  });

  it('O7 still needs the option to be on the ticket at all', () => {
    expect(approveOptionFor(ticket([GO('left'), GO('right')]))).toBeUndefined();
  });
});
