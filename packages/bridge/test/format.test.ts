import { describe, expect, it } from 'vitest';

import {
  formatApproved,
  formatCancelled,
  formatCliDecision,
  formatResume,
  formatWaiting,
} from '../src/format.js';
import { makeTask, makeTicket } from './helpers.js';

describe('formatApproved', () => {
  it('includes the option, instruction, reason and source', () => {
    const text = formatApproved(
      makeTicket({
        status: 'HUMAN_RESOLVED',
        selectedOption: 'B',
        customInstruction: '先只改登录页',
        resolvedBy: 'HUMAN',
        resolutionReason: '人类拍板',
      }),
    );

    expect(text).toContain('Decision Approved: Option [B] - 行内文案');
    expect(text).toContain('Instruction: 先只改登录页');
    expect(text).toContain('Reason: 人类拍板');
    expect(text).toContain('#104');
    expect(text).toContain('HUMAN');
  });

  it('works for a Meta-Agent decision without extra instruction', () => {
    const text = formatApproved(
      makeTicket({
        status: 'AUTO_RESOLVED',
        selectedOption: 'A',
        resolvedBy: 'META_AGENT',
        resolutionReason: '符合规范',
      }),
    );
    expect(text).toContain('Option [A] - Toast 提示');
    expect(text).toContain('META_AGENT');
    expect(text).not.toContain('Instruction:');
  });
});

describe('formatWaiting', () => {
  it('tells the model to run the CLI command (strategy 1)', () => {
    const text = formatWaiting(makeTicket(), 'cli');
    expect(text).toContain('npx zhunzou-bridge wait --ticket 104');
    expect(text).toContain('pending human approval');
  });

  it('uses a self-hosted CLI command when one is configured', () => {
    const text = formatWaiting(makeTicket(), 'cli', 'node /opt/zhunzou/cli.js');
    expect(text).toContain('node /opt/zhunzou/cli.js wait --ticket 104');
  });

  it('tells the model to call the MCP tool again (strategy 2)', () => {
    const text = formatWaiting(makeTicket(), 'mcp');
    expect(text).toContain('[STATUS: STILL_WAITING]');
    expect(text).toContain("agent_hub_wait(ticketId: 104)");
  });
});

describe('formatResume', () => {
  it('lists pending tickets, active tasks and recent decisions', () => {
    const text = formatResume({
      tickets: [
        makeTicket({ status: 'PENDING_HUMAN' }),
        makeTicket({
          id: '103',
          status: 'HUMAN_RESOLVED',
          selectedOption: 'B',
          customInstruction: '先只改登录页',
        }),
      ],
      tasks: [makeTask()],
    });

    expect(text).toContain('[RESUME]');
    expect(text).toContain('agent_hub_wait(ticketId: 104)');
    expect(text).toContain('Active tasks');
    expect(text).toContain('agent_hub_complete_task(taskId: 12');
    expect(text).toContain('Recently resolved');
    expect(text).toContain('option B');
  });

  it('reports an empty resume state', () => {
    expect(formatResume({ tickets: [], tasks: [] })).toContain('[STATUS: NO_RESUME]');
  });
});

describe('cancellation and CLI output', () => {
  it('warns the model not to continue after cancellation', () => {
    const text = formatCancelled(makeTicket({ status: 'CANCELLED' }));
    expect(text).toContain('#104');
    expect(text).toContain('cancelled');
  });

  it('prints the same decision for the CLI', () => {
    const ticket = makeTicket({
      status: 'HUMAN_RESOLVED',
      selectedOption: 'B',
      customInstruction: '用行内文案',
    });
    expect(formatCliDecision(ticket)).toBe(formatApproved(ticket));
  });
});
