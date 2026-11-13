import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EngineEventInput } from '@zhunzou/shared';

import {
  renderCommandTemplate,
  resolveWakeAdapter,
  type WakeContext,
  type WakeOutcome,
} from '../src/wake/adapters.js';
import type { WakeConfig } from '../src/wake/config.js';
import type { LogStream } from '../src/wake/log-sink.js';
import { makeTask } from './helpers.js';

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A CLI that replays a scripted stream and can dump the argv it received.
 * `@@` separates the arguments in the dump because a run prompt spans lines.
 * `FAKE_HOLD` keeps the run alive in tenths of a second, in short sleeps, so a
 * killed parent releases the pipe at once instead of leaking a long child.
 */
function stubCli(): void {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-fakecli-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const file = join(bin, 'claude');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      'if [ -n "$ZHUNZOU_ARGV_DUMP" ]; then printf \'%s@@\' "$@" > "$ZHUNZOU_ARGV_DUMP"; fi',
      'if [ -n "$FAKE_STDOUT" ]; then printf \'%s\\n\' "$FAKE_STDOUT"; fi',
      'if [ -n "$FAKE_STDERR" ]; then printf \'%s\\n\' "$FAKE_STDERR" >&2; fi',
      'i=0',
      'while [ $i -lt "${FAKE_HOLD:-0}" ]; do sleep 0.1; i=$((i+1)); done',
      'exit "${FAKE_EXIT:-0}"',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(file, 0o755);
  // /bin and /usr/bin stay on PATH for the script's own `sleep`; a real CLI in
  // a user prefix would not, so detection still lands on the fake.
  vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);
}

interface Harness {
  context: WakeContext;
  events: EngineEventInput[];
  lines: string[];
  /** Everything the child wrote to stdout, in the order it arrived. */
  raw: () => string;
  /** The argv the fake CLI actually received. */
  argv: () => string[];
}

function makeHarness(overrides: Partial<WakeConfig> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-fakecli-'));
  dirs.push(dir);
  const dump = join(dir, 'argv.txt');
  vi.stubEnv('ZHUNZOU_ARGV_DUMP', dump);

  const logs: Array<{ stream: LogStream; chunk: string }> = [];
  const events: EngineEventInput[] = [];
  const lines: string[] = [];

  return {
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
      reportLog: (stream, chunk) => logs.push({ stream, chunk }),
      reportEvent: (event) => events.push(event),
    },
    events,
    lines,
    raw: () =>
      logs
        .filter((log) => log.stream === 'stdout')
        .map((log) => log.chunk)
        .join(''),
    argv: () => {
      try {
        return readFileSync(dump, 'utf8').split('@@').filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

async function runWith(harness: Harness, task = makeTask()): Promise<WakeOutcome> {
  const adapter = await resolveWakeAdapter(harness.context.config);
  return adapter.wake(task, harness.context);
}

describe('wake adapters engine events', () => {
  it('forwards raw bytes untouched and files the structure beside them', async () => {
    stubCli();
    const stream = [
      '{"type":"system","subtype":"init","session_id":"ses_1"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit"},{"type":"tool_use","name":"Read"}]}}',
      'progress: nothing here is JSON',
    ].join('\n');
    vi.stubEnv('FAKE_STDOUT', stream);

    const harness = makeHarness();
    const outcome = await runWith(harness);

    // A profile that fails to recognise a line must not cost a single byte.
    expect(harness.raw()).toBe(`${stream}\n`);
    expect(harness.events).toEqual([
      { kind: 'session', engine: 'claude-code', sessionId: 'ses_1' },
      { kind: 'tool_call', engine: 'claude-code', tool: 'Edit' },
      { kind: 'tool_call', engine: 'claude-code', tool: 'Read' },
    ]);
    expect(outcome.completion?.status).toBe('DONE');
  });

  it('resumes with the engine syntax, before the prompt', async () => {
    stubCli();
    const harness = makeHarness();

    await runWith(harness, makeTask({ sessionId: 'ses_9' }));

    const argv = harness.argv();
    expect(argv.slice(0, 3)).toEqual(['-p', '--resume', 'ses_9']);
    expect(argv.at(-1)).toContain('给登录页补错误提示');
  });

  it('will not put an engine-reported id it cannot trust on the command line', async () => {
    stubCli();
    const harness = makeHarness();
    await runWith(harness, makeTask({ sessionId: '--rfc /tmp' }));

    expect(harness.argv()).not.toContain('--resume');
    expect(harness.lines.join('\n')).toContain('跳过续跑');

    const long = makeHarness();
    await runWith(long, makeTask({ sessionId: 'x'.repeat(129) }));
    expect(long.argv()).not.toContain('--resume');
    expect(long.lines.join('\n')).toContain('跳过续跑');
  });

  it('parks the run when the engine asks for approval', async () => {
    stubCli();
    vi.stubEnv(
      'FAKE_STDOUT',
      [
        '{"type":"system","subtype":"init","session_id":"ses_1"}',
        '{"type":"control_request","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf dist"}}}',
      ].join('\n'),
    );
    // Without the abort this run would sit here for the whole hold.
    vi.stubEnv('FAKE_HOLD', '50');

    const harness = makeHarness({ runTimeoutMs: 5_000 });
    const started = Date.now();
    const outcome = await runWith(harness);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3_000);
    expect(outcome.completion).toBeUndefined();
    expect(outcome.parked?.reason).toContain('rm -rf dist');
    expect(outcome.parked?.tool).toBe('Bash');
    expect(outcome.parked?.action).toMatchObject({
      kind: 'command',
      command: 'rm -rf dist',
      workspaceRoot: process.cwd(),
    });
    // The session id still lands before the process is let go.
    expect(harness.events.map((event) => event.kind)).toEqual([
      'session',
      'permission_required',
    ]);
  });

  it('keeps the command template placeholder when there is no usable id', () => {
    const task = makeTask({ sessionId: 'ses_1' });
    expect(renderCommandTemplate('zz run -- {sessionId}', task, '/repo')).toBe(
      "zz run -- 'ses_1'",
    );
    expect(renderCommandTemplate('zz run -- {sessionId}', makeTask(), '/repo')).toBe(
      'zz run -- {sessionId}',
    );
    expect(
      renderCommandTemplate('zz run -- {sessionId}', makeTask({ sessionId: 'a b' }), '/repo'),
    ).toBe('zz run -- {sessionId}');
  });

  it('hands the session id to a command template through the environment', async () => {
    const harness = makeHarness({
      adapter: 'command',
      command: 'printf "resume=%s" "$ZHUNZOU_SESSION_ID"',
    });

    const outcome = await runWith(harness, makeTask({ sessionId: 'ses_7' }));

    expect(harness.raw()).toBe('resume=ses_7');
    expect(outcome.completion?.status).toBe('DONE');
  });

  it('still reports timeout and failure when nothing structured arrives', async () => {
    stubCli();
    vi.stubEnv('FAKE_EXIT', '1');
    vi.stubEnv('FAKE_STDERR', 'boom: cannot resolve module');
    const failed = makeHarness();
    const failedOutcome = await runWith(failed);
    expect(failedOutcome.completion).toMatchObject({ status: 'FAILED' });
    expect(failedOutcome.completion?.result).toContain('cannot resolve module');
    expect(failed.events).toEqual([]);

    vi.stubEnv('FAKE_EXIT', '');
    vi.stubEnv('FAKE_STDERR', '');
    vi.stubEnv('FAKE_HOLD', '30');
    const slow = makeHarness({ runTimeoutMs: 300 });
    const slowOutcome = await runWith(slow);
    expect(slowOutcome.completion?.status).toBe('FAILED');
    expect(slowOutcome.completion?.result).toContain('超时');
  });
});
