import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Git worktree isolation for dispatched tasks.
 *
 * Two agents editing one checkout overwrite each other, so a task gets its own
 * worktree and its own throwaway branch, and the only thing that ever leaves
 * it is one clean commit. Every git call is an argv array — no shell — because
 * task ids, labels and commit messages are attacker-adjacent text.
 */

export interface GitCall {
  args: readonly string[];
  cwd: string;
}

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type GitRunner = (call: GitCall) => Promise<GitResult>;

export type WorktreeErrorCode =
  | 'INVALID_TASK_ID'
  | 'INVALID_REF'
  | 'NOT_A_REPO'
  | 'WORKTREE_MISSING'
  | 'WORKTREE_DIRTY'
  | 'GIT_FAILED'
  | 'REBASE_FAILED';

export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;

  constructor(code: WorktreeErrorCode, message: string) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
  }
}

export interface WorktreeHandle {
  taskId: string;
  repoRoot: string;
  workspacePath: string;
  branch: string;
  /** False when this call found the isolation already in place. */
  created: boolean;
}

export interface Checkpoint {
  hash: string;
  label: string;
}

export interface SquashResult {
  taskId: string;
  workspacePath: string;
  branch: string;
  mainBranch: string;
  /** The commit the wip work started from; the rebase lands on top of mainBranch. */
  base: string;
  commit: string;
}

export interface WorktreeManagerOptions {
  /** The checkout this instance isolates tasks in; per-call paths may override it. */
  repoPath?: string;
  /** Injected for tests and for a git that is not on PATH. */
  run?: GitRunner;
}

const TASK_ID = /^[A-Za-z0-9._-]{1,64}$/;
const REF = /^[A-Za-z0-9._/-]{1,160}$/;
const WT_ROOT = join('.zhunzou', 'wt');
/** Local ignore pattern for the worktree root, written into `.git/info/exclude`. */
const EXCLUDE_LINE = '/.zhunzou/';

function assertTaskId(taskId: string): string {
  const id = String(taskId ?? '').trim();
  if (!TASK_ID.test(id) || id === '.' || id === '..') {
    throw new WorktreeError(
      'INVALID_TASK_ID',
      `task id ${JSON.stringify(id)} cannot be used as a worktree name`,
    );
  }
  return id;
}

function assertRef(ref: string, what: string): string {
  const value = String(ref ?? '').trim();
  if (!REF.test(value) || value.startsWith('-') || value.includes('..')) {
    throw new WorktreeError(
      'INVALID_REF',
      `${what} ${JSON.stringify(value)} is not a usable branch name`,
    );
  }
  return value;
}

/**
 * The default runner.
 *
 * `-c core.quotepath=false` keeps non-ASCII paths readable, and messages are
 * passed as `-m<text>`: a value that starts with `-` would otherwise be
 * parsed as another option.
 */
export const spawnGit: GitRunner = (call) =>
  new Promise((resolvePromise) => {
    const child = spawn(
      'git',
      ['-c', 'core.quotepath=false', ...call.args],
      { cwd: call.cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: Error) => {
      resolvePromise({ code: null, stdout, stderr: error.message });
    });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });

export class WorktreeManager {
  private readonly run: GitRunner;
  private readonly repoPath?: string;

  constructor(options: WorktreeManagerOptions = {}) {
    this.run = options.run ?? spawnGit;
    if (options.repoPath) this.repoPath = options.repoPath;
  }

  /**
   * Isolate `taskId` inside its own worktree on `wip/zz-<taskId>`.
   *
   * Idempotent on purpose: a healed or requeued task re-enters the same
   * workspace instead of failing on a directory it created last time.
   */
  async createWorktree(
    taskId: string,
    repoPath?: string,
    targetBranch?: string,
  ): Promise<WorktreeHandle> {
    const id = assertTaskId(taskId);
    const branch = `wip/zz-${id}`;
    const base = targetBranch
      ? assertRef(targetBranch, 'target branch')
      : undefined;
    const repoRoot = await this.repoRootFor(this.knownRepoPath(repoPath, id));
    const workspacePath = join(repoRoot, WT_ROOT, id);
    const registered = await this.listWorktrees(repoRoot);
    const existing = registered.get(workspacePath);

    if (existing) {
      return {
        taskId: id,
        repoRoot,
        workspacePath,
        branch: existing.branch ?? branch,
        created: false,
      };
    }

    const branchExists = await this.tryGit(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot);
    await this.ensureWorktreesIgnored(repoRoot);
    await this.gitOrThrow(
      branchExists
        ? ['worktree', 'add', workspacePath, branch]
        : ['worktree', 'add', '-b', branch, workspacePath, base ?? 'HEAD'],
      repoRoot,
      `git worktree add 失败（任务 #${id}）`,
    );

    return { taskId: id, repoRoot, workspacePath, branch, created: true };
  }

  /**
   * Snapshot every change on the task branch, untracked files included.
   *
   * `git stash create` cannot see untracked files on the gits we ship against,
   * and an agent's work is mostly new files — so a checkpoint is a plain commit
   * on the throwaway `wip/` branch, which nothing publishes without approval.
   */
  async createCheckpoint(
    taskId: string,
    label: string,
    repoPath?: string,
  ): Promise<Checkpoint | undefined> {
    const workspace = await this.workspaceFor(taskId, repoPath);
    const note = String(label ?? '').trim().slice(0, 200) || 'checkpoint';
    const pending = await this.gitOrThrow(
      ['status', '--porcelain', '--untracked-files=all'],
      workspace.workspacePath,
      'git status 失败',
    );
    if (!pending.trim()) return undefined;

    await this.gitOrThrow(
      ['add', '-A', '--'],
      workspace.workspacePath,
      `git add 失败（任务 #${workspace.taskId}）`,
    );
    await this.gitOrThrow(
      ['commit', `-mzhunzou:${workspace.taskId} checkpoint: ${note}`],
      workspace.workspacePath,
      `git commit 失败（任务 #${workspace.taskId}）`,
    );

    return {
      hash: await this.revParseHead(workspace.workspacePath),
      label: note,
    };
  }

  /**
   * Squash the task's wip commits into one and rebase it onto `mainBranch`.
   *
   * `mainBranch` itself is never moved: publishing is an approved action (see
   * docs/design/worktree-2.1.md §4), and the caller gets the commit to publish.
   * A dirty tree is refused rather than `git add -A`-ed, so nothing unknown
   * slips into history; any write that fails is undone back to the original tip.
   */
  async squashAndRebase(
    taskId: string,
    mainBranch: string,
    commitMessage: string,
    repoPath?: string,
  ): Promise<SquashResult> {
    const branchRef = assertRef(mainBranch, 'main branch');
    const workspace = await this.workspaceFor(taskId, repoPath);
    const dirty = await this.gitOrThrow(
      ['status', '--porcelain', '--untracked-files=all'],
      workspace.workspacePath,
      'git status 失败',
    );
    if (dirty.trim()) {
      throw new WorktreeError(
        'WORKTREE_DIRTY',
        `任务 #${workspace.taskId} 的工作区还有未提交改动，先做 checkpoint 再合并`,
      );
    }

    const original = await this.revParseHead(workspace.workspacePath);
    const base = (
      await this.gitOrThrow(
        ['merge-base', branchRef, 'HEAD'],
        workspace.workspacePath,
        `找不到 ${branchRef} 与任务分支的共同祖先`,
      )
    ).trim();
    const message = String(commitMessage ?? '').trim().slice(0, 2000);
    if (!message) {
      throw new WorktreeError('GIT_FAILED', 'squash 需要一条提交信息');
    }

    try {
      await this.gitOrThrow(
        ['reset', '--soft', base],
        workspace.workspacePath,
        'git reset --soft 失败',
      );
      await this.gitOrThrow(
        ['commit', `-m${message}`],
        workspace.workspacePath,
        'git commit 失败',
      );
      await this.gitOrThrow(
        ['rebase', '--onto', branchRef, base],
        workspace.workspacePath,
        `变基到 ${branchRef} 失败`,
      );
    } catch (error) {
      // Best effort: a half-finished rebase must not be left for the next run.
      await this.tryGit(['rebase', '--abort'], workspace.workspacePath);
      await this.tryGit(['reset', '--hard', original], workspace.workspacePath);
      throw new WorktreeError(
        'REBASE_FAILED',
        `${(error as Error).message}（已还原到 ${original}）`,
      );
    }

    const commit = await this.revParseHead(workspace.workspacePath);
    return {
      taskId: workspace.taskId,
      workspacePath: workspace.workspacePath,
      branch: workspace.branch,
      mainBranch: branchRef,
      base,
      commit,
    };
  }

  /** The workspace `taskId` was isolated in, found through git's own registry. */
  async workspaceFor(taskId: string, repoPath?: string): Promise<WorktreeHandle> {
    const id = assertTaskId(taskId);
    const repoRoot = await this.repoRootFor(this.knownRepoPath(repoPath, id));
    const workspacePath = join(repoRoot, WT_ROOT, id);
    const registered = await this.listWorktrees(repoRoot);
    const found = registered.get(workspacePath);

    if (!found) {
      throw new WorktreeError(
        'WORKTREE_MISSING',
        `任务 #${id} 在 ${repoRoot} 下没有 worktree`,
      );
    }
    return {
      taskId: id,
      repoRoot,
      workspacePath,
      branch: found.branch ?? `wip/zz-${id}`,
      created: false,
    };
  }

  /** The name a node profile reports for the checkout containing `path`. */
  async repoNameFor(path: string): Promise<string> {
    return basename(await this.repoRootFor(path));
  }

  private knownRepoPath(repoPath: string | undefined, taskId: string): string {
    const path = repoPath ?? this.repoPath;
    if (!path) {
      throw new WorktreeError(
        'WORKTREE_MISSING',
        `任务 #${taskId} 没有可用的仓库路径：构造 WorktreeManager 时传 repoPath，或在调用里带上`,
      );
    }
    return path;
  }

  private async repoRootFor(path: string): Promise<string> {
    const result = await this.run({
      args: ['rev-parse', '--show-toplevel'],
      cwd: path,
    });
    const root = result.stdout.trim();
    if (result.code !== 0 || !root) {
      throw new WorktreeError(
        'NOT_A_REPO',
        `${path} 不是 git 仓库：${tail(result.stderr || result.stdout)}`,
      );
    }
    return root;
  }

  /**
   * Keep the worktrees out of the main checkout's `git status`.
   *
   * `git worktree add` does not ignore its own directory, so an agent running
   * `git add -A` at the repo root would stage another task's workspace. The
   * pattern goes in `.git/info/exclude`, which is local and never committed.
   */
  private async ensureWorktreesIgnored(repoRoot: string): Promise<void> {
    try {
      const result = await this.run({
        args: ['rev-parse', '--git-common-dir'],
        cwd: repoRoot,
      });
      const commonDir = result.code === 0 ? result.stdout.trim() : '';
      if (!commonDir) return;

      const file = join(resolve(repoRoot, commonDir), 'info', 'exclude');
      const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (current.split('\n').some((line) => line.trim() === EXCLUDE_LINE)) return;

      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}${EXCLUDE_LINE}\n`,
      );
    } catch {
      // Tidying git status is not worth failing task isolation over.
    }
  }

  private async listWorktrees(
    repoRoot: string,
  ): Promise<Map<string, { branch?: string }>> {
    const output = await this.gitOrThrow(
      ['worktree', 'list', '--porcelain'],
      repoRoot,
      'git worktree list 失败',
    );
    const found = new Map<string, { branch?: string }>();
    let current: string | undefined;

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        current = line.slice('worktree '.length).trim();
        if (current) found.set(current, {});
        continue;
      }
      if (!current) continue;
      if (line.startsWith('branch refs/heads/')) {
        found.get(current)!.branch = line.slice('branch refs/heads/'.length).trim();
      }
    }

    return found;
  }

  private async revParseHead(cwd: string): Promise<string> {
    return (await this.gitOrThrow(['rev-parse', 'HEAD'], cwd, 'git rev-parse 失败')).trim();
  }

  /** Run git and hand back stdout, naming the operation that failed. */
  private async gitOrThrow(args: readonly string[], cwd: string, context: string): Promise<string> {
    const result = await this.run({ args, cwd });
    if (result.code !== 0) {
      throw new WorktreeError(
        'GIT_FAILED',
        `${context}：${tail(result.stderr || result.stdout) || `git ${args[0]} 退出码 ${result.code}`}`,
      );
    }
    return result.stdout;
  }

  /** Run git and report only success, for the paths where a failure is the answer. */
  private async tryGit(args: readonly string[], cwd: string): Promise<boolean> {
    const result = await this.run({ args, cwd });
    return result.code === 0;
  }
}

function tail(value: string, limit = 200): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? trimmed.slice(-limit) : trimmed;
}
