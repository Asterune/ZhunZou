import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RunnerState } from '../src/runner-state.js';

const dirs: string[] = [];

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-runner-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function ledgerFile(dir: string, env: string): string {
  return join(dir, `chat-runner-${env}.json`);
}

function writeLedger(
  dir: string,
  env: string,
  value: Record<string, unknown>,
): void {
  writeFileSync(ledgerFile(dir, env), JSON.stringify(value), 'utf8');
}

describe('RunnerState', () => {
  it('keeps one runner id across clean restarts', () => {
    const dir = stateDir();
    const first = new RunnerState('mac-cursor', { dir });
    first.close();

    expect(new RunnerState('mac-cursor', { dir }).runnerId).toBe(first.runnerId);
  });

  it('rotates the id when the previous loop died mid-turn', () => {
    const dir = stateDir();
    writeLedger(dir, 'mac-cursor', {
      runnerId: 'runner-dead',
      stoppedAt: null,
      turns: ['7'],
      writtenAt: Date.now(),
    });

    expect(new RunnerState('mac-cursor', { dir }).runnerId).not.toBe('runner-dead');
  });

  it('rotates the id after a clean exit that still owned a turn', () => {
    const dir = stateDir();
    const first = new RunnerState('mac-cursor', { dir });
    first.beginTurn('7');
    first.close();

    expect(new RunnerState('mac-cursor', { dir }).runnerId).not.toBe(first.runnerId);
  });

  it('treats an idle loop that was killed outright as still alive', () => {
    const dir = stateDir();
    writeLedger(dir, 'mac-cursor', {
      runnerId: 'runner-idle',
      stoppedAt: null,
      turns: [],
      writtenAt: Date.now(),
    });

    expect(new RunnerState('mac-cursor', { dir }).runnerId).toBe('runner-idle');
  });

  it('rotates the id when the last ledger write is old', () => {
    const dir = stateDir();
    writeLedger(dir, 'mac-cursor', {
      runnerId: 'runner-ancient',
      stoppedAt: null,
      turns: [],
      writtenAt: Date.now() - 60_000,
    });

    expect(new RunnerState('mac-cursor', { dir }).runnerId).not.toBe('runner-ancient');
  });

  it('keeps finished turns out of the in-flight ledger', () => {
    const dir = stateDir();
    const state = new RunnerState('mac-cursor', { dir });
    state.beginTurn('7');
    expect(JSON.parse(readFileSync(ledgerFile(dir, 'mac-cursor'), 'utf8')).turns).toEqual(['7']);

    state.endTurn('7');
    expect(state.pendingTurns()).toEqual([]);
    expect(JSON.parse(readFileSync(ledgerFile(dir, 'mac-cursor'), 'utf8')).turns).toEqual([]);
  });

  it('journals a result until the hub accepts it', () => {
    const dir = stateDir();
    const state = new RunnerState('mac-cursor', { dir });
    state.recordCompletion('1', '7', { status: 'DONE', content: '答案' });

    expect(state.pendingCompletions()).toEqual([
      { sessionId: '1', messageId: '7', completion: { status: 'DONE', content: '答案' } },
    ]);

    state.recordCompletion('1', '7', { status: 'DONE', content: '答案' });
    expect(state.pendingCompletions()).toHaveLength(1);

    state.clearCompletion('7');
    expect(state.pendingCompletions()).toEqual([]);
  });

  it('ignores a journal it cannot understand', () => {
    const dir = stateDir();
    const state = new RunnerState('mac-cursor', { dir });
    writeFileSync(join(dir, 'chat-pending-mac-cursor.json'), '{ "nope": 1 }', 'utf8');
    expect(state.pendingCompletions()).toEqual([]);

    writeFileSync(
      join(dir, 'chat-pending-mac-cursor.json'),
      JSON.stringify([
        { sessionId: '1', messageId: '../../etc/passwd', completion: { status: 'DONE' } },
        { sessionId: '1', messageId: '8', completion: { status: 'MAYBE' } },
        { sessionId: '1', messageId: '9', completion: { status: 'FAILED', error: 'x' } },
      ]),
      'utf8',
    );
    expect(state.pendingCompletions().map((entry) => entry.messageId)).toEqual(['9']);
  });

  it('gives each env its own files and keeps them path-safe', () => {
    const dir = stateDir();
    const odd = new RunnerState('../../etc/passwd', { dir });
    const other = new RunnerState('other-env', { dir });

    expect(odd.runnerId).not.toBe(other.runnerId);
    expect(readFileSync(join(dir, 'chat-runner-other-env.json'), 'utf8')).toContain(
      other.runnerId,
    );
  });
});
