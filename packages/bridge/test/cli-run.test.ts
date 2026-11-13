import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunWrappedOptions } from '../src/wrappers/runner.js';

const captured = vi.hoisted(() => ({
  calls: [] as RunWrappedOptions[],
}));

vi.mock('../src/wrappers/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/wrappers/runner.js')>();
  return {
    ...actual,
    runWrapped: async (options: RunWrappedOptions) => {
      captured.calls.push(options);
      return 0;
    },
  };
});

const { createProgram } = await import('../src/cli-program.js');

/** Which engines exist on this machine decides what `zz run` may wrap. */
let binDir = '';
let realPath = '';

beforeAll(() => {
  realPath = process.env.PATH ?? '';
  binDir = mkdtempSync(join(tmpdir(), 'zhunzou-cli-run-'));
  for (const name of ['cursor-agent', 'opencode', 'claude']) {
    const path = join(binDir, name);
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o755);
  }
  process.env.PATH = [binDir, realPath].filter(Boolean).join(
    process.platform === 'win32' ? ';' : ':',
  );
});

afterAll(() => {
  process.env.PATH = realPath;
  rmSync(binDir, { recursive: true, force: true });
});

/** Parse like the shipped `cli.js` does, but keep stdout/stderr out of the test log. */
async function parse(argv: string[]): Promise<{ out: string; err: string; code: number | undefined }> {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const program = createProgram();
  program.exitOverride();
  process.exitCode = undefined;

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch {
    // commander throws on --help / missing arguments; the text is the assertion.
  }

  const out = stdout.mock.calls.map((call) => String(call[0])).join('');
  const err = stderr.mock.calls.map((call) => String(call[0])).join('');
  stdout.mockRestore();
  stderr.mockRestore();
  return { out, err, code: process.exitCode as number | undefined };
}

beforeEach(() => {
  captured.calls.length = 0;
});

describe('zz run command line', () => {
  it('keeps everything after the engine name for the CLI (C1)', async () => {
    await parse(['run', 'claude', '-p', 'hi', '--idle-timeout', '1000']);

    const options = captured.calls[0];
    expect(options?.adapter).toBe('claude');
    expect(options?.args).toEqual(['-p', 'hi', '--idle-timeout', '1000']);
    expect(options?.idleMs).toBeUndefined();
  });

  it('takes wrapper flags typed before the engine name', async () => {
    await parse([
      'run',
      '--idle-timeout',
      '90000',
      '--no-takeover',
      '--cwd',
      '/tmp/pte-dojo',
      'cursor',
      '--force',
      'fix it',
    ]);

    const options = captured.calls[0];
    expect(options?.adapter).toBe('cursor-agent');
    expect(options?.args).toEqual(['--force', 'fix it']);
    expect(options?.idleMs).toBe(90_000);
    expect(options?.takeover).toBe(false);
    expect(options?.cwd).toBe('/tmp/pte-dojo');
  });

  it('clamps a nonsense idle timeout instead of failing the run', async () => {
    await parse(['run', '--idle-timeout', '1', 'claude', '-p', 'hi']);
    expect(captured.calls[0]?.idleMs).toBe(30_000);
  });

  it('says the wrap only covers print/stream mode (C2)', async () => {
    const { out } = await parse(['run', '--help']);

    expect(out).toContain('print/stream mode');
    expect(out).toContain('Full-screen TUIs');
    expect(out).toContain('--idle-timeout');
    expect(out).toContain('--no-takeover');
  });

  it('refuses to run without an engine name (C3)', async () => {
    const { err } = await parse(['run']);
    expect(err).toContain("missing required argument 'engine'");
    expect(captured.calls).toEqual([]);
  });

  it('lists the wrappable engines when the name cannot be wrapped (C3b)', async () => {
    const { err, code } = await parse(['run', 'notify', '-p', 'hi']);

    expect(err).toContain('不能伴随这个引擎: notify');
    expect(err).toContain('可伴随:');
    expect(code).toBe(1);
    expect(captured.calls).toEqual([]);
  });

  it('drops the separator between the two option worlds (C4)', async () => {
    await parse(['run', 'claude', '--', '-p', 'hi']);
    expect(captured.calls[0]?.args).toEqual(['-p', 'hi']);
  });

  it('runs local-only when no hub is configured', async () => {
    const savedToken = process.env.HUB_TOKEN;
    const savedSecret = process.env.HUB_SECRET_TOKEN;
    delete process.env.HUB_TOKEN;
    delete process.env.HUB_SECRET_TOKEN;
    try {
      const { code } = await parse(['run', 'claude', '-p', 'hi']);

      const options = captured.calls[0];
      expect(options?.takeover).toBe(false);
      // The wrapper itself reports the failed registration; the command still runs.
      await expect(options?.client.createLocalTask({} as never)).rejects.toThrow(
        '未接入 Hub',
      );
      expect(code).toBe(0);
    } finally {
      if (savedToken !== undefined) process.env.HUB_TOKEN = savedToken;
      if (savedSecret !== undefined) process.env.HUB_SECRET_TOKEN = savedSecret;
    }
  });
});
