import { z } from 'zod';

/**
 * The hub server's own runtime environment.
 *
 * This is the machine the hub runs on, not a connected agent: CPU, memory,
 * disk, network throughput and the Node process that serves the dashboard.
 * Every optional field means "the platform could not tell us", which the card
 * renders as a dash instead of a fabricated zero.
 */
export const systemStatsSchema = z.object({
  hostname: z.string().trim().min(1).max(160),
  platform: z.string().trim().min(1).max(40),
  release: z.string().trim().min(1).max(160),
  arch: z.string().trim().min(1).max(40),
  uptimeSec: z.number().int().nonnegative(),

  cpu: z.object({
    count: z.number().int().nonnegative(),
    model: z.string().trim().max(200).optional(),
    load1: z.number().nonnegative().optional(),
    load5: z.number().nonnegative().optional(),
    load15: z.number().nonnegative().optional(),
    /** Busy share since the previous sample; absent on the first call. */
    usagePercent: z.number().min(0).max(100).optional(),
  }),

  memory: z.object({
    totalBytes: z.number().int().nonnegative(),
    freeBytes: z.number().int().nonnegative(),
    usedBytes: z.number().int().nonnegative(),
    swapTotalBytes: z.number().int().nonnegative().optional(),
    swapFreeBytes: z.number().int().nonnegative().optional(),
  }),

  disk: z
    .object({
      totalBytes: z.number().int().nonnegative(),
      freeBytes: z.number().int().nonnegative(),
      usedBytes: z.number().int().nonnegative(),
    })
    .optional(),

  network: z
    .object({
      rxBytesPerSec: z.number().nonnegative(),
      txBytesPerSec: z.number().nonnegative(),
      rxBytesTotal: z.number().int().nonnegative(),
      txBytesTotal: z.number().int().nonnegative(),
    })
    .optional(),

  process: z.object({
    rssBytes: z.number().int().nonnegative(),
    uptimeSec: z.number().int().nonnegative(),
    nodeVersion: z.string().trim().min(1).max(20),
  }),

  database: z
    .object({
      bytes: z.number().int().nonnegative(),
      walBytes: z.number().int().nonnegative().optional(),
    })
    .optional(),

  sampledAt: z.number().int().nonnegative(),
});

export type SystemStats = z.infer<typeof systemStatsSchema>;
export type SystemCpuStats = SystemStats['cpu'];
export type SystemMemoryStats = SystemStats['memory'];
export type SystemDiskStats = NonNullable<SystemStats['disk']>;
export type SystemNetworkStats = NonNullable<SystemStats['network']>;
export type SystemProcessStats = SystemStats['process'];
