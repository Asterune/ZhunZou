import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { whichSync } from '../src/wake/adapters.js';
import { WorktreeError, WorktreeManager } from '../src/git/worktree.js';

const gitBin = whichSync('git');

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

const dirs: string[] = [];

/** A real repo with one commit on `main`, so refs and merge-base are honest. */
function repoDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zhunzou-wt-')));
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-qm', 'seed');
  return dir;
}

function commit(cwd: string, name: string, content: string): string {
  writeFileSync(join(cwd, name), content);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-qm', `add ${name}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!gitBin)('WorktreeManager against a real repository', () => {
  it('creates an isolated worktree and reuses it on the next call', async () => {
    const repo = repoDir();
    const manager = new WorktreeManager({ repoPath: repo });

    const first = await manager.createWorktree('42');
    expect(first).toMatchObject({
      taskId: '42',
      repoRoot: repo,
      workspacePath: join(repo, '.zhunzou', 'wt', '42'),
      branch: 'wip/zz-42',
      created: true,
    });
    expect(existsSync(join(first.workspacePath, 'README.md'))).toBe(true);
    expect(git(first.workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'wip/zz-42',
    );

    const second = await manager.createWorktree('42');
    expect(second).toMatchObject({ workspacePath: first.workspacePath, created: false });
  });

  it('keeps edits in the worktree out of the main checkout', async () => {
    const repo = repoDir();
    const manager = new WorktreeManager({ repoPath: repo });
    const { workspacePath } = await manager.createWorktree('7');

    commit(workspacePath, 'notes.md', 'agent work\n');

    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(existsSync(join(workspacePath, 'notes.md'))).toBe(true);
  });

  it('keeps a checkpoint of untracked work without touching main', async () => {
    const repo = repoDir();
    const manager = new WorktreeManager({ repoPath: repo });
    const { workspacePath } = await manager.createWorktree('9');

    expect(await manager.createCheckpoint('9', 'clean tree')).toBeUndefined();

    writeFileSync(join(workspacePath, 'wip.md'), 'half finished\n');
    commit(workspacePath, 'done.md', 'finished work\n');
    const before = git(workspacePath, 'rev-parse', 'HEAD');

    const checkpoint = await manager.createCheckpoint('9', 'before heal #1');
    expect(checkpoint?.label).toBe('before heal #1');
    expect(checkpoint?.hash).not.toBe(before);
    expect(git(workspacePath, 'log', '-1', '--format=%s')).toBe(
      'zhunzou:9 checkpoint: before heal #1',
    );
    expect(git(workspacePath, 'status', '--porcelain')).toBe('');
    // The snapshot lives on the task branch only; main never saw it.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('keeps the checkpoint object reachable after the branch moves on', async () => {
    const repo = repoDir();
    const manager = new WorktreeManager({ repoPath: repo });
    const { workspacePath } = await manager.createWorktree('10');
    writeFileSync(join(workspacePath, 'wip.md'), 'half finished\n');

    const checkpoint = await manager.createCheckpoint('10', 'undo me');
    expect(checkpoint).toBeDefined();

    rmSync(join(workspacePath, 'wip.md'));
    git(workspacePath, 'checkout', '-q', checkpoint!.hash, '--', '.');
    git(workspacePath, 'reset', '-q');

    expect(readFileSync(join(workspacePath, 'wip.md'), 'utf8')).toBe(
      'half finished\n',
    );
  });

  it('squashes wip commits onto main without moving main', async () => {
    const repo = repoDir();
    const manager = new WorktreeManager({ repoPath: repo });
    const { workspacePath } = await manager.createWorktree('11');

    commit(workspacePath, 'a.md', 'step one\n');
    commit(workspacePath, 'b.md', 'step two\n');
    const mainTip = commit(repo, 'c.md', 'someone else\n');

    const result = await manager.squashAndRebase('11', 'main', 'feat: task 11');

    expect(result.mainBranch).toBe('main');
    expect(result.base).not.toBe('');
    expect(git(repo, 'rev-parse', 'main')).toBe(mainTip);
    expect(git(workspacePath, 'log', '--format=%s', `${mainTip}..HEAD`)).toBe(
      'feat: task 11',
    );
    expect(
      git(workspacePath, 'rev-list', '--count', `${mainTip}..HEAD`),
    ).toBe('1');
    expect(readFileSync(join(workspacePath, 'a.md'), 'utf8')).toBe('step one\n');
  });

  it('refuses to squash a dirty worktree', async () => {
    const repo = repoDir();
    const manager = new WorktreeManager({ repoPath: repo });
    const { workspacePath } = await manager.createWorktree('12');
    const before = git(workspacePath, 'rev-parse', 'HEAD');

    writeFileSync(join(workspacePath, 'loose.md'), 'untracked\n');

    const error = await manager
      .squashAndRebase('12', 'main', 'feat: task 12')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorktreeError);
    expect((error as WorktreeError).code).toBe('WORKTREE_DIRTY');
    expect(git(workspacePath, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('reports a task that was never isolated', async () => {
    const repo = repoDir();
    const manager = new WorktreeManager({ repoPath: repo });

    const error = await manager.workspaceFor('404').catch((e: unknown) => e);
    expect((error as WorktreeError).code).toBe('WORKTREE_MISSING');
  });

  it('rejects a path that is not a repository', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'zhunzou-bare-')));
    dirs.push(outside);

    const error = await new WorktreeManager({ repoPath: outside })
      .createWorktree('1')
      .catch((e: unknown) => e);
    expect((error as WorktreeError).code).toBe('NOT_A_REPO');
  });
});
