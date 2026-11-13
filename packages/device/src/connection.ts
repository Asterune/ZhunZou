import { WebSocket } from 'ws';

import type {
  DeviceCapabilities,
  DeviceStats,
  NodeProfile,
  RealtimeClientFrame,
  RealtimeServerFrame,
} from '@zhunzou/shared';
import { DEVICE_PROTOCOL_VERSION } from '@zhunzou/shared';

import type { DeviceConfig } from './config.js';
import { deviceSocketUrl } from './config.js';
import { detectCapabilities, detectStats } from './capabilities.js';
import { buildNodeProfile, withFreeMemory } from './profile.js';
import { DevicePtyManager } from './pty/manager.js';
import type { PtyBackend } from './pty/runner.js';

export interface DeviceConnectionOptions {
  config: DeviceConfig;
  /** Injected for tests; defaults to detecting the real machine. */
  capabilities?: DeviceCapabilities;
  /** Injected for tests; defaults to reading the real machine stats. */
  stats?: () => DeviceStats;
  /** Called for connection lifecycle messages. */
  log?: (line: string) => void;
  /** Called for protocol errors and network failures. */
  error?: (line: string) => void;
  /** Set false for tests / one-shot runs. */
  autoReconnect?: boolean;
  /** Disable the PTY manager entirely (presence-only device). */
  pty?: boolean;
  /** Injected PTY backend for tests. */
  ptyBackend?: PtyBackend | null;
  /** Custom node-pty loader. */
  loadPtyBackend?: () => Promise<PtyBackend | null>;
  /** Kill local PTYs if the hub does not reconnect within this window. */
  ptyDetachTtlMs?: number;
}

export interface DeviceConnection {
  start(): void;
  stop(): void;
  readonly connected: boolean;
}

function send(socket: WebSocket | null, frame: RealtimeClientFrame): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(frame));
}

function parseServerFrame(raw: string): RealtimeServerFrame | null {
  try {
    return JSON.parse(raw) as RealtimeServerFrame;
  } catch {
    return null;
  }
}

/** Stats provider shared by hello and every heartbeat. */
function defaultStats(): DeviceStats {
  return detectStats();
}

/**
 * The routing profile, rebuilt on every connect.
 *
 * A machine without `node` config stays a plain device: it reports presence
 * and capabilities but claims no repos, so the scheduler cannot route work to
 * a path nobody has given it. The checkout inventory is the expensive part (a
 * bounded filesystem walk), so it refreshes per connection while the memory
 * figure is read live on every beat.
 */
function createProfileSource(
  config: DeviceConfig,
  capabilities: DeviceCapabilities,
  readStats: () => DeviceStats,
): { rebuild(): void; current(): NodeProfile | undefined } {
  const options = config.node;
  let inventory: NodeProfile | null = null;

  return {
    rebuild() {
      if (!options) return;
      inventory = buildNodeProfile({
        hostname: capabilities.hostname,
        ...(capabilities.machineId ? { nodeId: capabilities.machineId } : {}),
        ...options,
      });
    },
    current() {
      if (!inventory) return undefined;
      const { freeMemBytes } = readStats();
      return typeof freeMemBytes === 'number'
        ? withFreeMemory(inventory, freeMemBytes)
        : inventory;
    },
  };
}

/**
 * Reverse connection from a device to the hub.
 *
 * The socket is intentionally long-lived: the hub can push terminal/control
 * frames without knowing the device's address. Reconnects use bounded
 * exponential backoff with jitter so a hub restart does not stampede.
 */
export function createDeviceConnection(
  options: DeviceConnectionOptions,
): DeviceConnection {
  const { config } = options;
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const reportError =
    options.error ?? ((line) => process.stderr.write(`${line}\n`));
  const autoReconnect = options.autoReconnect ?? true;
  const capabilities = options.capabilities ?? detectCapabilities();
  const readStats = options.stats ?? defaultStats;
  const nodeProfile = createProfileSource(config, capabilities, readStats);

  let socket: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let attempts = 0;
  let ptyDisposeTimer: ReturnType<typeof setTimeout> | null = null;

  const ptyManager =
    options.pty === false
      ? null
      : new DevicePtyManager({
          send: (frame) => send(socket, frame),
          ...(options.ptyBackend !== undefined
            ? { backend: options.ptyBackend }
            : {}),
          ...(options.loadPtyBackend
            ? { loadBackend: options.loadPtyBackend }
            : {}),
          log,
        });

  const clearPtyDisposeTimer = (): void => {
    if (ptyDisposeTimer !== null) {
      clearTimeout(ptyDisposeTimer);
      ptyDisposeTimer = null;
    }
  };

  const schedulePtyDispose = (): void => {
    if (!ptyManager) return;
    clearPtyDisposeTimer();
    ptyDisposeTimer = setTimeout(() => {
      ptyDisposeTimer = null;
      if (ptyManager.size === 0) return;
      log(
        `[zhunzou-device] closing ${ptyManager.size} PTY session(s) after hub detach timeout`,
      );
      ptyManager.dispose();
    }, options.ptyDetachTtlMs ?? 5 * 60_000);
    ptyDisposeTimer.unref?.();
  };

  const clearHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const clearReconnect = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const beat = (): void => {
    const profile = nodeProfile.current();
    send(socket, {
      type: 'heartbeat',
      at: Date.now(),
      stats: readStats(),
      ...(profile ? { profile } : {}),
    });
  };

  const startHeartbeat = (intervalMs: number): void => {
    clearHeartbeat();
    heartbeatTimer = setInterval(beat, intervalMs);
    heartbeatTimer.unref?.();
  };

  const scheduleReconnect = (): void => {
    if (stopped || !autoReconnect) return;
    clearReconnect();
    const exponent = Math.min(attempts, 6);
    const base = Math.min(
      config.reconnectMaxMs,
      config.reconnectMinMs * 2 ** exponent,
    );
    const delay = base + Math.floor(Math.random() * Math.min(1_000, base));
    attempts += 1;
    log(`[zhunzou-device] reconnecting in ${delay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  };

  function connect(): void {
    if (stopped) return;
    nodeProfile.rebuild();

    const url = deviceSocketUrl(config);
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${config.token}` },
      handshakeTimeout: 10_000,
      maxPayload: 64 * 1024,
    });
    socket = ws;

    ws.on('open', () => {
      attempts = 0;
      clearPtyDisposeTimer();
      log(`[zhunzou-device] connected ${config.env} → ${config.hubUrl}`);
      const profile = nodeProfile.current();
      send(ws, {
        type: 'hello',
        protocol: DEVICE_PROTOCOL_VERSION,
        env: config.env,
        ...(config.projectName ? { projectName: config.projectName } : {}),
        capabilities,
        stats: readStats(),
        ...(profile ? { profile } : {}),
      });
      startHeartbeat(config.heartbeatMs);
    });

    ws.on('message', (data) => {
      const frame = parseServerFrame(data.toString());
      if (!frame) {
        reportError('[zhunzou-device] received a malformed server frame');
        return;
      }

      if (frame.type.startsWith('pty.')) {
        if (ptyManager) void ptyManager.handleFrame(frame);
        return;
      }

      switch (frame.type) {
        case 'ready':
          log(
            `[zhunzou-device] hub ready (role=${frame.role}, heartbeat=${frame.heartbeatMs}ms)`,
          );
          startHeartbeat(frame.heartbeatMs);
          break;
        case 'error':
          reportError(`[zhunzou-device] hub error ${frame.code}: ${frame.message}`);
          break;
        case 'pong':
        case 'device.updated':
        case 'device.offline':
          break;
        default:
          break;
      }
    });

    ws.on('close', (code, reason) => {
      clearHeartbeat();
      if (socket === ws) socket = null;
      if (stopped) return;
      schedulePtyDispose();
      log(
        `[zhunzou-device] disconnected (${code}${reason.length ? `: ${reason.toString()}` : ''})`,
      );
      scheduleReconnect();
    });

    ws.on('error', (error) => {
      reportError(`[zhunzou-device] ${error.message}`);
    });
  }

  return {
    start() {
      if (socket || stopped) return;
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      clearHeartbeat();
      clearReconnect();
      clearPtyDisposeTimer();
      ptyManager?.dispose();
      const current = socket;
      socket = null;
      if (current) {
        try {
          current.close(1000, 'device stopping');
        } catch {
          // Already closed.
        }
      }
    },
    get connected() {
      return socket?.readyState === WebSocket.OPEN;
    },
  };
}
