import { describe, expect, it } from 'vitest';

import { runProcess } from '../src/wake/adapters.js';

const isWindows = process.platform === 'win32';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(isWindows)('runProcess tree termination', () => {
  it('kills the tools the CLI spawned, not just the leader', async () => {
    const controller = new AbortController();
    let grandchild = 0;

    const run = runProcess('sh', ['-c', 'sleep 60 & echo $!; wait'], {
      timeoutMs: 30_000,
      signal: controller.signal,
      onOutput: (stream, chunk) => {
        if (stream !== 'stdout' || grandchild !== 0) return;
        const pid = Number(chunk.trim().split('\n')[0]);
        if (Number.isInteger(pid) && pid > 0) grandchild = pid;
      },
    });

    for (let attempt = 0; attempt < 50 && grandchild === 0; attempt += 1) {
      await sleep(20);
    }
    expect(grandchild).toBeGreaterThan(0);
    expect(alive(grandchild)).toBe(true);

    controller.abort();
    await run;

    // SIGTERM goes to the process group; poll so a slow reaper is not flaky.
    for (let attempt = 0; attempt < 30 && alive(grandchild); attempt += 1) {
      await sleep(100);
    }
    expect(alive(grandchild)).toBe(false);
  });
});
