import { describe, expect, it } from 'vitest';

import {
  busyPercent,
  parseMemInfo,
  parseProcNetDev,
  parseProcStat,
  perSec,
  SystemSampler,
} from '../src/system-metrics.js';
import { createTestContext } from './helpers.js';

const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0
  eth0: 5000 50 0 0 0 0 0 0 7000 70 0 0 0 0 0 0
`;

describe('system metrics parsing', () => {
  it('sums the CPU counters and counts iowait as idle', () => {
    const times = parseProcStat('cpu  10 0 20 100 5 0 0 0 0 0\ncpu0 1 2 3\n');

    expect(times).toEqual({ total: 135, idle: 105 });
  });

  it('sums rx/tx across interfaces', () => {
    expect(parseProcNetDev(NET_DEV)).toEqual({ rx: 6000, tx: 9000 });
  });

  it('reads swap from meminfo', () => {
    expect(
      parseMemInfo('MemTotal: 1000 kB\nSwapTotal:       2048 kB\nSwapFree:        1024 kB\n'),
    ).toEqual({ swapTotalBytes: 2048 * 1024, swapFreeBytes: 1024 * 1024 });
  });

  it('computes the busy share between two counter snapshots', () => {
    expect(busyPercent({ total: 100, idle: 50 }, { total: 200, idle: 100 })).toBe(
      50,
    );
    expect(busyPercent({ total: 200, idle: 100 }, { total: 200, idle: 100 })).toBeUndefined();
  });

  it('computes a per-second rate and refuses a backwards counter', () => {
    expect(perSec(1_000, 3_000, 2_000)).toBe(1_000);
    expect(perSec(3_000, 1_000, 2_000)).toBe(0);
    expect(perSec(1_000, 3_000, 0)).toBe(0);
  });

  it('turns two samples into CPU usage and network rates', () => {
    let now = 1_000;
    const files: Record<string, string> = {
      '/proc/stat': 'cpu  0 0 0 100 0 0 0 0 0 0\n',
      '/proc/net/dev': NET_DEV,
      '/proc/meminfo': 'SwapTotal: 2048 kB\nSwapFree: 1024 kB\n',
    };
    const sampler = new SystemSampler('/tmp/zhunzou-metrics-test.db', {
      now: () => now,
      readFile: (path) => files[path] ?? null,
    });

    const first = sampler.sample();
    expect(first.cpu.usagePercent).toBeUndefined();
    expect(first.network?.rxBytesPerSec).toBe(0);
    expect(first.memory.swapTotalBytes).toBe(2048 * 1024);

    files['/proc/stat'] = 'cpu  50 0 0 150 0 0 0 0 0 0\n';
    files['/proc/net/dev'] = NET_DEV.replace('eth0: 5000', 'eth0: 9000');
    now += 2_000;

    const second = sampler.sample();
    expect(second.cpu.usagePercent).toBe(50);
    expect(second.network?.rxBytesPerSec).toBe(2_000);
    expect(second.network?.txBytesPerSec).toBe(0);
  });
});

describe('GET /api/system', () => {
  it('returns the host card for an admin', async () => {
    const ctx = await createTestContext();
    try {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/system',
        headers: ctx.auth,
      });
      expect(response.statusCode).toBe(200);

      const { system } = response.json() as {
        system: {
          hostname: string;
          memory: { totalBytes: number };
          process: { nodeVersion: string };
          sampledAt: number;
        };
      };
      expect(system.hostname.length).toBeGreaterThan(0);
      expect(system.memory.totalBytes).toBeGreaterThan(0);
      expect(system.process.nodeVersion).toMatch(/^v\d+/);
      expect(system.sampledAt).toBeGreaterThan(0);
    } finally {
      await ctx.close();
    }
  });
});
