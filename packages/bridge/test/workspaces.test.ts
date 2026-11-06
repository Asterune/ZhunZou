import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  fileUriToPath,
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
