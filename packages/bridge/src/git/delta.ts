import { createHash } from 'node:crypto';

import { spawnGit, type GitRunner } from './worktree.js';

/**
 * What a run changed in the workspace it owns.
 *
 * The hub can compare two attempts only if the node that held the checkout
 * says what the tree looked like afterwards. This is that one-line answer: a
 * hash over HEAD plus the paths git considers touched. It is used to detect
 * work that never moved, so a node lying about it can only ever stop a retry,
 * never grant one.
 */

export interface WorkspaceDelta {
  head: string;
  /** `git status --porcelain` output for the same tree. */
  porcelain: string;
}

/** Order-independent, whitespace-tolerant hash, short enough for a log column. */
export function fingerprintDelta(delta: WorkspaceDelta): string {
  const touched = delta.porcelain
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort()
    .join('\n');

  return createHash('sha256')
    .update(`${delta.head.trim()}\n${touched}`)
    .digest('hex')
    .slice(0, 32);
}

/** `undefined` when git cannot answer: no repo, no git, no working tree. */
export async function readWorkspaceDelta(
  cwd: string,
  run: GitRunner = spawnGit,
): Promise<WorkspaceDelta | undefined> {
  const head = await run({ args: ['rev-parse', 'HEAD'], cwd });
  if (head.code !== 0) return undefined;

  const status = await run({ args: ['status', '--porcelain'], cwd });
  if (status.code !== 0) return undefined;

  return { head: head.stdout, porcelain: status.stdout };
}

export async function readWorkspaceFingerprint(
  cwd: string,
  run: GitRunner = spawnGit,
): Promise<string | undefined> {
  const delta = await readWorkspaceDelta(cwd, run);
  return delta ? fingerprintDelta(delta) : undefined;
}
