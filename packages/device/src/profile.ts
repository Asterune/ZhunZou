import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { NodeProfile, NodeRepo, NodeRole } from '@zhunzou/shared';
import { NODE_ROLES } from '@zhunzou/shared';

/** Vendored trees never hold a checkout a human works in; hidden ones are skipped too. */
const SKIPPED_DIRS = new Set(['node_modules', '.git']);

/** How far below a scan root a checkout may still be counted. */
export const DEFAULT_SCAN_DEPTH = 3;

/** The realtime envelope caps a frame; 50 repos is the contract's own limit. */
export const MAX_REPORTED_REPOS = 50;

interface ScanOptions {
  /** Levels below the root to descend (root children are level 1). */
  depth?: number;
  /** Stop after this many checkouts. */
  limit?: number;
}

function isCheckout(dir: string): boolean {
  try {
    return existsSync(joinSafe(dir, '.git'));
  } catch {
    return false;
  }
}

function joinSafe(parent: string, child: string): string {
  return `${parent.replace(/[\\/]+$/, '')}/${child}`;
}

function readBranch(dir: string): string | undefined {
  try {
    const head = readFileSync(joinSafe(dir, '.git/HEAD'), 'utf8');
    const match = /^ref: refs\/heads\/(.+)$/m.exec(head);
    const branch = match?.[1]?.trim();
    return branch ? branch.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

function listEntries(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    // A missing or unreadable root is not an error: the operator may have
    // passed a volume that is not mounted on this boot.
    return [];
  }
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isScannable(name: string): boolean {
  return !name.startsWith('.') && !SKIPPED_DIRS.has(name);
}

/**
 * Find the git checkouts under the given roots, breadth-first within a root.
 *
 * Sorting each directory makes "the first scan hit wins" deterministic, so a
 * repo cloned in two places reports the same path on every heartbeat.
 */
export function scanRepos(
  roots: readonly string[],
  options: ScanOptions = {},
): NodeRepo[] {
  const depth = Math.max(1, options.depth ?? DEFAULT_SCAN_DEPTH);
  const limit = Math.min(options.limit ?? MAX_REPORTED_REPOS, MAX_REPORTED_REPOS);
  const found: NodeRepo[] = [];
  const seen = new Set<string>();

  for (const level of descend(roots, depth)) {
    for (const dir of level) {
      if (found.length >= limit) break;
      const name = basename(dir);
      if (!name || !isCheckout(dir)) continue;
      if (seen.has(name) || seen.has(dir)) continue;
      seen.add(name);
      seen.add(dir);
      const branch = readBranch(dir);
      found.push({
        name: name.slice(0, 128),
        path: dir,
        ...(branch ? { defaultBranch: branch } : {}),
      });
    }
    if (found.length >= limit) break;
  }

  return found;
}

/** Directories at level 1, then 2, … so shallower clones win. */
function descend(roots: readonly string[], depth: number): string[][] {
  const levels: string[][] = [];
  let current = roots.map((root) => resolve(root)).filter(isDirectory);

  for (let level = 1; level <= depth; level += 1) {
    const next: string[] = [];
    const children: string[] = [];

    for (const dir of current) {
      for (const name of listEntries(dir)) {
        if (!isScannable(name)) continue;
        const child = joinSafe(dir, name);
        if (!isDirectory(child)) continue;
        children.push(child);
        next.push(child);
      }
    }

    levels.push(children);
    current = next;
  }

  return levels;
}

function basename(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '');
  const index = Math.max(
    trimmed.lastIndexOf('/'),
    trimmed.lastIndexOf('\\'),
    trimmed.indexOf(':'),
  );
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

export interface NodeProfileInput {
  hostname: string;
  /** Stable identity; defaults to a slug of the hostname. */
  nodeId?: string;
  role?: NodeRole;
  tags?: readonly string[];
  maxConcurrency?: number;
  /** Roots to search for checkouts; omit for a presence-only node. */
  scanDirs?: readonly string[];
  scanDepth?: number;
  freeMemoryMB?: number;
}

/** The hub keys its registry on `deviceId`, so this is only a hint. */
function slugifyHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
}

function bounded(value: number | undefined, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Assemble the profile the hub routes on; unset fields keep protocol defaults. */
export function buildNodeProfile(input: NodeProfileInput): NodeProfile {
  const hostname = input.hostname.trim().slice(0, 120) || 'unknown';
  const tags = (input.tags ?? [])
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 10);
  const repos = input.scanDirs?.length
    ? scanRepos(input.scanDirs, { ...(input.scanDepth ? { depth: input.scanDepth } : {}) })
    : [];

  return {
    nodeId: input.nodeId?.trim().slice(0, 64) || slugifyHostname(hostname),
    hostname,
    role: input.role && NODE_ROLES.includes(input.role) ? input.role : 'worker',
    tags,
    maxConcurrency: bounded(input.maxConcurrency, 1, 16),
    repos,
    ...(input.freeMemoryMB === undefined
      ? {}
      : { freeMemoryMB: bounded(input.freeMemoryMB, 0, Number.MAX_SAFE_INTEGER) }),
  };
}

/** Attach a live memory figure to a profile without touching the inventory. */
export function withFreeMemory(
  profile: NodeProfile,
  freeMemBytes: number,
): NodeProfile {
  return {
    ...profile,
    freeMemoryMB: Math.max(0, Math.floor(freeMemBytes / 1024 / 1024)),
  };
}
