import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentTask, CompleteTaskInput } from '@zhunzou/shared';

import type { HubApi } from '../src/hub-client.js';
import {
  whichSync,
  type WakeAdapter,
  type WakeContext,
} from '../src/wake/adapters.js';
import { loadWakeConfig, type WakeConfig } from '../src/wake/config.js';
import { runWakeDaemon } from '../src/wake/daemon.js';
import { WorktreeError, type WorktreeHandle } from '../src/git/worktree.js';
import type { WorkspaceIsolation } from '../src/wake/isolation.js';
import { makeTask, testConfig } from './helpers.js';

const ROOT = '/srv/code/pte-dojo';
const WT = join(ROOT, '.zhunzou', 'wt', '12');
const gitBin = whichSync('git');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A real one-commit repo, so the daemon's own WorktreeManager has something to add to. */
function repoDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zhunzou-wakewt-')));
  dirs.push(dir);
  const git = (...args: string[]): void => {
    execFileSync(
      gitBin ?? 'git',
      ['-c', 'user.name=Z', '-c', 'user.email=z@zhunzou.local', ...args],
      { cwd: dir, stdio: 'ignore' },
    );
  };
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git('add', 'README.md');
  git('commit', '-qm', 'seed');
  return dir;
}

function wakeFor(worktrees: boolean): WakeConfig {
  return { ...loadWakeConfig({}), cwd: ROOT, worktrees };
}

interface RunResult {
  lines: string[];
  completed: CompleteTaskInput[];
  ranIn?: string;
}

/** One task, one wake, one cycle. */
async function runOnce(
  task: AgentTask,
  isolation?: WorkspaceIsolation,
  worktrees = true,
  cwd = ROOT,
): Promise<RunResult> {
  const completed: CompleteTaskInput[] = [];
  const lines: string[] = [];
  let ranIn: string | undefined;
  let polls = 0;

  const client = {
    async nextTask() {
      polls += 1;
      return { task: polls === 1 ? task : null, timedOut: false };
    },
    async heartbeat() {
      return { env: 'x', status: 'Idle' as const, lastSeenAt: 1, online: true };
    },
    async appendTaskLog(taskId: string, input: { stream: string; chunk: string }) {
      return { id: 1, taskId, stream: input.stream, chunk: input.chunk, createdAt: 1 };
    },
    async completeTask(_taskId: string, input: CompleteTaskInput) {
      completed.push(input);
      return task;
    },
    async releaseTask() {
      return task;
    },
  } as unknown as HubApi;

  const adapter: WakeAdapter = {
    name: 'command',
    delivery: 'run',
    async wake(_task: AgentTask, context: WakeContext) {
      ranIn = context.config.cwd;
      return { completion: { status: 'DONE', result: 'ok' } };
    },
  };

  await runWakeDaemon({
    client,
    hub: testConfig(),
    wake: { ...wakeFor(worktrees), cwd },
    adapter,
    ...(isolation ? { isolation } : {}),
    once: true,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    sleep: async () => undefined,
  });

  return { lines, completed, ranIn };
}

function stubIsolation(
  overrides: Partial<WorkspaceIsolation> = {},
): WorkspaceIsolation & { calls: string[] } {
  const calls: string[] = [];
  const handle: WorktreeHandle = {
    taskId: '12',
    repoRoot: ROOT,
    workspacePath: WT,
    branch: 'wip/zz-12',
    created: true,
  };

  return {
    calls,
    async repoNameFor(path) {
      calls.push(`repoNameFor:${path}`);
      return 'pte-dojo';
    },
    async createWorktree(taskId, repoPath) {
      calls.push(`createWorktree:${taskId}:${repoPath}`);
      return handle;
    },
    ...overrides,
  };
}

describe('wake worktree isolation', () => {
  it('is off unless ZHUNZOU_WORKTREES says otherwise', () => {
    expect(loadWakeConfig({}).worktrees).toBe(false);
    expect(loadWakeConfig({ ZHUNZOU_WORKTREES: '1' }).worktrees).toBe(true);
    expect(loadWakeConfig({ ZHUNZOU_WORKTREES: 'off' }).worktrees).toBe(false);
  });

  it('runs in the shared checkout when disabled', async () => {
    const result = await runOnce(makeTask(), stubIsolation(), false);

    expect(result.ranIn).toBe(ROOT);
    expect(result.completed[0]).not.toHaveProperty('workspacePath');
  });

  it('runs the task inside the worktree and reports where it happened', async () => {
    const isolation = stubIsolation();
    const result = await runOnce(makeTask(), isolation);

    expect(isolation.calls).toEqual([`createWorktree:12:${ROOT}`]);
    expect(result.ranIn).toBe(WT);
    expect(result.completed[0]).toMatchObject({
      status: 'DONE',
      workspacePath: WT,
    });
    expect(result.lines.join('\n')).toContain(`隔离在 ${WT}`);
  });

  it('checks the repository before isolating a repo-tagged task', async () => {
    const isolation = stubIsolation();
    const result = await runOnce(makeTask({ repoName: 'other-repo' }), isolation);

    expect(isolation.calls).toEqual([`repoNameFor:${ROOT}`]);
    expect(result.ranIn).toBe(ROOT);
    expect(result.completed[0]).not.toHaveProperty('workspacePath');
    expect(result.lines.join('\n')).toContain('属于仓库 other-repo');
  });

  it('runs a tagged task in the worktree when the repository matches', async () => {
    const isolation = stubIsolation();
    const result = await runOnce(makeTask({ repoName: 'pte-dojo' }), isolation);

    expect(result.ranIn).toBe(WT);
    expect(result.completed[0]?.workspacePath).toBe(WT);
  });

  it('falls back to the plain checkout instead of losing the task', async () => {
    const isolation = stubIsolation({
      async createWorktree() {
        throw new WorktreeError('GIT_FAILED', 'git worktree add 失败（任务 #12）');
      },
    });
    const result = await runOnce(makeTask(), isolation);

    expect(result.ranIn).toBe(ROOT);
    expect(result.completed[0]?.status).toBe('DONE');
    expect(result.completed[0]).not.toHaveProperty('workspacePath');
    expect(result.lines.join('\n')).toContain('未能隔离：git worktree add 失败');
  });

  it.skipIf(!gitBin)(
    'creates the worktree with the real manager the daemon builds itself',
    async () => {
      const repo = repoDir();
      const result = await runOnce(makeTask(), undefined, true, repo);
      const workspacePath = join(repo, '.zhunzou', 'wt', '12');

      expect(result.ranIn).toBe(workspacePath);
      expect(existsSync(join(workspacePath, 'README.md'))).toBe(true);
      expect(result.completed[0]?.workspacePath).toBe(workspacePath);
    },
  );
});
