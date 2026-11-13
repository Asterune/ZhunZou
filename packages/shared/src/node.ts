import { z } from 'zod';

import { NODE_ROLES, TASK_ENGINES } from './constants.js';
import type { DeviceStats } from './device.js';

/**
 * The node contract: what a machine says about itself when it joins, and what
 * the hub needs to decide whether work may land on it.
 */

/** A repository the node can actually run an agent inside. */
export const nodeRepoSchema = z.object({
  /** Basename of the checkout, the key the scheduler matches a task on. */
  name: z.string().trim().min(1).max(128),
  /** Absolute path on that machine; relative guesses would be unrouteable. */
  path: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .regex(/^([/\\]|[A-Za-z]:[\\/])/, 'repo path must be absolute'),
  defaultBranch: z.string().trim().min(1).max(120).optional(),
  /** False when the checkout vanished between two scans. */
  ready: z.boolean().optional(),
});

export type NodeRepo = z.infer<typeof nodeRepoSchema>;

export const nodeProfileSchema = z.object({
  /** Stable per-machine identity; the hub keys its node registry on it. */
  nodeId: z.string().trim().min(1).max(64),
  hostname: z.string().trim().min(1).max(120),
  role: z.enum(NODE_ROLES).default('worker'),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  /** Free memory in MB at report time; `deviceStats.freeMemBytes` is the fallback. */
  freeMemoryMB: z.number().int().nonnegative().optional(),
  maxConcurrency: z.number().int().min(1).max(16).default(1),
  repos: z.array(nodeRepoSchema).max(50).default([]),
});

export type NodeProfile = z.infer<typeof nodeProfileSchema>;

/** Which local CLI runs a task; the blueprint names `cursor` and `opencode`. */
export const taskEngineSchema = z.enum(TASK_ENGINES);

/** A profile may arrive without a memory figure; the snapshot completes it. */
export function nodeFreeMemoryMB(
  profile: Pick<NodeProfile, 'freeMemoryMB'>,
  stats?: Pick<DeviceStats, 'freeMemBytes'>,
): number | undefined {
  if (typeof profile.freeMemoryMB === 'number') return profile.freeMemoryMB;
  if (typeof stats?.freeMemBytes === 'number') {
    return Math.floor(stats.freeMemBytes / 1024 / 1024);
  }
  return undefined;
}

/**
 * Everything needed to continue an engine session where it stopped: the hub
 * keeps the native id and releases the child process instead of replaying it.
 */
export const sessionRecordSchema = z.object({
  engine: z.enum(TASK_ENGINES),
  /** Engine-native id (Cursor `--resume`, OpenCode session id). */
  sessionId: z.string().trim().min(1).max(128),
  cwd: z.string().trim().max(1024).optional(),
  /** Isolated checkout the session runs in, when the task uses one. */
  workspacePath: z.string().trim().max(1024).optional(),
  /** argv the engine needs to reopen the session, e.g. `["--resume", "cs-1"]`. */
  resumeArgs: z.array(z.string().trim().max(512)).max(20).optional(),
  resumable: z.boolean().default(false),
  lastEventAt: z.number().int().nonnegative().optional(),
});

export type SessionRecord = z.infer<typeof sessionRecordSchema>;
