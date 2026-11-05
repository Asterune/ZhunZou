export interface PtySpawnOptions {
  shell: string;
  args?: string[];
  cwd?: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export interface PtyExitEvent {
  exitCode: number | null;
  signal?: string;
}

export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: PtyExitEvent) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtyBackend {
  spawn(options: PtySpawnOptions): PtyProcess;
}

interface NodePtyProcess {
  pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number | string }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(
    shell: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): NodePtyProcess;
}

/**
 * Load `node-pty` lazily so the daemon still runs without the native module.
 * Users who want terminals install it with:
 *
 *   pnpm --filter @zhunzou/device add node-pty
 */
export async function loadNodePtyBackend(): Promise<PtyBackend | null> {
  try {
    const specifier = 'node-pty';
    const imported = (await import(specifier)) as unknown as
      | { default?: NodePtyModule }
      | NodePtyModule;
    const pty =
      'spawn' in imported
        ? (imported as NodePtyModule)
        : (imported.default as NodePtyModule | undefined);
    if (!pty?.spawn) return null;

    return {
      spawn(options) {
        const process = pty.spawn(options.shell, options.args ?? [], {
          name: 'xterm-256color',
          cols: options.cols,
          rows: options.rows,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          env: {
            ...(globalThis.process.env as Record<string, string>),
            TERM: 'xterm-256color',
            ...(options.env ?? {}),
          },
        });

        return {
          pid: process.pid,
          onData: (listener) => process.onData(listener),
          onExit: (listener) =>
            process.onExit((event) =>
              listener({
                exitCode: event.exitCode ?? null,
                ...(event.signal !== undefined
                  ? { signal: String(event.signal) }
                  : {}),
              }),
            ),
          write: (data) => process.write(data),
          resize: (cols, rows) => process.resize(cols, rows),
          kill: (signal) => process.kill(signal),
        };
      },
    };
  } catch {
    return null;
  }
}
