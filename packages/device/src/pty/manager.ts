import type {
  RealtimeClientFrame,
  RealtimeServerFrame,
} from '@zhunzou/shared';

import type { PtyBackend, PtyProcess } from './runner.js';
import { loadNodePtyBackend } from './runner.js';

export interface DevicePtyManagerOptions {
  send: (frame: RealtimeClientFrame) => void;
  /** Injected backend for tests. `undefined` triggers lazy node-pty loading. */
  backend?: PtyBackend | null;
  loadBackend?: () => Promise<PtyBackend | null>;
  defaultShell?: string;
  log?: (line: string) => void;
}

interface SessionEntry {
  process: PtyProcess;
  seq: number;
  closing: boolean;
}

const MAX_CHUNK_BYTES = 16 * 1024;

function splitChunks(data: string): string[] {
  if (Buffer.byteLength(data) <= MAX_CHUNK_BYTES) return [data];
  const chunks: string[] = [];
  let current = '';
  for (const char of data) {
    if (Buffer.byteLength(current + char) > MAX_CHUNK_BYTES) {
      chunks.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function defaultShell(): string {
  return (
    process.env.SHELL ||
    (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh')
  );
}

/**
 * Owns the actual PTY child processes on the device.
 *
 * The manager survives WebSocket reconnects: the server sends `pty.attach`
 * after a device hello and the same shell continues streaming.
 */
export class DevicePtyManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly send: (frame: RealtimeClientFrame) => void;
  private readonly log: (line: string) => void;
  private readonly shell: string;
  private readonly loadBackend: () => Promise<PtyBackend | null>;
  private backend: PtyBackend | null | undefined;
  private loading: Promise<PtyBackend | null> | null = null;

  constructor(options: DevicePtyManagerOptions) {
    this.send = options.send;
    this.log = options.log ?? (() => undefined);
    this.shell = options.defaultShell ?? defaultShell();
    this.loadBackend = options.loadBackend ?? loadNodePtyBackend;
    this.backend = options.backend;
  }

  get size(): number {
    return this.sessions.size;
  }

  private async getBackend(): Promise<PtyBackend | null> {
    if (this.backend !== undefined) return this.backend;
    if (!this.loading) {
      this.loading = this.loadBackend().then((backend) => {
        this.backend = backend;
        return backend;
      });
    }
    return this.loading;
  }

  private output(sessionId: string, entry: SessionEntry, data: string): void {
    for (const part of splitChunks(data)) {
      entry.seq += 1;
      this.send({
        type: 'pty.output',
        sessionId,
        seq: entry.seq,
        data: part,
      });
    }
  }

  private error(sessionId: string, code: string, message: string): void {
    this.send({ type: 'pty.error', sessionId, code, message });
  }

  private async create(frame: {
    sessionId: string;
    shell?: string;
    cwd?: string;
    cols: number;
    rows: number;
    env?: Record<string, string>;
  }): Promise<void> {
    const backend = await this.getBackend();
    if (!backend) {
      this.error(
        frame.sessionId,
        'PTY_UNAVAILABLE',
        'node-pty is not installed on this device; run pnpm --filter @zhunzou/device add node-pty',
      );
      return;
    }
    if (this.sessions.has(frame.sessionId)) {
      this.error(frame.sessionId, 'SESSION_EXISTS', 'session already exists');
      return;
    }

    let child: PtyProcess;
    try {
      child = backend.spawn({
        shell: frame.shell || this.shell,
        ...(frame.cwd ? { cwd: frame.cwd } : {}),
        cols: frame.cols,
        rows: frame.rows,
        ...(frame.env ? { env: frame.env } : {}),
      });
    } catch (error) {
      this.error(
        frame.sessionId,
        'SPAWN_FAILED',
        (error as Error).message || 'failed to spawn PTY',
      );
      return;
    }

    const entry: SessionEntry = { process: child, seq: 0, closing: false };
    this.sessions.set(frame.sessionId, entry);
    this.log(
      `[zhunzou-device] pty ${frame.sessionId} started (pid=${child.pid})`,
    );
    this.send({
      type: 'pty.ready',
      sessionId: frame.sessionId,
      pid: child.pid,
      shell: frame.shell || this.shell,
    });

    child.onData((data) => {
      this.output(frame.sessionId, entry, data);
    });
    child.onExit(({ exitCode, signal }) => {
      this.sessions.delete(frame.sessionId);
      this.send({
        type: 'pty.exit',
        sessionId: frame.sessionId,
        code: exitCode,
        ...(signal ? { signal } : {}),
      });
      this.log(
        `[zhunzou-device] pty ${frame.sessionId} exited (code=${exitCode ?? 'null'})`,
      );
    });
  }

  private attach(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      this.error(sessionId, 'SESSION_NOT_FOUND', 'session is not running');
      return;
    }
    this.send({
      type: 'pty.ready',
      sessionId,
      pid: entry.process.pid,
      shell: this.shell,
    });
  }

  private input(sessionId: string, data: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.process.write(data);
  }

  private resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    try {
      entry.process.resize(cols, rows);
    } catch {
      // Some backends reject a resize after exit.
    }
  }

  private signal(sessionId: string, signal: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    if (signal === 'SIGINT') {
      // Writing ETX is the portable "Ctrl+C" for an interactive PTY.
      entry.process.write('\x03');
      return;
    }
    if (signal === 'SIGTSTP') {
      entry.process.write('\x1a');
      return;
    }

    try {
      entry.process.kill(signal);
    } catch {
      // Already exited.
    }
  }

  private close(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.closing = true;
    try {
      entry.process.kill('SIGTERM');
    } catch {
      // Already exited.
    }

    const killTimer = setTimeout(() => {
      try {
        entry.process.kill('SIGKILL');
      } catch {
        // Already exited.
      }
    }, 2_000);
    killTimer.unref?.();

    const finalizeTimer = setTimeout(() => {
      if (!this.sessions.has(sessionId)) return;
      this.sessions.delete(sessionId);
      this.send({
        type: 'pty.exit',
        sessionId,
        code: null,
        signal: 'SIGKILL',
      });
    }, 5_000);
    finalizeTimer.unref?.();
  }

  async handleFrame(frame: RealtimeServerFrame): Promise<void> {
    switch (frame.type) {
      case 'pty.create':
        await this.create(frame);
        break;
      case 'pty.attach':
        this.attach(frame.sessionId);
        break;
      case 'pty.input':
        this.input(frame.sessionId, frame.data);
        break;
      case 'pty.resize':
        this.resize(frame.sessionId, frame.cols, frame.rows);
        break;
      case 'pty.signal':
        this.signal(frame.sessionId, frame.signal);
        break;
      case 'pty.close':
        this.close(frame.sessionId);
        break;
      default:
        break;
    }
  }

  dispose(): void {
    for (const entry of this.sessions.values()) {
      try {
        entry.process.kill('SIGKILL');
      } catch {
        // Already exited.
      }
    }
    this.sessions.clear();
  }
}
