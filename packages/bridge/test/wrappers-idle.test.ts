import { describe, expect, it } from 'vitest';

import {
  MAX_HANDOFFS,
  MIN_IDLE_MS,
  MAX_IDLE_MS,
  WRAP_IDLE_MS,
  createHandoverJudge,
  detectStuck,
  parseIdleMs,
} from '../src/wrappers/idle.js';

const START = 1_000_000;
const FIVE_MINUTES = 5 * 60_000;

function judge(idleMs = WRAP_IDLE_MS) {
  return createHandoverJudge({ startedAt: START, idleMs, quietMs: 15_000 });
}

describe('detectStuck', () => {
  it('trusts an unanswered approval request over anything else', () => {
    const signal = detectStuck({
      tail: 'Thinking…',
      lastOutputAt: START,
      now: START + FIVE_MINUTES,
      pendingPermission: '端侧引擎请求批准：Bash rm -rf build',
    });
    expect(signal?.kind).toBe('permission');
    expect(signal?.summary).toContain('rm -rf build');
  });

  it('reads a confirmation prompt out of the tail', () => {
    for (const tail of [
      'About to delete 3 files [y/n] ',
      'Do you want to write src/App.vue?',
      'Apply changes? Press Enter to continue',
      '是否继续执行该命令？',
    ]) {
      const signal = detectStuck({ tail, lastOutputAt: START, now: START + FIVE_MINUTES });
      expect(signal?.kind, tail).toBe('prompt');
      expect(signal?.summary, tail).toBeTruthy();
    }
  });

  it('counts an error only once the output has gone quiet', () => {
    const tail = 'npm ERR! Failed to fetch the lockfile\n';
    expect(
      detectStuck({
        tail,
        lastOutputAt: START + FIVE_MINUTES - 60_000,
        now: START + FIVE_MINUTES,
      })?.kind,
    ).toBe('error');
    // Still streaming: the CLI is working, not stuck.
    expect(
      detectStuck({ tail, lastOutputAt: START + FIVE_MINUTES - 1_000, now: START + FIVE_MINUTES }),
    ).toBeNull();
  });

  it('ignores a prompt that already scrolled out of the frontier', () => {
    const tail = `[y/n] ${'x'.repeat(4_000)}`;
    expect(
      detectStuck({ tail, lastOutputAt: START, now: START + FIVE_MINUTES, quietMs: 0 }),
    ).toBeNull();
    expect(
      detectStuck({ tail: `${'x'.repeat(4_000)}[y/n]`, lastOutputAt: START, now: START + FIVE_MINUTES })
        ?.kind,
    ).toBe('prompt');
  });

  it('truncates the evidence it hands to the ticket', () => {
    const signal = detectStuck({
      tail: `${'y'.repeat(10_000)}[y/n]`,
      lastOutputAt: START,
      now: START + FIVE_MINUTES,
    });
    expect(signal!.evidence.length).toBeLessThanOrEqual(601);
  });
});

describe('createHandoverJudge', () => {
  it('needs both facts: idle long enough and actually stuck', () => {
    const four = judge();
    four.noteOutput(START + 1_000, 'Delete 3 files? [y/n] ');
    expect(four.evaluate(START + FIVE_MINUTES - 1_000, true)).toBeNull();

    const busy = judge();
    busy.noteOutput(START + 1_000, 'building bundle…');
    expect(busy.evaluate(START + FIVE_MINUTES, true)).toBeNull();
  });

  it('hands over once the human has been gone five minutes over a prompt', () => {
    const j = judge();
    j.noteOutput(START + 1_000, 'Overwrite src/main.ts? [y/n] ');
    const signal = j.evaluate(START + FIVE_MINUTES, true);
    expect(signal?.kind).toBe('prompt');
    expect(j.handoffs).toBe(1);
  });

  it('does not fire while the process is gone or the handover is in flight', () => {
    const j = judge();
    j.noteOutput(START + 1_000, '[y/n]');
    expect(j.evaluate(START + FIVE_MINUTES, false)).toBeNull();
    expect(j.evaluate(START + FIVE_MINUTES, true)).not.toBeNull();
    // One episode at a time until something changes.
    expect(j.evaluate(START + FIVE_MINUTES * 2, true)).toBeNull();
  });

  it('re-arms on a keystroke, but not on more output', () => {
    const j = judge();
    j.noteOutput(START + 1_000, '[y/n]');
    expect(j.evaluate(START + FIVE_MINUTES, true)).not.toBeNull();
    j.noteOutput(START + FIVE_MINUTES + 2_000, '[y/n] still waiting');
    expect(j.evaluate(START + FIVE_MINUTES * 3, true)).toBeNull();

    j.noteActivity(START + FIVE_MINUTES * 3);
    expect(j.evaluate(START + FIVE_MINUTES * 4, true)).not.toBeNull();
    expect(j.handoffs).toBe(2);
  });

  it('stops handing over after three episodes', () => {
    const j = judge();
    for (let round = 0; round < MAX_HANDOFFS + 2; round += 1) {
      j.noteOutput(START + 1_000, '[y/n]');
      j.noteActivity(START + round * FIVE_MINUTES);
      j.evaluate(START + (round + 1) * FIVE_MINUTES, true);
    }
    expect(j.handoffs).toBe(MAX_HANDOFFS);
    expect(j.exhausted).toBe(true);
  });

  it('notices when the run moved on without the hub', () => {
    const j = judge();
    j.noteOutput(START + 1_000, '[y/n]');
    const handedOverAt = START + FIVE_MINUTES;
    expect(j.evaluate(handedOverAt, true)).not.toBeNull();
    expect(j.movedOnSince(handedOverAt)).toBe(false);

    j.noteActivity(handedOverAt + 500);
    expect(j.movedOnSince(handedOverAt)).toBe(true);
  });

  it('treats a fresh approval request as a new episode', () => {
    const j = judge();
    j.noteOutput(START + 1_000, 'waiting');
    expect(j.evaluate(START + FIVE_MINUTES, true)).toBeNull();
    j.notePermission('端侧引擎请求批准：Write /etc/hosts', START + FIVE_MINUTES);
    expect(j.evaluate(START + FIVE_MINUTES * 2, true)?.kind).toBe('permission');
  });
});

describe('parseIdleMs', () => {
  it('takes the blueprint default when nothing usable is given', () => {
    expect(parseIdleMs(undefined)).toBe(WRAP_IDLE_MS);
    expect(parseIdleMs('')).toBe(WRAP_IDLE_MS);
    expect(parseIdleMs('abc')).toBe(WRAP_IDLE_MS);
    expect(parseIdleMs('0')).toBe(WRAP_IDLE_MS);
  });

  it('clamps a hand-set value into the usable band', () => {
    expect(parseIdleMs('10000')).toBe(MIN_IDLE_MS);
    expect(parseIdleMs(String(8 * 60 * 60 * 1000))).toBe(MAX_IDLE_MS);
    expect(parseIdleMs('60000')).toBe(60_000);
  });
});
