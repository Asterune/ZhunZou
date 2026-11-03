import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * On-disk layout of a self-updating install:
 *
 * ```text
 * zhunzou-bridge/
 * ├── mcp.mjs          # bootstrap shipped with the zip, delegates to current
 * ├── cli.mjs          # bootstrap, same deal
 * ├── current.json     # { "version": "0.2.0" }  <- the only file upgrade rewrites
 * └── versions/
 *     ├── 0.1.0/{mcp.mjs,cli.mjs}
 *     └── 0.2.0/{mcp.mjs,cli.mjs}
 * ```
 *
 * `upgrade` never overwrites a file that may be executing: it downloads into a
 * fresh `versions/<v>/` folder and flips `current.json`. That keeps Windows
 * file locking out of the picture and makes rollback a one-line change.
 */
export const VERSIONS_DIR = 'versions';
export const CURRENT_FILE = 'current.json';

export interface CurrentRelease {
  version: string;
  updatedAt?: number;
  /** Relative directory holding this version; defaults to versions/<version>. */
  dir?: string;
}

/** Walk out of `versions/<v>/` when the entry point runs from a version dir. */
export function resolveInstallRoot(from: string): string {
  const dir = resolve(from);
  return basename(dirname(dir)) === VERSIONS_DIR ? dirname(dirname(dir)) : dir;
}

export function versionsRoot(installRoot: string): string {
  return join(installRoot, VERSIONS_DIR);
}

export function versionDir(installRoot: string, version: string): string {
  return join(versionsRoot(installRoot), version);
}

export function readCurrentRelease(installRoot: string): CurrentRelease | null {
  const file = join(installRoot, CURRENT_FILE);
  if (!existsSync(file)) return null;

  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const version = (raw as { version?: unknown }).version;
    if (typeof version !== 'string' || version.trim() === '') return null;
    const dir = (raw as { dir?: unknown }).dir;
    const updatedAt = (raw as { updatedAt?: unknown }).updatedAt;
    return {
      version: version.trim(),
      ...(typeof dir === 'string' && dir.trim() !== '' ? { dir: dir.trim() } : {}),
      ...(typeof updatedAt === 'number' ? { updatedAt } : {}),
    };
  } catch {
    return null;
  }
}

/** Write `current.json` atomically so a crash never leaves half a pointer. */
export function writeCurrentRelease(
  installRoot: string,
  release: CurrentRelease,
): void {
  const file = join(installRoot, CURRENT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  const payload: CurrentRelease = {
    version: release.version,
    updatedAt: release.updatedAt ?? Date.now(),
    ...(release.dir ? { dir: release.dir } : {}),
  };
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/** Absolute directory for a release; `<root>` when the entry has no dir. */
export function resolveReleaseDir(
  installRoot: string,
  release: CurrentRelease,
): string {
  return release.dir ? resolve(installRoot, release.dir) : versionDir(installRoot, release.version);
}
