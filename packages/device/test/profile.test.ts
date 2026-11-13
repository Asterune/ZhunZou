import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildNodeProfile, scanRepos, withFreeMemory } from '../src/profile.js';

let root = '';

function workspace(): string {
  if (!root) root = mkdtempSync(join(tmpdir(), 'zhunzou-profile-'));
  return root;
}

/** Make `dir` look like a checkout, optionally with a given HEAD branch. */
function makeRepo(dir: string, branch = 'main'): void {
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
}

describe('scanRepos', () => {
  it('finds a checkout one level below the scan directory', () => {
    const base = workspace();
    makeRepo(join(base, 'code', 'pte-dojo'));

    expect(scanRepos([join(base, 'code')])).toEqual([
      {
        name: 'pte-dojo',
        path: join(base, 'code', 'pte-dojo'),
        defaultBranch: 'main',
      },
    ]);
  });

  it('searches down to the requested depth and no further', () => {
    const base = workspace();
    makeRepo(join(base, 'deep', 'a', 'b', 'c-repo'));

    expect(scanRepos([join(base, 'deep')], { depth: 2 })).toEqual([]);
    expect(scanRepos([join(base, 'deep')], { depth: 4 }).map((repo) => repo.name)).toEqual([
      'c-repo',
    ]);
  });

  it('counts a linked worktree, whose .git is a file', () => {
    const base = workspace();
    mkdirSync(join(base, 'wt', 'wt-repo'), { recursive: true });
    writeFileSync(join(base, 'wt', 'wt-repo', '.git'), 'gitdir: /elsewhere/.git\n');

    expect(scanRepos([join(base, 'wt')]).map((repo) => repo.name)).toEqual(['wt-repo']);
  });

  it('skips vendored and hidden directories', () => {
    const base = workspace();
    makeRepo(join(base, 'clean', 'node_modules', 'left-pad'));
    makeRepo(join(base, 'clean', '.cache', 'index'));

    expect(scanRepos([join(base, 'clean')])).toEqual([]);
  });

  it('reports one entry per name, the first scan hit winning', () => {
    const base = workspace();
    makeRepo(join(base, 'dupes', 'one', 'pte-dojo'), 'main');
    makeRepo(join(base, 'dupes', 'two', 'pte-dojo'), 'dev');

    const found = scanRepos([join(base, 'dupes')]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: 'pte-dojo', path: join(base, 'dupes', 'one', 'pte-dojo') });
  });

  it('caps the inventory so a hub never receives a giant frame', () => {
    const base = workspace();
    for (let index = 0; index < 55; index += 1) {
      makeRepo(join(base, 'many', `repo-${index}`));
    }

    expect(scanRepos([join(base, 'many')])).toHaveLength(50);
  });

  it('tolerates a directory it cannot read', () => {
    const base = workspace();
    makeRepo(join(base, 'mixed', 'good'));

    expect(scanRepos([join(base, 'missing'), join(base, 'mixed')]).map((r) => r.name)).toEqual([
      'good',
    ]);
  });
});

describe('buildNodeProfile', () => {
  it('fills the routing defaults a worker is expected to have', () => {
    const profile = buildNodeProfile({ hostname: 'studio-mini', nodeId: 'mm-1' });

    expect(profile).toEqual({
      nodeId: 'mm-1',
      hostname: 'studio-mini',
      role: 'worker',
      tags: [],
      maxConcurrency: 1,
      repos: [],
    });
  });

  it('keys the node on its hostname when no id was minted yet', () => {
    expect(buildNodeProfile({ hostname: 'LQ' }).nodeId).toBe('lq');
  });

  it('carries role, tags and capacity through to the hub', () => {
    const profile = buildNodeProfile({
      hostname: 'gpu-box',
      role: 'hybrid',
      tags: ['office', 'gpu'],
      maxConcurrency: 4,
    });

    expect(profile).toMatchObject({ role: 'hybrid', tags: ['office', 'gpu'], maxConcurrency: 4 });
  });

  it('scans the requested directories for checkouts', () => {
    const base = workspace();
    makeRepo(join(base, 'scan-me', 'pte-crawler'), 'master');

    const profile = buildNodeProfile({ hostname: 'mini', scanDirs: [join(base, 'scan-me')] });

    expect(profile.repos).toEqual([
      {
        name: 'pte-crawler',
        path: join(base, 'scan-me', 'pte-crawler'),
        defaultBranch: 'master',
      },
    ]);
  });
});

describe('withFreeMemory', () => {
  it('rewrites only the memory figure, in whole megabytes', () => {
    const profile = buildNodeProfile({ hostname: 'mini', role: 'worker' });

    expect(withFreeMemory(profile, 6 * 1024 ** 3).freeMemoryMB).toBe(6144);
    expect(withFreeMemory(profile, 6 * 1024 ** 3).role).toBe('worker');
  });
});
