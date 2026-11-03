import { describe, expect, it, vi } from 'vitest';

import type { WaitResponse } from '@zhunzou/shared';

import { HubApiError, type HubApi } from '../src/hub-client.js';
import { waitForDecision } from '../src/wait-command.js';
import { makeTicket } from './helpers.js';

function fakeClient(wait: (...args: [string, number?]) => Promise<WaitResponse>): HubApi {
  return {
    createTicket: vi.fn(),
    wait: vi.fn(wait),
    heartbeat: vi.fn(),
  };
}

function stdoutBuffer() {
  const lines: string[] = [];
  return { lines, write: (text: string) => lines.push(text) };
}

function stderrBuffer() {
  const lines: string[] = [];
  return { lines, write: (text: string) => lines.push(text) };
}

describe('waitForDecision', () => {
  it('prints the decision and exits 0', async () => {
    const client = fakeClient(async () => ({
      resolved: true,
      timedOut: false,
      ticket: makeTicket({
        status: 'HUMAN_RESOLVED',
        selectedOption: 'B',
        customInstruction: '用行内文案',
        resolvedBy: 'HUMAN',
      }),
    }));
    const out = stdoutBuffer();

    const code = await waitForDecision({
      client,
      ticketId: '#104',
      intervalMs: 15_000,
      stdout: out.write,
      stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(out.lines.join('\n')).toContain('Decision Approved: Option [B]');
    expect(client.wait).toHaveBeenCalledWith('104', 15_000);
  });

  it('keeps polling after a timeout and prints progress to stderr', async () => {
    let call = 0;
    const client = fakeClient(async () => {
      call += 1;
      if (call === 1) {
        return { resolved: false, timedOut: true, ticket: makeTicket() };
      }
      return {
        resolved: true,
        timedOut: false,
        ticket: makeTicket({
          status: 'AUTO_RESOLVED',
          selectedOption: 'A',
          resolvedBy: 'META_AGENT',
        }),
      };
    });
    const out = stdoutBuffer();
    const err = stderrBuffer();

    const code = await waitForDecision({
      client,
      ticketId: '104',
      intervalMs: 15_000,
      stdout: out.write,
      stderr: err.write,
    });

    expect(code).toBe(0);
    expect(err.lines.join('\n')).toContain('still waiting');
    expect(out.lines.join('\n')).toContain('Option [A]');
    expect(client.wait).toHaveBeenCalledTimes(2);
  });

  it('exits 2 when the ticket is cancelled', async () => {
    const client = fakeClient(async () => ({
      resolved: false,
      timedOut: false,
      ticket: makeTicket({ status: 'CANCELLED' }),
    }));
    const err = stderrBuffer();

    const code = await waitForDecision({
      client,
      ticketId: '104',
      intervalMs: 15_000,
      stdout: () => undefined,
      stderr: err.write,
    });

    expect(code).toBe(2);
    expect(err.lines.join('\n')).toContain('cancelled');
  });

  it('exits 1 immediately on a fatal auth error', async () => {
    const client = fakeClient(async () => {
      throw new HubApiError(401, 'UNAUTHORIZED', 'bad token');
    });
    const err = stderrBuffer();

    const code = await waitForDecision({
      client,
      ticketId: '104',
      intervalMs: 15_000,
      stdout: () => undefined,
      stderr: err.write,
      sleep: async () => undefined,
    });

    expect(code).toBe(1);
    expect(err.lines.join('\n')).toContain('UNAUTHORIZED');
    expect(client.wait).toHaveBeenCalledTimes(1);
  });

  it('backs off and retries on a network error', async () => {
    let call = 0;
    const client = fakeClient(async () => {
      call += 1;
      if (call === 1) throw new HubApiError(0, 'NETWORK_ERROR', 'connection refused');
      return {
        resolved: true,
        timedOut: false,
        ticket: makeTicket({
          status: 'HUMAN_RESOLVED',
          selectedOption: 'A',
          resolvedBy: 'HUMAN',
        }),
      };
    });
    const sleep = vi.fn(async () => undefined);

    const code = await waitForDecision({
      client,
      ticketId: '104',
      intervalMs: 15_000,
      stdout: () => undefined,
      stderr: () => undefined,
      sleep,
    });

    expect(code).toBe(0);
    expect(sleep).toHaveBeenCalledWith(15_000);
    expect(client.wait).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid ticket id without calling the server', async () => {
    const client = fakeClient(async () => {
      throw new Error('should not be called');
    });
    const err = stderrBuffer();

    const code = await waitForDecision({
      client,
      ticketId: 'abc',
      intervalMs: 15_000,
      stdout: () => undefined,
      stderr: err.write,
    });

    expect(code).toBe(1);
    expect(client.wait).not.toHaveBeenCalled();
    expect(err.lines.join('\n')).toContain('invalid ticket id');
  });
});
