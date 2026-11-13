import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentTask,
  CompleteTaskInput,
  EnvHeartbeat,
  HeartbeatInput,
  ReleaseTaskInput,
} from '@zhunzou/shared';

import type { HubApi } from '../src/hub-client.js';
import { fingerprintDelta, readWorkspaceFingerprint } from '../src/git/delta.js';
import type { GitCall, GitRunner } from '../src/git/worktree.js';
import type { LogChunkMeta } from '../src/sanitizer/log-sanitizer.js';
import { createLogSanitizer } from '../src/sanitizer/log-sanitizer.js';
import type { WakeAdapter } from '../src/wake/adapters.js';
import { whichSync } from '../src/wake/adapters.js';
import { runWakeDaemon } from '../src/wake/daemon.js';
import { buildInjectPrompt, buildRunPrompt } from '../src/wake/prompt.js';
import { createLogSink, type LogStream } from '../src/wake/log-sink.js';
import type { WakeConfig } from '../src/wake/config.js';
import { makeTask, testConfig } from './helpers.js';

const gitBin = whichSync('git');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    gitBin ?? 'git',
    [
      '-c',
      'core.quotepath=false',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=ZhunZou Test',
      '-c',
      'user.email=test@zhunzou.local',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function repoDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zhunzou-delta-')));
  dirs.push(dir);
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/* ------------------------------------------------------------------ */
/* W1-W2: the fix prompt reaches the engine                            */
/* ------------------------------------------------------------------ */

const FIX_PROMPT = '第 3 行的 page 是字符串，改成 number 后跑 pnpm test。';

describe('wake prompts with a supervisor verdict', () => {
  it('W1: appends the diagnosis to a one-shot run, and stays byte-exact without one', () => {
    const withFix = buildRunPrompt(makeTask({ fixPrompt: FIX_PROMPT }));
    expect(withFix).toContain('总管诊断与修复要求（上一次尝试失败的结论，不是原始需求）');
    expect(withFix).toContain(FIX_PROMPT);
    // The original ask keeps its own heading; the two must not merge.
    expect(withFix.indexOf('指令：')).toBeLessThan(
      withFix.indexOf('总管诊断与修复要求'),
    );

    expect(buildRunPrompt(makeTask())).toBe(
      [
        '【准奏下发任务 #12】',
        '环境：company-cursor',
        '项目：yikuaomed-erp',
        '标题：给登录页补错误提示',
        '',
        '指令：',
        '错误提示统一使用行内文案，并补一条测试。',
        '',
        '请直接在当前工作区内完成上述任务，完成后输出一段简要总结（改了什么、如何验证）。',
        '如果遇到需要人类拍板的卡点，按项目规则调用 agent_hub_escalate 上奏并等待结果；不要自行决定不可逆操作。',
      ].join('\n'),
    );
  });

  it('W2: appends it to an injected prompt before the claiming notice', () => {
    const prompt = buildInjectPrompt(makeTask({ fixPrompt: FIX_PROMPT }));
    expect(prompt).toContain(FIX_PROMPT);
    expect(prompt.indexOf('总管诊断与修复要求')).toBeLessThan(
      prompt.indexOf('这条任务已经由唤醒守护进程领取'),
    );
    expect(buildInjectPrompt(makeTask())).not.toContain('总管诊断');
  });
});

/* ------------------------------------------------------------------ */
/* W3-W6: the fingerprint                                              */
/* ------------------------------------------------------------------ */

describe('workspace fingerprint', () => {
  it('W3: is stable regardless of the order git reports the paths in', () => {
    const left = fingerprintDelta({ head: 'deadbeef', porcelain: ' M a.ts\n?? b.ts\n' });
    const right = fingerprintDelta({ head: 'deadbeef', porcelain: '?? b.ts\n M a.ts' });

    expect(left).toBe(right);
    expect(left).toHaveLength(32);
    expect(fingerprintDelta({ head: 'cafe', porcelain: ' M a.ts' })).not.toBe(left);
  });

  it('W4: repeats itself for a worktree that did not move', async () => {
    const dir = repoDir();
    const first = await readWorkspaceFingerprint(dir);
    const second = await readWorkspaceFingerprint(dir);

    expect(first).toBe(second);
    expect(first).toHaveLength(32);
  });

  it('W5: counts an untracked file as work', async () => {
    const dir = repoDir();
    const before = await readWorkspaceFingerprint(dir);

    writeFileSync(join(dir, 'scratch.ts'), 'export const x = 1;\n');
    const after = await readWorkspaceFingerprint(dir);

    expect(after).not.toBe(before);
  });

  it('W6: says nothing when git cannot answer', async () => {
    const failing: GitRunner = async () => ({
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
    });
    await expect(readWorkspaceFingerprint('/nowhere', failing)).resolves.toBeUndefined();

    const halfBroken: GitRunner = async (call: GitCall) =>
      call.args[0] === 'rev-parse'
        ? { code: 0, stdout: 'deadbeef\n', stderr: '' }
        : { code: 1, stdout: '', stderr: 'boom' };
    await expect(readWorkspaceFingerprint('/nowhere', halfBroken)).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* W7: the daemon ships it before the outcome                          */
/* ------------------------------------------------------------------ */

interface Calls {
  events: string[];
  completed: Array<{ taskId: string; input: CompleteTaskInput }>;
  logs: Array<{ taskId: string; input: { stream: string; chunk: string } & LogChunkMeta }>;
}

function makeClient(task: AgentTask, calls: Calls): HubApi {
  let polls = 0;

  return {
    async createTicket() {
      throw new Error('unused');
    },
    async reportTaskEvents() {
      return 0;
    },
    async wait() {
      throw new Error('unused');
    },
    async heartbeat(input: HeartbeatInput): Promise<EnvHeartbeat> {
      void input;
      return { env: task.env, status: input.status, lastSeenAt: 1, online: true };
    },
    async nextTask() {
      polls += 1;
      return { task: polls === 1 ? task : null, timedOut: false };
    },
    async listTasks() {
      return { tasks: [task], total: 1 };
    },
    async completeTask(taskId, input) {
      calls.events.push('complete');
      calls.completed.push({ taskId, input });
      return { ...task, status: input.status };
    },
    async appendTaskLog(taskId, input) {
      calls.events.push('log');
      calls.logs.push({ taskId, input });
      return {
        id: calls.logs.length,
        taskId,
        stream: input.stream,
        chunk: input.chunk,
        ...(input.errorSignature ? { errorSignature: input.errorSignature } : {}),
        ...(input.diffHash ? { diffHash: input.diffHash } : {}),
        createdAt: 1,
      };
    },
    async releaseTask(taskId: string, input: ReleaseTaskInput) {
      void input;
      return { ...task, status: 'PENDING' };
    },
    async resume() {
      throw new Error('unused');
    },
  };
}

async function runOnce(
  task: AgentTask,
  cwd: string,
  calls: Calls,
): Promise<void> {
  const wake: WakeConfig = {
    adapter: 'command',
    command: 'true',
    extraArgs: [],
    cwd,
    worktrees: false,
    runTimeoutMs: 5_000,
    pollTimeoutMs: 20,
    notifyIntervalMs: 2_000,
  };
  const adapter: WakeAdapter = {
    name: 'command',
    delivery: 'run',
    async wake() {
      return { completion: { status: 'FAILED', result: '编译不过' } };
    },
  };

  await runWakeDaemon({
    client: makeClient(task, calls),
    hub: testConfig(),
    wake,
    adapter,
    once: true,
    stdout: () => undefined,
    stderr: () => undefined,
    sleep: async () => undefined,
  });
}

describe('the daemon reports the worktree it leaves behind', () => {
  it('W7: ships the fingerprint before the task is completed', async () => {
    const dir = repoDir();
    writeFileSync(join(dir, 'broken.ts'), 'export const x: number = "no";\n');
    const calls: Calls = { events: [], completed: [], logs: [] };

    await runOnce(makeTask({ status: 'CLAIMED' }), dir, calls);

    const fingerprintRow = calls.logs.find((entry) => entry.input.diffHash);
    expect(fingerprintRow?.input.stream).toBe('system');
    expect(fingerprintRow?.input.diffHash).toHaveLength(32);
    expect(calls.events.indexOf('log')).toBeLessThan(calls.events.indexOf('complete'));
    expect(calls.completed).toHaveLength(1);
    expect(calls.completed[0]?.input.status).toBe('FAILED');
  });

  it('W7b: a directory git does not know still completes the task', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zhunzou-plain-')));
    dirs.push(dir);
    const calls: Calls = { events: [], completed: [], logs: [] };

    await runOnce(makeTask({ status: 'CLAIMED' }), dir, calls);

    expect(calls.logs.some((entry) => entry.input.diffHash)).toBe(false);
    expect(calls.completed).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* W8: an explicit meta wins over the sanitizer                        */
/* ------------------------------------------------------------------ */

describe('log sink with caller-supplied metadata', () => {
  it('W8: ships labelled text verbatim and keeps describing everything else', async () => {
    const sent: Array<{ stream: LogStream; chunk: string; meta: LogChunkMeta }> = [];
    const sanitizer = createLogSanitizer();
    const sink = createLogSink(
      async (stream, chunk, meta) => {
        sent.push({ stream, chunk, meta });
      },
      () => undefined,
      { sanitizer },
    );

    sink.push('stderr', 'src/a.ts(1,1): error TS2322: nope\n');
    sink.push('system', '工作树指纹 3f2a\n', { diffHash: '3f2a' });
    await sink.close();

    const labelled = sent.find((entry) => entry.meta.diffHash);
    expect(labelled).toMatchObject({ stream: 'system', chunk: '工作树指纹 3f2a\n' });
    // The labelled row is its own block: the fingerprint cannot land on the
    // engine's output, and vice versa.
    expect(sent.filter((entry) => entry.meta.diffHash)).toHaveLength(1);
    expect(sent.at(-2)?.chunk).toContain('TS2322');
    expect(sent.at(-2)?.meta.errorSignature).toBeTruthy();
  });
});
