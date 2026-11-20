import { statfsSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';

import type { DeviceStats } from '@zhunzou/shared';

/**
 * Runtime environment of the machine this bridge runs on.
 *
 * Read once per heartbeat: `os` is free, and a single `statfs` answers the
 * "is the disk full?" question that otherwise needs shelling into the box.
 * CPU *usage* is not here — that needs two samples — but the load average is
 * what an operator actually compares to the core count.
 */
export function readHostStats(cwd: string = process.cwd()): DeviceStats {
  const [load1, load5, load15] = loadavg();
  const processors = cpus();
  const stats: DeviceStats = {
    cpuCount: processors.length,
    ...(processors[0]?.model?.trim() ? { cpuModel: processors[0].model.trim() } : {}),
    ...(load1 === undefined ? {} : { load1 }),
    ...(load5 === undefined ? {} : { load5 }),
    ...(load15 === undefined ? {} : { load15 }),
    totalMemBytes: totalmem(),
    freeMemBytes: freemem(),
    uptimeSec: Math.floor(uptime()),
  };

  try {
    const disk = statfsSync(cwd);
    return {
      ...stats,
      diskTotalBytes: Number(disk.blocks) * Number(disk.bsize),
      diskFreeBytes: Number(disk.bavail) * Number(disk.bsize),
    };
  } catch {
    return stats;
  }
}
