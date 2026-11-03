import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  readCurrentRelease,
  resolveInstallRoot,
  resolveReleaseDir,
} from './install-layout.js';
import { BRIDGE_VERSION } from './version.js';

export interface DelegationTarget {
  version: string;
  entry: string;
}

/** Alternate file name between the source build (.js) and the bundle (.mjs). */
function entryCandidates(selfName: string): string[] {
  if (selfName.endsWith('.mjs')) return [selfName, selfName.replace(/\.mjs$/, '.js')];
  if (selfName.endsWith('.js')) return [selfName, selfName.replace(/\.js$/, '.mjs')];
  return [selfName];
}

/**
 * Decide whether this process should hand over to another installed version.
 *
 * Returns `null` when the bootstrap itself is the active release, which is the
 * common case: a fresh install has no `current.json`, and a delegated process
 * runs from a version directory that has no `current.json` of its own.
 */
export function findDelegationTarget(
  selfPath: string,
  currentVersion: string = BRIDGE_VERSION,
): DelegationTarget | null {
  if (process.env.ZHUNZOU_NO_DELEGATE === '1') return null;

  const installRoot = resolveInstallRoot(dirname(selfPath));
  const release = readCurrentRelease(installRoot);
  if (!release || release.version === currentVersion) return null;

  const dir = resolveReleaseDir(installRoot, release);
  const entry = entryCandidates(basename(selfPath))
    .map((name) => join(dir, name))
    .find((candidate) => existsSync(candidate));
  if (!entry) return null;

  return { version: release.version, entry };
}

/**
 * Load the active release into this process. Returns true when the caller
 * must stop doing anything else: the delegated module runs its own main().
 */
export async function delegateToActiveRelease(selfUrl: string): Promise<boolean> {
  const selfPath = fileURLToPath(selfUrl);
  const target = findDelegationTarget(selfPath);
  if (!target) return false;

  process.env.ZHUNZOU_NO_DELEGATE = '1';
  process.stderr.write(
    `[zhunzou] bootstrapping bridge ${target.version} (from ${BRIDGE_VERSION})\n`,
  );
  await import(pathToFileURL(target.entry).href);
  return true;
}
