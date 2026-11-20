import { readFileSync, statSync, statfsSync } from 'node:fs';
import {
  arch,
  cpus,
  freemem,
  hostname,
  loadavg,
  platform,
  release,
  totalmem,
  uptime,
} from 'node:os';
import { dirname } from 'node:path';

import type { SystemStats } from '@zhunzou/shared';

/** CPU counters parsed from the first `/proc/stat` line. */
export interface CpuTimes {
  total: number;
  idle: number;
}

/** Summed interface counters from `/proc/net/dev`. */
export interface NetTotals {
  rx: number;
  tx: number;
}

/**
 * `cpu  user nice system idle iowait irq softirq steal guest guest_nice`
 *
 * Idle time includes iowait: a disk-bound box is not "busy CPU", and counting
 * it as busy is what makes a healthy server look pinned.
 */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split('\n').find((item) => item.startsWith('cpu '));
  if (!line) return null;

  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((value) => !Number.isFinite(value))) {
    return null;
  }

  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] =
    fields as [number, number, number, number, number?, number?, number?, number?];

  return {
    total: user + nice + system + idle + iowait + irq + softirq + steal,
    idle: idle + iowait,
  };
}

/**
 * One line per interface: `eth0: rxBytes rxPackets … txBytes txPackets …`.
 * Loopback is included too; a local-only service would otherwise show zero
 * traffic while it is clearly working.
 */
export function parseProcNetDev(text: string): NetTotals {
  let rx = 0;
  let tx = 0;

  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;

    const fields = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    if (fields.length < 16 || fields.some((value) => !Number.isFinite(value))) {
      continue;
    }

    rx += fields[0]!;
    tx += fields[8]!;
  }

  return { rx, tx };
}

/** Swap figures from `/proc/meminfo`, in bytes. */
export function parseMemInfo(text: string): {
  swapTotalBytes?: number;
  swapFreeBytes?: number;
} {
  const kb = (key: string): number | undefined => {
    const match = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
    return match ? Number(match[1]) * 1024 : undefined;
  };

  const swapTotalBytes = kb('SwapTotal');
  const swapFreeBytes = kb('SwapFree');
  return {
    ...(swapTotalBytes === undefined ? {} : { swapTotalBytes }),
    ...(swapFreeBytes === undefined ? {} : { swapFreeBytes }),
  };
}

/** Busy CPU share between two counter snapshots, as a percentage. */
export function busyPercent(prev: CpuTimes, cur: CpuTimes): number | undefined {
  const total = cur.total - prev.total;
  const idle = cur.idle - prev.idle;
  if (total <= 0 || idle < 0) return undefined;
  return Math.min(100, Math.max(0, Math.round((1 - idle / total) * 1000) / 10));
}

/** Bytes per second between two counter snapshots. */
export function perSec(prev: number, cur: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || cur < prev) return 0;
  return Math.round(((cur - prev) * 1000) / elapsedMs);
}

export interface SystemSamplerOptions {
  now?: () => number;
  /** Reads a proc file, or null when the platform does not expose it. */
  readFile?: (path: string) => string | null;
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Samples the hub host. Keep one instance per process: CPU and network rates
 * are differences against the previous `sample()` call.
 */
export class SystemSampler {
  private prevCpu: CpuTimes | null = null;
  private prevNet: NetTotals | null = null;
  private prevAt = 0;

  constructor(
    private readonly dbPath: string,
    private readonly options: SystemSamplerOptions = {},
  ) {}

  sample(): SystemStats {
    const now = this.options.now?.() ?? Date.now();
    const readFile = this.options.readFile ?? readFileOrNull;
    const elapsedMs = this.prevAt === 0 ? 0 : now - this.prevAt;

    const cpuText = readFile('/proc/stat');
    const cpu = cpuText ? parseProcStat(cpuText) : null;
    const netText = readFile('/proc/net/dev');
    const net = netText ? parseProcNetDev(netText) : null;
    const memText = readFile('/proc/meminfo');
    const swap = memText ? parseMemInfo(memText) : {};

    const usagePercent =
      cpu && this.prevCpu ? busyPercent(this.prevCpu, cpu) : undefined;

    const network = net
      ? {
          rxBytesPerSec: this.prevNet
            ? perSec(this.prevNet.rx, net.rx, elapsedMs)
            : 0,
          txBytesPerSec: this.prevNet
            ? perSec(this.prevNet.tx, net.tx, elapsedMs)
            : 0,
          rxBytesTotal: net.rx,
          txBytesTotal: net.tx,
        }
      : undefined;

    this.prevCpu = cpu;
    this.prevNet = net;
    this.prevAt = now;

    const totalBytes = totalmem();
    const freeBytes = freemem();
    const [load1, load5, load15] = loadavg();
    const firstCpu = cpus()[0];

    return {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      arch: arch(),
      uptimeSec: Math.floor(uptime()),
      cpu: {
        count: cpus().length,
        ...(firstCpu?.model ? { model: firstCpu.model.trim() } : {}),
        ...(load1 === undefined ? {} : { load1 }),
        ...(load5 === undefined ? {} : { load5 }),
        ...(load15 === undefined ? {} : { load15 }),
        ...(usagePercent === undefined ? {} : { usagePercent }),
      },
      memory: {
        totalBytes,
        freeBytes,
        usedBytes: Math.max(0, totalBytes - freeBytes),
        ...swap,
      },
      disk: this.disk(),
      network,
      process: {
        rssBytes: process.memoryUsage().rss,
        uptimeSec: Math.floor(process.uptime()),
        nodeVersion: process.version,
      },
      database: this.database(),
      sampledAt: now,
    };
  }

  private disk(): SystemStats['disk'] {
    try {
      const stats = statfsSync(dirname(this.dbPath));
      const totalBytes = Number(stats.blocks) * Number(stats.bsize);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      return {
        totalBytes,
        freeBytes,
        usedBytes: Math.max(0, totalBytes - freeBytes),
      };
    } catch {
      return undefined;
    }
  }

  private database(): SystemStats['database'] {
    try {
      const bytes = statSync(this.dbPath).size;
      let walBytes: number | undefined;
      try {
        walBytes = statSync(`${this.dbPath}-wal`).size;
      } catch {
        walBytes = undefined;
      }
      return {
        bytes,
        ...(walBytes === undefined ? {} : { walBytes }),
      };
    } catch {
      return undefined;
    }
  }
}
