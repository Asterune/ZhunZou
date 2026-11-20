import { describe, expect, it } from 'vitest';

import { readHostStats } from '../src/host-stats.js';

describe('readHostStats', () => {
  it('reports the machine load, memory and the workspace volume', () => {
    const stats = readHostStats(process.cwd());

    expect(stats.cpuCount).toBeGreaterThan(0);
    expect(stats.totalMemBytes).toBeGreaterThan(0);
    expect(stats.freeMemBytes).toBeGreaterThan(0);
    expect(stats.load1).toBeGreaterThanOrEqual(0);
    expect(stats.uptimeSec).toBeGreaterThan(0);
    expect(stats.diskTotalBytes).toBeGreaterThan(0);
    expect(stats.diskFreeBytes).toBeGreaterThan(0);
  });

  it('still reports CPU and memory when the path has no filesystem', () => {
    const stats = readHostStats('/definitely/not/a/real/path');

    expect(stats.cpuCount).toBeGreaterThan(0);
    expect(stats.diskTotalBytes).toBeUndefined();
  });
});
