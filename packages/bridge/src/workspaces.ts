import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
} from 'node:path';

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

/* ------------------------------------------------------------------ */
/* Filesystem discovery                                                */
/* ------------------------------------------------------------------ */

export interface ScanProjectDirectoriesOptions {
  /** Absolute root directories to search. Supports multiple roots. */
  roots: string[];
  /**
   * How many levels below each root to search. `0` only checks the root
   * itself, `1` adds its direct children, `2` adds grandchildren.
   */
  depth?: number;
  /** Safety cap so a mistaken `~` scan cannot walk forever. */
  maxResults?: number;
  /** Directory names that never contain a project root (dependencies/builds). */
  ignore?: Iterable<string>;
}

/**
 * Directory names that are useful to skip: dependency trees and build output
 * can contain thousands of nested folders and (for npm packages) their own
 * `package.json`, never a project the user wants to host.
 */
const DEFAULT_IGNORED_DIRS = [
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'pod',
  'pods',
  'deriveddata',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.idea',
  '.vscode',
  '.git',
  '.hg',
  '.svn',
];

function isProjectRoot(dir: string): boolean {
  try {
    // `.git` is a directory in normal clones and a file in worktrees; stat
    // accepts both without following the path any further.
    statSync(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Find git repositories under one or more roots.
 *
 * A directory stops the walk as soon as it looks like a repository, so a
 * monorepo is reported once (at its root) instead of once per workspace
 * package. Hidden directories, dependency trees and build output are skipped.
 */
export function scanProjectDirectories(
  options: ScanProjectDirectoriesOptions,
): string[] {
  const depth = Math.max(
    0,
    Math.min(8, Math.floor(options.depth ?? 2)),
  );
  const maxResults = Math.max(1, options.maxResults ?? 200);
  const ignored = new Set(
    [...DEFAULT_IGNORED_DIRS, ...(options.ignore ?? [])].map((name) =>
      name.toLowerCase(),
    ),
  );
  const found = new Map<string, number>();

  const visit = (dir: string, level: number): void => {
    if (found.size >= maxResults) return;

    const absolute = resolve(dir);
    if (isProjectRoot(absolute)) {
      if (!found.has(absolute)) found.set(absolute, level);
      return;
    }
    if (level >= depth) return;

    let entries: Dirent[];
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      // Permission denied or a file removed mid-scan: skip this branch.
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (found.size >= maxResults) return;
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (ignored.has(entry.name.toLowerCase())) continue;
      visit(join(absolute, entry.name), level + 1);
    }
  };

  for (const root of options.roots) {
    if (!root) continue;
    try {
      if (!statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    visit(root, 0);
  }

  return [...found.keys()].sort();
}

/* ------------------------------------------------------------------ */
/* Dashboard directory browser                                         */
/* ------------------------------------------------------------------ */

export interface BrowseEntry {
  name: string;
  path: string;
  isRepo: boolean;
  isDirectory: boolean;
}

export interface BrowseDirectoryResult {
  path: string;
  parent?: string;
  home: string;
  isRepo: boolean;
  entries: BrowseEntry[];
}

export interface BrowseDirectoryOptions {
  /** Empty/undefined starts at home. Supports `~` and relative paths. */
  path?: string;
  home?: string;
  /** Configured scan roots; paths under these are also browsable. */
  roots?: string[];
  maxEntries?: number;
}

/** Directories that are never useful to browse as a project. */
const BROWSER_IGNORED_DIRS = [
  ...DEFAULT_IGNORED_DIRS,
  'library',
  'applications',
  'movies',
  'music',
  'pictures',
];

function expandTilde(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(home, value.slice(2));
  }
  return value;
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * List the immediate subdirectories of one folder for the dashboard picker.
 *
 * The bridge is the security boundary: only the home directory and configured
 * scan roots are browsable, hidden segments are rejected, and symlinks are
 * resolved before the check so a link cannot escape the allowlist.
 */
export function browseDirectory(
  options: BrowseDirectoryOptions = {},
): BrowseDirectoryResult {
  const home = realpathOrResolve(options.home ?? homedir());
  const roots = (options.roots ?? []).map((root) =>
    realpathOrResolve(expandTilde(root, home)),
  );
  const allowedRoots = [...roots, home];
  const maxEntries = Math.max(1, options.maxEntries ?? 300);

  const raw = (options.path ?? '').trim();
  const expanded = raw ? expandTilde(raw, home) : home;
  const target = raw
    ? resolve(isAbsolute(expanded) ? expanded : join(home, expanded))
    : home;
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw new Error(`目录不存在：${target}`);
  }

  try {
    if (!statSync(real).isDirectory()) {
      throw new Error(`不是目录：${real}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('不是目录')) {
      throw error;
    }
    throw new Error(`无法读取目录：${real}`);
  }

  const fold =
    process.platform === 'win32'
      ? (value: string) => value.toLowerCase()
      : (value: string) => value;
  const isUnder = (path: string, root: string): boolean => {
    const foldedPath = fold(path);
    const foldedRoot = fold(root);
    return (
      foldedPath === foldedRoot ||
      foldedPath.startsWith(`${foldedRoot}${sep}`)
    );
  };

  const matchedRoot = allowedRoots.find((root) => isUnder(real, root));
  if (!matchedRoot) {
    throw new Error('目录不在允许浏览的范围内');
  }

  const relative = real.slice(matchedRoot.length);
  if (relative.split(sep).some((segment) => segment.startsWith('.'))) {
    throw new Error('不能浏览隐藏目录');
  }

  const ignored = new Set(BROWSER_IGNORED_DIRS.map((name) => name.toLowerCase()));
  let dirents: Dirent[];
  try {
    dirents = readdirSync(real, { withFileTypes: true });
  } catch {
    throw new Error(`无法读取目录：${real}`);
  }

  const entries = dirents
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        !ignored.has(entry.name.toLowerCase()),
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, maxEntries)
    .map((entry) => {
      const path = join(real, entry.name);
      return {
        name: entry.name,
        path,
        isRepo: isProjectRoot(path),
        isDirectory: true,
      };
    });

  const parent = dirname(real);
  const parentAllowed = allowedRoots.some((root) => isUnder(parent, root));

  return {
    path: real,
    ...(parentAllowed && parent !== real ? { parent } : {}),
    home,
    isRepo: isProjectRoot(real),
    entries,
  };
}
