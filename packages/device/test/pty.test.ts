import { describe, expect, it } from 'vitest';

import type { RealtimeClientFrame } from '@zhunzou/shared';

import { DevicePtyManager } from '../src/pty/manager.js';
import type {
  PtyBackend,
  PtyExitEvent,
  PtyProcess,
  PtySpawnOptions,
} from '../src/pty/runner.js';

class FakePtyProcess implements PtyProcess {
  readonly pid = 4242;
  written = '';
  resized: Array<[number, number]> = [];
  killed: Array<string | undefined> = [];
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: PtyExitEvent) => void> = [];

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
  }

  onExit(listener: (event: PtyExitEvent) => void): void {
    this.exitListeners.push(listener);
  }

  write(data: string): void {
    this.written += data;
  }

  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows]);
  }

  kill(signal?: string): void {
    this.killed.push(signal);
    this.emitExit(0);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(code: number | null): void {
    for (const listener of this.exitListeners) listener({ exitCode: code });
  }
}

function createHarness(backend: PtyBackend | null) {
  const frames: RealtimeClientFrame[] = [];
  const processes: FakePtyProcess[] = [];
  const spawns: PtySpawnOptions[] = [];
  const fakeBackend: PtyBackend = {
    spawn(options) {
      spawns.push(options);
      const child = new FakePtyProcess();
      processes.push(child);
      return child;
    },
  };

  const manager = new DevicePtyManager({
    send: (frame) => frames.push(frame),
    backend: backend === null ? null : fakeBackend,
    loadBackend: async () => null,
    defaultShell: '/bin/zsh',
  });

  return { manager, frames, processes, spawns };
}

describe('DevicePtyManager', () => {
  it('spawns a PTY, streams output and forwards input/resize/signal', async () => {
    const { manager, frames, processes, spawns } = createHarness({} as PtyBackend);

    await manager.handleFrame({
      type: 'pty.create',
      sessionId: '7',
      cols: 100,
      rows: 30,
      cwd: '/tmp',
    });

    expect(spawns[0]).toMatchObject({
      shell: '/bin/zsh',
      cols: 100,
      rows: 30,
      cwd: '/tmp',
    });
    expect(frames[0]).toMatchObject({
      type: 'pty.ready',
      sessionId: '7',
      pid: 4242,
    });

    const child = processes[0]!;
    child.emitData('hello\n');
    expect(frames.at(-1)).toMatchObject({
      type: 'pty.output',
      sessionId: '7',
      seq: 1,
      data: 'hello\n',
    });

    await manager.handleFrame({
      type: 'pty.input',
      sessionId: '7',
      data: 'ls\r',
    });
    expect(child.written).toBe('ls\r');

    await manager.handleFrame({
      type: 'pty.resize',
      sessionId: '7',
      cols: 120,
      rows: 40,
    });
    expect(child.resized).toEqual([[120, 40]]);

    await manager.handleFrame({
      type: 'pty.signal',
      sessionId: '7',
      signal: 'SIGINT',
    });
    expect(child.written).toBe('ls\r\x03');

    await manager.handleFrame({
      type: 'pty.signal',
      sessionId: '7',
      signal: 'SIGTERM',
    });
    expect(child.killed).toContain('SIGTERM');

    child.emitExit(0);
    expect(frames.at(-1)).toMatchObject({
      type: 'pty.exit',
      sessionId: '7',
      code: 0,
    });
  });

  it('reports an explicit error when node-pty is unavailable', async () => {
    const { manager, frames } = createHarness(null);
    await manager.handleFrame({
      type: 'pty.create',
      sessionId: '8',
      cols: 80,
      rows: 24,
    });
    expect(frames[0]).toMatchObject({
      type: 'pty.error',
      sessionId: '8',
      code: 'PTY_UNAVAILABLE',
    });
  });

  it('reattaches an existing session', async () => {
    const { manager, frames } = createHarness({} as PtyBackend);
    await manager.handleFrame({
      type: 'pty.create',
      sessionId: '9',
      cols: 80,
      rows: 24,
    });
    frames.length = 0;
    await manager.handleFrame({ type: 'pty.attach', sessionId: '9' });
    expect(frames[0]).toMatchObject({
      type: 'pty.ready',
      sessionId: '9',
    });
  });
});
