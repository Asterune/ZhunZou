import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  browseDirectory,
  fileUriToPath,
  scanProjectDirectories,
  scanRecentWorkspaces,
  workspaceStoragePaths,
  workspaceUrisFromStorage,
} from '../src/workspaces.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-scan-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace discovery', () => {
  it('collects workspace URIs from profile associations and backups', () => {
    const uris = workspaceUrisFromStorage({
      profileAssociations: {
        workspaces: {
          'file:///Users/liuqi/work/erp': 'default',
          'vscode-remote://ssh-remote+host/work/remote': 'default',
        },
        emptyWindows: { 'file:///Users/liuqi/work/solo': 'default' },
      },
      backupWorkspaces: {
        workspaces: [
          { folderUri: 'file:///Users/liuqi/work/backup' },
          { folderUri: 'untitled:Untitled-1' },
        ],
      },
    });

    expect(uris.sort()).toEqual([
      'file:///Users/liuqi/work/backup',
      'file:///Users/liuqi/work/erp',
      'file:///Users/liuqi/work/solo',
      'untitled:Untitled-1',
      'vscode-remote://ssh-remote+host/work/remote',
    ]);
  });

  it('ignores malformed storage instead of throwing', () => {
    expect(workspaceUrisFromStorage(null)).toEqual([]);
    expect(workspaceUrisFromStorage({ profileAssociations: 'nope' })).toEqual([]);
  });

  it('decodes file URIs for POSIX, Windows and UNC paths', () => {
    expect(fileUriToPath('file:///Users/liuqi/my%20project', 'darwin')).toBe(
      '/Users/liuqi/my project',
    );
    expect(fileUriToPath('file:///c%3A/Users/liuqi/work', 'win32')).toBe(
      'c:/Users/liuqi/work',
    );
    expect(fileUriToPath('file:///C:/Users/liuqi/work', 'win32')).toBe(
      'C:/Users/liuqi/work',
    );
    expect(fileUriToPath('file://server/share/project', 'win32')).toBe(
      '\\\\server\\share\\project',
    );
    expect(fileUriToPath('file://server/share/project', 'darwin')).toBe(
      '//server/share/project',
    );
    expect(fileUriToPath('vscode-remote://ssh-remote+host/x', 'darwin')).toBeNull();
    expect(fileUriToPath('untitled:Untitled-1', 'darwin')).toBeNull();
  });

  it('resolves per-editor storage paths', () => {
    const darwin = workspaceStoragePaths({
      platform: 'darwin',
      home: '/Users/liuqi',
    });
    expect(darwin.map((target) => target.storage)).toEqual([
      '/Users/liuqi/Library/Application Support/Cursor/User/globalStorage/storage.json',
      '/Users/liuqi/Library/Application Support/Code/User/globalStorage/storage.json',
    ]);

    const windows = workspaceStoragePaths({
      platform: 'win32',
      appData: 'C:\\Users\\liuqi\\AppData\\Roaming',
    });
    expect(windows[0]!.storage).toContain('Cursor');
    expect(windows[0]!.storage.endsWith('storage.json')).toBe(true);

    const linux = workspaceStoragePaths({
      platform: 'linux',
      home: '/home/liuqi',
      xdgConfigHome: '/home/liuqi/.config',
    });
    expect(linux[0]!.storage).toBe(
      '/home/liuqi/.config/Cursor/User/globalStorage/storage.json',
    );
  });

  it('returns only existing directories, deduplicated', () => {
    const home = tempDir();
    const project = join(home, 'work', 'erp');
    const other = join(home, 'work', 'crm');
    mkdirSync(project, { recursive: true });
    mkdirSync(other, { recursive: true });

    const storage = join(
      home,
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
    );
    mkdirSync(storage, { recursive: true });
    writeFileSync(
      join(storage, 'storage.json'),
      JSON.stringify({
        profileAssociations: {
          workspaces: {
            [pathToFileUri(project)]: 'default',
            [pathToFileUri(project)]: 'default',
            [pathToFileUri(other)]: 'default',
            [pathToFileUri(join(home, 'work', 'gone'))]: 'default',
            'vscode-remote://ssh-remote+host/remote': 'default',
          },
        },
      }),
    );

    const results = scanRecentWorkspaces({
      platform: 'darwin',
      home,
      flavors: ['cursor'],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.source).toBe('Cursor');
    expect(results[0]!.paths.sort()).toEqual([other, project].sort());
  });
});

function pathToFileUri(path: string): string {
  return `file://${encodeURI(path)}`.replace(/%2F/g, '/');
}

describe('directory discovery', () => {
  it('finds git repos at the configured depth and stops at repo roots', () => {
    const root = tempDir();
    const direct = join(root, 'alpha');
    const nested = join(root, 'team', 'beta');
    const deep = join(root, 'team', 'beta', 'packages', 'deep');
    const dependency = join(root, 'node_modules', 'pkg');
    const hidden = join(root, '.hidden', 'repo');
    const worktree = join(root, 'worktree');

    for (const dir of [
      direct,
      nested,
      deep,
      dependency,
      hidden,
      worktree,
    ]) {
      mkdirSync(join(dir, '.git'), { recursive: true });
    }
    // A worktree keeps `.git` as a file instead of a directory.
    rmSync(join(worktree, '.git'), { recursive: true, force: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: /tmp/somewhere\n');

    expect(scanProjectDirectories({ roots: [root], depth: 1 })).toEqual([
      direct,
      worktree,
    ]);
    expect(scanProjectDirectories({ roots: [root], depth: 2 })).toEqual([
      direct,
      nested,
      worktree,
    ]);
  });

  it('treats a repository root passed as --root as the project itself', () => {
    const root = tempDir();
    const project = join(root, 'app');
    const child = join(project, 'packages', 'child');
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(join(child, '.git'), { recursive: true });

    expect(scanProjectDirectories({ roots: [project], depth: 2 })).toEqual([
      project,
    ]);
  });

  it('ignores missing roots and caps results', () => {
    const root = tempDir();
    for (const name of ['a', 'b', 'c']) {
      mkdirSync(join(root, name, '.git'), { recursive: true });
    }

    expect(
      scanProjectDirectories({ roots: [join(root, 'missing'), root], depth: 1 }),
    ).toEqual([join(root, 'a'), join(root, 'b'), join(root, 'c')]);
    expect(
      scanProjectDirectories({ roots: [root], depth: 1, maxResults: 2 }),
    ).toHaveLength(2);
  });
});

describe('directory browser', () => {
  it('lists immediate subdirectories and marks git repos', () => {
    const home = tempDir();
    mkdirSync(join(home, 'code', 'repo', '.git'), { recursive: true });
    mkdirSync(join(home, 'code', 'plain'), { recursive: true });
    mkdirSync(join(home, 'code', 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(home, 'code', '.hidden', 'repo'), { recursive: true });

    const realHome = realpathSync(home);
    const result = browseDirectory({ home, path: 'code' });

    expect(result.path).toBe(join(realHome, 'code'));
    expect(result.parent).toBe(realHome);
    expect(result.isRepo).toBe(false);
    expect(result.entries.map((entry) => entry.name)).toEqual([
      'plain',
      'repo',
    ]);
    expect(result.entries.find((entry) => entry.name === 'repo')?.isRepo).toBe(
      true,
    );
    expect(result.entries.find((entry) => entry.name === 'plain')?.isRepo).toBe(
      false,
    );
  });

  it('starts at home and accepts ~ paths', () => {
    const home = tempDir();
    mkdirSync(join(home, 'work'), { recursive: true });
    const realHome = realpathSync(home);

    expect(browseDirectory({ home }).path).toBe(realHome);
    expect(browseDirectory({ home, path: '~/work' }).path).toBe(
      join(realHome, 'work'),
    );
  });

  it('rejects hidden paths, paths outside the allowlist and symlink escapes', () => {
    const home = tempDir();
    const outside = tempDir();
    mkdirSync(join(home, '.ssh'), { recursive: true });
    mkdirSync(join(home, 'code', 'repo', '.git'), { recursive: true });
    mkdirSync(join(outside, 'secret'), { recursive: true });
    symlinkSync(outside, join(home, 'escape'));

    expect(() => browseDirectory({ home, path: '.ssh' })).toThrow(
      /隐藏目录/,
    );
    expect(() => browseDirectory({ home, path: '/etc' })).toThrow(
      /允许浏览/,
    );
    expect(() => browseDirectory({ home, path: 'escape/secret' })).toThrow(
      /允许浏览/,
    );
    expect(() => browseDirectory({ home, path: 'missing' })).toThrow(
      /不存在/,
    );
  });

  it('allows configured scan roots outside home', () => {
    const home = tempDir();
    const work = tempDir();
    mkdirSync(join(work, 'repo', '.git'), { recursive: true });

    const result = browseDirectory({ home, roots: [work], path: work });
    expect(result.entries.map((entry) => entry.name)).toEqual(['repo']);
  });
});
