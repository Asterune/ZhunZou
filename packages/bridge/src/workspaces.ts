import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';

/**
 * Discover the folders Cursor / VS Code opened recently, without asking the
 * user to copy paths out of the app.
 *
 * Both editors keep that history in `User/globalStorage/storage.json`:
 * `profileAssociations.workspaces` is an object keyed by `file://` URIs, and
 * `backupWorkspaces.workspaces[].folderUri` covers windows that were restored
 * from a backup. Only `file://` entries are useful here — remote, untitled and
 * notebook URIs are not projects on this machine.
 *
 * The format is private and may change between releases, so this reader is
 * deliberately permissive: unknown shapes yield an empty list instead of an
 * error, and the command always requires `--add` before writing anything.
 */

export type EditorFlavor = 'cursor' | 'code';

export interface WorkspaceScanTarget {
  source: string;
  storage: string;
}

export interface ScanWorkspaceOptions {
  platform?: NodeJS.Platform;
  home?: string;
  appData?: string;
  xdgConfigHome?: string;
  flavors?: EditorFlavor[];
}

function appDataDir(options: ScanWorkspaceOptions): string | undefined {
  if (options.appData) return options.appData;
  return process.env.APPDATA;
}

/** `storage.json` locations for each editor on the current platform. */
export function workspaceStoragePaths(
  options: ScanWorkspaceOptions = {},
): WorkspaceScanTarget[] {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const flavors = options.flavors ?? ['cursor', 'code'];
  const targets: WorkspaceScanTarget[] = [];

  for (const flavor of flavors) {
    const productDir = flavor === 'cursor' ? 'Cursor' : 'Code';
    const label = flavor === 'cursor' ? 'Cursor' : 'VS Code';
    if (platform === 'darwin') {
      targets.push({
        source: label,
        storage: join(
          home,
          'Library',
          'Application Support',
          productDir,
          'User',
          'globalStorage',
          'storage.json',
        ),
      });
    } else if (platform === 'win32') {
      const appData = appDataDir(options);
      if (appData) {
        targets.push({
          source: label,
          storage: join(
            appData,
            productDir,
            'User',
            'globalStorage',
            'storage.json',
          ),
        });
      }
    } else {
      const configHome = options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
      const base = configHome ? join(configHome) : join(home, '.config');
      targets.push({
        source: label,
        storage: join(base, productDir, 'User', 'globalStorage', 'storage.json'),
      });
    }
  }

  return targets;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collect `file://` URIs from a parsed storage.json. */
export function workspaceUrisFromStorage(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const uris = new Set<string>();

  const associations = raw.profileAssociations;
  if (isRecord(associations)) {
    for (const key of ['workspaces', 'emptyWindows']) {
      const bucket = associations[key];
      if (!isRecord(bucket)) continue;
      for (const uri of Object.keys(bucket)) uris.add(uri);
    }
  }

  const backups = raw.backupWorkspaces;
  if (isRecord(backups) && Array.isArray(backups.workspaces)) {
    for (const entry of backups.workspaces) {
      if (isRecord(entry) && typeof entry.folderUri === 'string') {
        uris.add(entry.folderUri);
      }
    }
  }

  return [...uris];
}

/**
 * `file:///c%3A/Users/liuqi/work` → `C:/Users/liuqi/work` on Windows,
 * `file:///Users/liuqi/work` → `/Users/liuqi/work` elsewhere.
 *
 * Returns null for remote/untitled/virtual workspaces.
 */
export function fileUriToPath(
  uri: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!uri.startsWith('file://')) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(uri.slice('file://'.length));
  } catch {
    return null;
  }

  // file://host/share/... is a UNC path; keep the host as the first segment.
  if (!decoded.startsWith('/')) {
    const slash = decoded.indexOf('/');
    const host = slash === -1 ? decoded : decoded.slice(0, slash);
    const rest = slash === -1 ? '' : decoded.slice(slash);
    const unc = `//${host}${rest}`;
    return platform === 'win32' ? unc.replace(/\//g, '\\') : unc;
  }

  // Windows URIs look like /c:/Users/... and need the leading slash dropped.
  if (platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(decoded)) {
    return normalize(decoded.slice(1));
  }
  return normalize(decoded);
}

export interface ScanWorkspaceResult {
  source: string;
  storage: string;
  paths: string[];
}

/** Read every known editor storage file and return existing directories. */
export function scanRecentWorkspaces(
  options: ScanWorkspaceOptions = {},
): ScanWorkspaceResult[] {
  const platform = options.platform ?? process.platform;
  const results: ScanWorkspaceResult[] = [];

  for (const target of workspaceStoragePaths({ ...options, platform })) {
    if (!existsSync(target.storage)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(target.storage, 'utf8'));
    } catch {
      // A locked or half-written file is not an error: skip this editor.
      continue;
    }

    const seen = new Set<string>();
    const paths: string[] = [];
    for (const uri of workspaceUrisFromStorage(raw)) {
      const path = fileUriToPath(uri, platform);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      if (!existsSync(path)) continue;
      paths.push(path);
    }
    if (paths.length > 0) {
      results.push({ source: target.source, storage: target.storage, paths });
    }
  }

  return results;
}

/** Exposed for tests: where a flavor keeps its storage file. */
export function storagePathFor(
  flavor: EditorFlavor,
  options: ScanWorkspaceOptions = {},
): string {
  const paths = workspaceStoragePaths({ ...options, flavors: [flavor] });
  return paths[0]?.storage ?? '';
}
