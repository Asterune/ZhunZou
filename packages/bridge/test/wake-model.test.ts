import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveWakeAdapter, type WakeContext, type WakeOutcome } from '../src/wake/adapters.js';
import type { WakeConfig } from '../src/wake/config.js';
import { makeTask } from './helpers.js';

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fake `claude` that replays a scripted exit and dumps the argv it got. */
function stubCli(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-model-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/bin/sh',
      'printf \'%s@@\' "$@" > "$ZHUNZOU_ARGV_DUMP"',
      'if [ -n "$FAKE_STDERR" ]; then printf \'%s\\n\' "$FAKE_STDERR" >&2; fi',
      'exit "${FAKE_EXIT:-0}"',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(join(bin, 'claude'), 0o755);
  vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);
  return join(dir, 'argv.txt');
}

function makeContext(overrides: Partial<WakeConfig> = {}): {
  context: WakeContext;
  lines: string[];
} {
  const lines: string[] = [];
  return {
    lines,
    context: {
      config: {
        adapter: 'claude',
        extraArgs: [],
        cwd: process.cwd(),
        worktrees: false,
        runTimeoutMs: 5_000,
        pollTimeoutMs: 1_000,
        notifyIntervalMs: 2_000,
        ...overrides,
      },
      log: (message) => lines.push(message),
      reportLog: () => undefined,
      reportEvent: () => undefined,
    },
  };
}

function argvOf(dump: string): string[] {
  try {
    return readFileSync(dump, 'utf8').split('@@').filter(Boolean);
  } catch {
    return [];
  }
}

async function runClaude(
  context: WakeContext,
  task = makeTask(),
): Promise<WakeOutcome> {
  const adapter = await resolveWakeAdapter(context.config);
  return adapter.wake(task, context);
}

describe('wake adapters model selection', () => {
  it('puts the model named on the task ahead of the node default', async () => {
    const dump = stubCli();
    vi.stubEnv('ZHUNZOU_ARGV_DUMP', dump);
    const { context } = makeContext({ chatModel: 'node-default' });

    await runClaude(context, makeTask({ model: 'task-picked' }));

    expect(argvOf(dump).slice(0, 3)).toEqual(['-p', '--model', 'task-picked']);
  });

  it('falls back to the node default when the task says nothing', async () => {
    const dump = stubCli();
    vi.stubEnv('ZHUNZOU_ARGV_DUMP', dump);
    const { context } = makeContext({ chatModel: 'node-default' });

    await runClaude(context);

    expect(argvOf(dump).slice(0, 3)).toEqual(['-p', '--model', 'node-default']);
  });

  it('spells nothing when no model is configured', async () => {
    const dump = stubCli();
    vi.stubEnv('ZHUNZOU_ARGV_DUMP', dump);
    const { context } = makeContext();

    await runClaude(context);

    expect(argvOf(dump)).not.toContain('--model');
  });
});

describe('wake adapters model fallback', () => {
  const QUOTA = 'Free usage limit reached. Connect a provider or subscribe to OpenCode Go.';

  it('retries once on the fallback model when the fault is a quota', async () => {
    const dump = stubCli();
    vi.stubEnv('ZHUNZOU_ARGV_DUMP', dump);
    vi.stubEnv('FAKE_STDERR', QUOTA);
    vi.stubEnv('FAKE_EXIT', '1');
    const { context, lines } = makeContext({
      chatModel: 'plan-a',
      fallbackModel: 'plan-b',
    });

    const outcome = await runClaude(context);

    expect(lines.join('\n')).toContain('改用 plan-b 重试一次');
    expect(argvOf(dump).slice(0, 3)).toEqual(['-p', '--model', 'plan-b']);
    expect(outcome.completion).toMatchObject({
      status: 'FAILED',
      failureKind: 'quota_exhausted',
    });
  });

  it('spends one run, not a loop', async () => {
    const dump = stubCli();
    vi.stubEnv('ZHUNZOU_ARGV_DUMP', dump);
    vi.stubEnv('FAKE_STDERR', QUOTA);
    vi.stubEnv('FAKE_EXIT', '1');
    const { context, lines } = makeContext({
      chatModel: 'plan-a',
      fallbackModel: 'plan-b',
    });

    await runClaude(context);

    expect(lines.filter((line) => line.startsWith('spawn claude'))).toHaveLength(2);
  });

  it('does not switch for a fault another model answers the same way', async () => {
    const dump = stubCli();
    vi.stubEnv('ZHUNZOU_ARGV_DUMP', dump);
    vi.stubEnv('FAKE_STDERR', 'Authentication failed: invalid api key');
    vi.stubEnv('FAKE_EXIT', '1');
    const { context, lines } = makeContext({
      chatModel: 'plan-a',
      fallbackModel: 'plan-b',
    });

    const outcome = await runClaude(context);

    expect(lines.join('\n')).not.toContain('重试一次');
    expect(argvOf(dump).slice(0, 3)).toEqual(['-p', '--model', 'plan-a']);
    expect(outcome.completion).toMatchObject({ status: 'FAILED', failureKind: 'auth_failed' });
  });

  it('does not switch when no fallback is configured', async () => {
    const dump = stubCli();
    vi.stubEnv('ZHUNZOU_ARGV_DUMP', dump);
    vi.stubEnv('FAKE_STDERR', QUOTA);
    vi.stubEnv('FAKE_EXIT', '1');
    const { context, lines } = makeContext({ chatModel: 'plan-a' });

    await runClaude(context);

    expect(lines.filter((line) => line.startsWith('spawn claude'))).toHaveLength(1);
  });

  it('does not switch to the model that just said no', async () => {
    const dump = stubCli();
    vi.stubEnv('ZHUNZOU_ARGV_DUMP', dump);
    vi.stubEnv('FAKE_STDERR', QUOTA);
    vi.stubEnv('FAKE_EXIT', '1');
    const { context, lines } = makeContext({
      chatModel: 'plan-a',
      fallbackModel: 'plan-a',
    });

    await runClaude(context);

    expect(lines.filter((line) => line.startsWith('spawn claude'))).toHaveLength(1);
  });

  it('reads a code failure as a code failure', async () => {
    const dump = stubCli();
    vi.stubEnv('ZHUNZOU_ARGV_DUMP', dump);
    vi.stubEnv('FAKE_STDERR', 'FAIL src/login.test.ts — Expected 200, received 400');
    vi.stubEnv('FAKE_EXIT', '1');
    const { context, lines } = makeContext({
      chatModel: 'plan-a',
      fallbackModel: 'plan-b',
    });

    const outcome = await runClaude(context);

    expect(lines.join('\n')).not.toContain('重试一次');
    expect(outcome.completion).toMatchObject({ status: 'FAILED' });
    expect(outcome.completion?.failureKind).toBeUndefined();
  });

  it('labels a command-template failure but cannot swap the model inside it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhunzou-model-cmd-'));
    dirs.push(dir);
    const { context, lines } = makeContext({
      adapter: 'command',
      command: `printf '%s\\n' '${QUOTA}' >&2; exit 1`,
      fallbackModel: 'plan-b',
      cwd: dir,
    });

    const outcome = await runClaude(context);

    expect(outcome.completion).toMatchObject({
      status: 'FAILED',
      failureKind: 'quota_exhausted',
    });
    expect(lines.join('\n')).not.toContain('改用');
  });
});
