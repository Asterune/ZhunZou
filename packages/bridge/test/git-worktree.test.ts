import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { WorktreeError, type GitResult } from '../src/git/worktree.js';
import { WorktreeManager, type GitCall } from '../src/git/worktree.js';

type Handler = (call: GitCall) => GitResult | undefined;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeGit(handlers: Handler) {
  const calls: GitCall[] = [];
  const run = async (call: GitCall): Promise<GitResult> => {
    calls.push(call);
    return (
      handlers(call) ?? { code: 0, stdout: '', stderr: '' }
    );
  };
  return { calls, run };
}

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom'): GitResult => ({ code: 1, stdout: '', stderr });

const REPO_ROOT = '/srv/code/pte-dojo';
const WT_ROOT = `${REPO_ROOT}/.zhunzou/wt`;

/** What a plain checkout with one branch answers. */
const defaults: Handler = (call) => {
  const [command, ...rest] = call.args;
  if (command === 'rev-parse' && rest[0] === '--show-toplevel') {
    return ok(`${REPO_ROOT}\n`);
  }
  if (command === 'worktree' && rest[0] === 'list') {
    return ok(`worktree ${REPO_ROOT}\nHEAD aaa\nbranch refs/heads/main\n\n`);
  }
  if (command === 'rev-parse' && rest[0] === '--verify') {
    return fail('fatal: unknown revision');
  }
  return undefined;
};

function baseHandlers(overrides: Handler = () => undefined): Handler {
  return (call) => overrides(call) ?? defaults(call);
}

describe('WorktreeManager.createWorktree', () => {
  it('adds an isolated checkout on its own wip branch', async () => {
    const git = fakeGit(baseHandlers());
    const manager = new WorktreeManager({ run: git.run });

    const handle = await manager.createWorktree('42', REPO_ROOT);

    expect(handle).toEqual({
      taskId: '42',
      repoRoot: REPO_ROOT,
      workspacePath: `${WT_ROOT}/42`,
      branch: 'wip/zz-42',
      created: true,
    });
    expect(git.calls.at(-1)?.args).toEqual([
      'worktree',
      'add',
      '-b',
      'wip/zz-42',
      `${WT_ROOT}/42`,
      'HEAD',
    ]);
    expect(git.calls.at(-1)?.cwd).toBe(REPO_ROOT);
  });

  it('bases the branch on the requested branch when there is one', async () => {
    const git = fakeGit(baseHandlers());
    const manager = new WorktreeManager({ run: git.run });

    await manager.createWorktree('42', REPO_ROOT, 'release/1.2');

    expect(git.calls.at(-1)?.args).toEqual([
      'worktree',
      'add',
      '-b',
      'wip/zz-42',
      `${WT_ROOT}/42`,
      'release/1.2',
    ]);
  });

  it('reuses a worktree that is already registered', async () => {
    const git = fakeGit(
      baseHandlers((call) =>
        call.args[0] === 'worktree' && call.args[1] === 'list'
          ? ok(
              `worktree ${REPO_ROOT}\nbranch refs/heads/main\n\nworktree ${WT_ROOT}/42\nbranch refs/heads/wip/zz-42\n\n`,
            )
          : undefined,
      ),
    );
    const manager = new WorktreeManager({ run: git.run });

    const handle = await manager.createWorktree('42', REPO_ROOT);

    expect(handle).toMatchObject({ created: false, branch: 'wip/zz-42' });
    expect(git.calls.map((call) => call.args[0])).toEqual([
      'rev-parse',
      'worktree',
    ]);
  });

  it('attaches to a branch a previous attempt already left behind', async () => {
    const git = fakeGit(
      baseHandlers((call) =>
        call.args[0] === 'rev-parse' && call.args[1] === '--verify'
          ? ok('aaa\n')
          : undefined,
      ),
    );
    const manager = new WorktreeManager({ run: git.run });

    const handle = await manager.createWorktree('42', REPO_ROOT);

    expect(handle).toMatchObject({ created: true });
    expect(git.calls.at(-1)?.args).toEqual([
      'worktree',
      'add',
      `${WT_ROOT}/42`,
      'wip/zz-42',
    ]);
  });

  it('refuses a task id that could escape the worktree root', async () => {
    const git = fakeGit(baseHandlers());
    const manager = new WorktreeManager({ run: git.run });

    for (const taskId of ['', '../escape', 'a/b', 'x'.repeat(65), '.']) {
      await expect(manager.createWorktree(taskId, REPO_ROOT)).rejects.toThrow(
        WorktreeError,
      );
    }
    expect(git.calls).toEqual([]);
  });

  it('reports why the directory is not a repository', async () => {
    const git = fakeGit(() => fail('not a git repository'));
    const manager = new WorktreeManager({ run: git.run });

    await expect(manager.createWorktree('42', '/srv/code')).rejects.toMatchObject({
      code: 'NOT_A_REPO',
    });
  });

  it('will not pass a branch-shaped string that git would read as an option', async () => {
    const git = fakeGit(baseHandlers());
    const manager = new WorktreeManager({ run: git.run });

    await expect(
      manager.createWorktree('42', REPO_ROOT, '--force'),
    ).rejects.toMatchObject({ code: 'INVALID_REF' });
    expect(git.calls).toEqual([]);
  });

  it('keeps the git error when the worktree add itself fails', async () => {
    const git = fakeGit(
      baseHandlers((call) =>
        call.args[0] === 'worktree' && call.args[1] === 'add'
          ? fail('fatal: already checked out')
          : undefined,
      ),
    );
    const manager = new WorktreeManager({ run: git.run });

    await expect(manager.createWorktree('42', REPO_ROOT)).rejects.toMatchObject({
      code: 'GIT_FAILED',
      message: expect.stringContaining('already checked out'),
    });
  });

  it('excludes the worktree root from the repository once, in the local ignore file', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'zhunzou-exclude-'));
    dirs.push(repo);
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '# existing\n');

    const git = fakeGit((call) => {
      const [command, ...rest] = call.args;
      if (command === 'rev-parse' && rest[0] === '--show-toplevel') {
        return ok(`${repo}\n`);
      }
      if (command === 'rev-parse' && rest[0] === '--git-common-dir') {
        return ok('.git\n');
      }
      return defaults(call);
    });
    const manager = new WorktreeManager({ run: git.run });

    await manager.createWorktree('42', repo);
    await manager.createWorktree('43', repo);

    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe(
      '# existing\n/.zhunzou/\n',
    );
  });
});

describe('WorktreeManager.createCheckpoint', () => {
  const registered: Handler = (call) =>
    call.args[0] === 'worktree' && call.args[1] === 'list'
      ? ok(`worktree ${WT_ROOT}/42\nbranch refs/heads/wip/zz-42\n\n`)
      : undefined;

  it('commits the whole worktree, untracked files included', async () => {
    const git = fakeGit(
      baseHandlers((call) => {
        const answered = registered(call);
        if (answered) return answered;
        if (call.args[0] === 'status') return ok('?? new.ts\n');
        if (call.args.join(' ') === 'rev-parse HEAD') return ok('9ab8c7d\n');
        return undefined;
      }),
    );
    const manager = new WorktreeManager({ repoPath: REPO_ROOT, run: git.run });

    const checkpoint = await manager.createCheckpoint('42', 'before heal #1');

    expect(checkpoint).toEqual({ hash: '9ab8c7d', label: 'before heal #1' });
    expect(git.calls.map((call) => call.args.join(' '))).toEqual([
      'rev-parse --show-toplevel',
      'worktree list --porcelain',
      'status --porcelain --untracked-files=all',
      'add -A --',
      'commit -mzhunzou:42 checkpoint: before heal #1',
      'rev-parse HEAD',
    ]);
    expect(git.calls.at(-2)?.cwd).toBe(`${WT_ROOT}/42`);
  });

  it('says nothing was saved when the worktree is clean', async () => {
    const git = fakeGit(
      baseHandlers((call) => {
        const answered = registered(call);
        if (answered) return answered;
        if (call.args[0] === 'status') return ok('');
        return undefined;
      }),
    );
    const manager = new WorktreeManager({ repoPath: REPO_ROOT, run: git.run });

    expect(await manager.createCheckpoint('42', 'idle')).toBeUndefined();
    expect(git.calls.map((call) => call.args[0])).toEqual([
      'rev-parse',
      'worktree',
      'status',
    ]);
  });

  it('still names the snapshot when the caller gave no label', async () => {
    const git = fakeGit(
      baseHandlers((call) => {
        const answered = registered(call);
        if (answered) return answered;
        if (call.args[0] === 'status') return ok(' M app.ts\n');
        return undefined;
      }),
    );
    const manager = new WorktreeManager({ repoPath: REPO_ROOT, run: git.run });

    const checkpoint = await manager.createCheckpoint('42', '   ');

    expect(checkpoint?.label).toBe('checkpoint');
    expect(git.calls.at(-2)?.args).toEqual([
      'commit',
      '-mzhunzou:42 checkpoint: checkpoint',
    ]);
  });

  it('fails loudly when the task has no worktree here', async () => {
    const git = fakeGit(baseHandlers());
    const manager = new WorktreeManager({ repoPath: REPO_ROOT, run: git.run });

    await expect(manager.createCheckpoint('99', 'x')).rejects.toMatchObject({
      code: 'WORKTREE_MISSING',
    });
  });
});

describe('WorktreeManager.squashAndRebase', () => {
  /** A worktree registered under a tip and a final commit that differ. */
  function squashHandlers(extra?: (call: GitCall) => GitResult | undefined): Handler {
    let headAnswers = 0;
    const tips = ['tip111', 'final333'];
    return (call) => {
      if (extra) {
        const answered = extra(call);
        if (answered) return answered;
      }
      const [command, ...rest] = call.args;
      if (command === 'worktree' && rest[0] === 'list') {
        return ok(`worktree ${WT_ROOT}/42\nbranch refs/heads/wip/zz-42\n\n`);
      }
      if (command === 'status') return ok('');
      if (command === 'merge-base') return ok('base123\n');
      if (command === 'rev-parse' && rest[0] === 'HEAD') {
        const hash = tips[Math.min(headAnswers, tips.length - 1)];
        headAnswers += 1;
        return ok(`${hash}\n`);
      }
      return defaults(call);
    };
  }

  it('collapses the wip branch into one commit on top of main', async () => {
    const git = fakeGit(squashHandlers());
    const manager = new WorktreeManager({ repoPath: REPO_ROOT, run: git.run });

    const result = await manager.squashAndRebase('42', 'main', 'feat: task 42');

    expect(result).toEqual({
      taskId: '42',
      workspacePath: `${WT_ROOT}/42`,
      branch: 'wip/zz-42',
      mainBranch: 'main',
      base: 'base123',
      commit: 'final333',
    });
    expect(git.calls.map((call) => call.args.join(' '))).toEqual([
      'rev-parse --show-toplevel',
      'worktree list --porcelain',
      'status --porcelain --untracked-files=all',
      'rev-parse HEAD',
      'merge-base main HEAD',
      'reset --soft base123',
      'commit -mfeat: task 42',
      'rebase --onto main base123',
      'rev-parse HEAD',
    ]);
  });

  it('refuses to rewrite history with uncommitted work in the tree', async () => {
    const git = fakeGit(
      squashHandlers((call) =>
        call.args[0] === 'status' ? ok(' M src/app.ts\n') : undefined,
      ),
    );
    const manager = new WorktreeManager({ repoPath: REPO_ROOT, run: git.run });

    await expect(
      manager.squashAndRebase('42', 'main', 'feat: task 42'),
    ).rejects.toMatchObject({ code: 'WORKTREE_DIRTY' });
    expect(git.calls.map((call) => call.args[0])).toEqual([
      'rev-parse',
      'worktree',
      'status',
    ]);
  });

  it('restores the branch when the rebase conflicts', async () => {
    const git = fakeGit(
      squashHandlers((call) =>
        call.args[0] === 'rebase' ? fail('could not apply') : undefined,
      ),
    );
    const manager = new WorktreeManager({ repoPath: REPO_ROOT, run: git.run });

    await expect(
      manager.squashAndRebase('42', 'main', 'feat: task 42'),
    ).rejects.toMatchObject({ code: 'REBASE_FAILED' });
    expect(git.calls.map((call) => call.args.join(' ')).slice(-2)).toEqual([
      'rebase --abort',
      'reset --hard tip111',
    ]);
  });

  it('will not read a branch-shaped string as an option when rebasing', async () => {
    const git = fakeGit(squashHandlers());
    const manager = new WorktreeManager({ repoPath: REPO_ROOT, run: git.run });

    await expect(
      manager.squashAndRebase('42', '--onto', 'feat: task 42'),
    ).rejects.toMatchObject({ code: 'INVALID_REF' });
    expect(git.calls).toEqual([]);
  });

  it('does not touch the main branch itself', async () => {
    const git = fakeGit(squashHandlers());
    const manager = new WorktreeManager({ repoPath: REPO_ROOT, run: git.run });

    await manager.squashAndRebase('42', 'main', 'feat: task 42');

    const publish = git.calls.filter((call) =>
      ['merge', 'branch', 'push', 'tag'].includes(call.args[0] ?? ''),
    );
    expect(publish).toEqual([]);
  });
});
