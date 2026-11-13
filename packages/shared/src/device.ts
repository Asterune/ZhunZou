import { z } from 'zod';

import type { NodeProfile } from './node.js';

/**
 * Version of the device ↔ hub realtime protocol. Bump only on breaking frame
 * changes; clients send it in `hello` so the hub can reject incompatible peers.
 */
export const DEVICE_PROTOCOL_VERSION = 1;

/** A CLI/tool the device can actually run locally. */
export const deviceToolSchema = z.object({
  name: z.string().trim().min(1).max(64),
  path: z.string().trim().max(512).optional(),
  version: z.string().trim().max(120).optional(),
});

export type DeviceTool = z.infer<typeof deviceToolSchema>;

/** Cheap machine-load snapshot collected with every hello / heartbeat. */
export const deviceStatsSchema = z.object({
  cpuCount: z.number().int().nonnegative().optional(),
  load1: z.number().nonnegative().optional(),
  load5: z.number().nonnegative().optional(),
  load15: z.number().nonnegative().optional(),
  totalMemBytes: z.number().int().nonnegative().optional(),
  freeMemBytes: z.number().int().nonnegative().optional(),
  uptimeSec: z.number().int().nonnegative().optional(),
});

export type DeviceStats = z.infer<typeof deviceStatsSchema>;

export const DEVICE_PTY_BACKENDS = ['conpty', 'forkpty', 'none'] as const;
export type DevicePtyBackend = (typeof DEVICE_PTY_BACKENDS)[number];

export const devicePtySchema = z.object({
  available: z.boolean(),
  backend: z.enum(DEVICE_PTY_BACKENDS).optional(),
  shell: z.string().trim().max(512).optional(),
});

export type DevicePty = z.infer<typeof devicePtySchema>;

/**
 * Everything the hub needs to route work to a device.
 *
 * `tools` is an inventory, not a promise: the console can show "claude 1.2.3"
 * and a future terminal session can still fail if the binary was removed.
 */
export const deviceCapabilitiesSchema = z.object({
  protocol: z.number().int().positive().default(DEVICE_PROTOCOL_VERSION),
  os: z.string().trim().min(1).max(60),
  arch: z.string().trim().min(1).max(40),
  hostname: z.string().trim().min(1).max(120),
  /**
   * Fingerprint the client generated once and keeps on disk. A hostname is not
   * an identity: imaged machines share one and renamed machines lose theirs.
   */
  machineId: z.string().trim().min(8).max(64).optional(),
  release: z.string().trim().max(120).optional(),
  shell: z.string().trim().max(512).optional(),
  pty: devicePtySchema.optional(),
  tools: z.array(deviceToolSchema).max(50).default([]),
  features: z.array(z.string().trim().max(40)).max(20).default([]),
});

export type DeviceCapabilities = z.infer<typeof deviceCapabilitiesSchema>;

/** Payload the device sends when it opens (or re-opens) the hub socket. */
export const deviceHelloSchema = z.object({
  env: z.string().trim().min(1).max(64).optional(),
  projectName: z.string().trim().min(1).max(128).optional(),
  protocol: z.number().int().positive().default(DEVICE_PROTOCOL_VERSION),
  capabilities: deviceCapabilitiesSchema,
  stats: deviceStatsSchema.optional(),
});

export type DeviceHello = z.infer<typeof deviceHelloSchema>;

/** Realtime transport currently attached to an agent, if any. */
export const DEVICE_TRANSPORTS = ['ws', 'http'] as const;
export type DeviceTransport = (typeof DEVICE_TRANSPORTS)[number];

/** Persisted device state when a realtime peer says hello / beats. */
export interface DeviceConnectionInput {
  env: string;
  projectName?: string;
  protocolVersion: number;
  capabilities: DeviceCapabilities;
  stats?: DeviceStats;
  transport: DeviceTransport;
  /**
   * Placement profile (role, tags, repos, memory). Absent on a client too old
   * to report one; the hub then keeps whatever profile the card already has.
   */
  profile?: NodeProfile;
}
