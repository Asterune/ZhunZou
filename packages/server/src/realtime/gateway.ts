import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import type {
  Agent,
  DeviceCapabilities,
  DeviceStats,
  RealtimeClientFrame,
  RealtimeServerFrame,
  SyncState,
} from '@zhunzou/shared';
import {
  DEVICE_PROTOCOL_VERSION,
  REALTIME_MAX_FRAME_BYTES,
  realtimeClientFrameSchema,
} from '@zhunzou/shared';

import { hashToken } from '../auth.js';
import type { ServerConfig } from '../config.js';
import type { TicketStore } from '../repository.js';
import { verifyRealtimeTicket } from './ticket.js';

/** One live device daemon, keyed by env. */
interface DeviceConnection {
  env: string;
  socket: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
  helloSent: boolean;
  timer: ReturnType<typeof setInterval>;
}

export interface RealtimeGateway {
  /** Broadcast a server frame to every connected dashboard. */
  broadcast(frame: RealtimeServerFrame): void;
  /** Send a frame to one device daemon. Returns false when it is offline. */
  sendToDevice(env: string, frame: RealtimeServerFrame): boolean;
  isDeviceConnected(env: string): boolean;
  /** Send a claim response to a bridge socket, if one is attached. */
  sendToBridge(env: string, frame: RealtimeServerFrame): boolean;
  isBridgeConnected(env: string): boolean;
  /**
   * Drop the live device and bridge sockets for an env. Used when the env is
   * deleted: without this the daemon keeps its socket open and never learns
   * that its token is gone.
   */
  disconnectEnv(env: string, reason?: string): void;
  bridgeCount(): number;
  /** Listen for pty.* frames from devices. */
  onDeviceFrame(handler: DeviceFrameHandler): () => void;
  /** Listen for a device completing its hello handshake. */
  onDeviceConnected(handler: DeviceConnectedHandler): () => void;
  /** Listen for a device socket closing. */
  onDeviceDisconnected(handler: DeviceDisconnectedHandler): () => void;
  /** Register an additional `/ws/*` upgrade path (used by terminal sessions). */
  registerUpgradePath(path: string, handler: UpgradeHandler): () => void;
  deviceCount(): number;
  dashboardCount(): number;
  close(): void;
}

export type DeviceFrameHandler = (
  env: string,
  frame: RealtimeClientFrame,
) => void;
export type DeviceConnectedHandler = (env: string, agent: Agent) => void;
export type DeviceDisconnectedHandler = (env: string) => void;
export type UpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
) => void;

export interface RealtimeGatewayOptions {
  app: FastifyInstance;
  config: ServerConfig;
  repo: TicketStore;
  /** Full dashboard snapshot for a `sync.request` frame. */
  getSyncState?: () => SyncState;
  /** Current monotonic dashboard revision. */
  getRevision?: () => number;
}

function readHeader(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function bearerToken(request: IncomingMessage): string {
  const header = readHeader(request, 'authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      '\r\n' +
      message,
  );
  socket.destroy();
}

function send(ws: WebSocket, frame: RealtimeServerFrame): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(frame));
}

function parseClientFrame(data: RawData): RealtimeClientFrame | null {
  const buffer = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);

  if (buffer.byteLength > REALTIME_MAX_FRAME_BYTES) return null;

  try {
    return realtimeClientFrameSchema.parse(
      JSON.parse(buffer.toString('utf8')),
    );
  } catch {
    return null;
  }
}

/**
 * Device ↔ dashboard WebSocket gateway.
 *
 * Devices connect outward to the hub, so a laptop behind NAT can be reached
 * without an inbound port. Dashboards connect with a short-lived ticket and
 * receive presence/capability updates. Terminal frames will share the same
 * gateway in phase 2.
 */
export function attachRealtimeGateway(
  options: RealtimeGatewayOptions,
): RealtimeGateway | null {
  const { app, config, repo } = options;
  if (!config.realtimeEnabled) return null;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: REALTIME_MAX_FRAME_BYTES,
  });
  const devices = new Map<string, DeviceConnection>();
  const bridges = new Map<string, WebSocket>();
  const dashboards = new Set<WebSocket>();
  const deviceFrameHandlers = new Set<DeviceFrameHandler>();
  const deviceConnectedHandlers = new Set<DeviceConnectedHandler>();
  const deviceDisconnectedHandlers = new Set<DeviceDisconnectedHandler>();
  const upgradeHandlers = new Map<string, UpgradeHandler>();

  const broadcast = (frame: RealtimeServerFrame): void => {
    const payload = JSON.stringify(frame);
    for (const client of dashboards) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };

  const heartbeatInterval = Math.max(
    5_000,
    Math.min(30_000, Math.floor(config.realtimeHeartbeatTimeoutMs / 3)),
  );

  const attachDevice = (socket: WebSocket, env: string): void => {
    const existing = devices.get(env);
    if (existing) {
      clearInterval(existing.timer);
      devices.delete(env);
      try {
        existing.socket.close(4001, 'replaced by a newer connection');
      } catch {
        // Already closed.
      }
    }

    const now = Date.now();
    const connection: DeviceConnection = {
      env,
      socket,
      connectedAt: now,
      lastSeenAt: now,
      helloSent: false,
      timer: setInterval(() => {
        if (Date.now() - connection.lastSeenAt <= config.realtimeHeartbeatTimeoutMs) {
          return;
        }
        try {
          socket.close(4002, 'heartbeat timeout');
        } catch {
          // Already closed.
        }
      }, heartbeatInterval),
    };
    connection.timer.unref?.();
    devices.set(env, connection);

    send(socket, {
      type: 'ready',
      protocol: DEVICE_PROTOCOL_VERSION,
      serverTime: now,
      heartbeatMs: config.realtimeHeartbeatMs,
      role: 'device',
      env,
    });

    socket.on('message', (data) => {
      const frame = parseClientFrame(data);
      if (!frame) {
        send(socket, {
          type: 'error',
          code: 'INVALID_FRAME',
          message: 'frame is not valid JSON for the realtime protocol',
        });
        return;
      }

      connection.lastSeenAt = Date.now();

      if (frame.type === 'ping') {
        send(socket, { type: 'pong', at: frame.at });
        return;
      }

      if (frame.type === 'hello') {
        if (frame.protocol > DEVICE_PROTOCOL_VERSION) {
          send(socket, {
            type: 'error',
            code: 'PROTOCOL_MISMATCH',
            message: `server speaks protocol ${DEVICE_PROTOCOL_VERSION}`,
          });
          socket.close(4003, 'protocol mismatch');
          return;
        }

        if (frame.env && frame.env !== env) {
          send(socket, {
            type: 'error',
            code: 'ENV_MISMATCH',
            message: `socket is bound to ${env}`,
          });
          socket.close(4004, 'env mismatch');
          return;
        }

        connection.helloSent = true;
        connection.connectedAt = Date.now();
        const agent = repo.recordDeviceConnection(
          {
            env,
            ...(frame.projectName ? { projectName: frame.projectName } : {}),
            protocolVersion: frame.protocol,
            capabilities: frame.capabilities as DeviceCapabilities,
            ...(frame.stats ? { stats: frame.stats } : {}),
            transport: 'ws',
          },
          connection.connectedAt,
        );
        broadcast({ type: 'device.updated', agent });
        for (const handler of deviceConnectedHandlers) handler(env, agent);
        return;
      }

      if (!connection.helloSent) {
        send(socket, {
          type: 'error',
          code: 'HELLO_REQUIRED',
          message: 'send hello before heartbeats',
        });
        return;
      }

      if (frame.type === 'heartbeat') {
        const agent = repo.recordDeviceHeartbeat(
          env,
          frame.stats as DeviceStats | undefined,
          connection.lastSeenAt,
        );
        if (agent) broadcast({ type: 'device.updated', agent });
        return;
      }

      // pty.ready / pty.output / pty.exit / pty.error are routed to the
      // terminal manager, which owns the session state machine.
      for (const handler of deviceFrameHandlers) handler(env, frame);
    });

    const cleanup = (): void => {
      clearInterval(connection.timer);
      const current = devices.get(env);
      if (current !== connection) return;
      devices.delete(env);
      const agent = repo.markDeviceDisconnected(env);
      if (agent) {
        broadcast({ type: 'device.offline', env, at: Date.now() });
        for (const handler of deviceDisconnectedHandlers) handler(env);
      }
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  };

  const attachBridge = (socket: WebSocket, env: string): void => {
    const existing = bridges.get(env);
    if (existing) {
      try {
        existing.close(4001, 'replaced by a newer bridge');
      } catch {
        // Already closed.
      }
    }
    bridges.set(env, socket);
    repo.recordBridgePresence(env);
    send(socket, {
      type: 'ready',
      protocol: DEVICE_PROTOCOL_VERSION,
      serverTime: Date.now(),
      heartbeatMs: config.realtimeHeartbeatMs,
      role: 'bridge',
      env,
    });

    const keepAlive = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.ping();
        } catch {
          // Already closing.
        }
      }
    }, 30_000);
    keepAlive.unref?.();

    socket.on('message', (data) => {
      const frame = parseClientFrame(data);
      if (!frame) {
        send(socket, {
          type: 'error',
          code: 'INVALID_FRAME',
          message: 'frame is not valid JSON for the realtime protocol',
        });
        return;
      }
      repo.recordBridgePresence(env);
      if (frame.type === 'ping') {
        send(socket, { type: 'pong', at: frame.at });
        return;
      }
      for (const handler of deviceFrameHandlers) handler(env, frame);
    });

    const remove = (): void => {
      clearInterval(keepAlive);
      if (bridges.get(env) === socket) bridges.delete(env);
    };
    socket.on('close', remove);
    socket.on('error', remove);
  };

  const attachDashboard = (socket: WebSocket): void => {
    dashboards.add(socket);
    send(socket, {
      type: 'ready',
      protocol: DEVICE_PROTOCOL_VERSION,
      serverTime: Date.now(),
      heartbeatMs: config.realtimeHeartbeatMs,
      role: 'dashboard',
    });

    const sendSnapshot = (): void => {
      if (!options.getSyncState) return;
      send(socket, {
        type: 'sync.snapshot',
        rev: options.getRevision?.() ?? 0,
        state: options.getSyncState(),
      });
    };

    socket.on('message', (data) => {
      const frame = parseClientFrame(data);
      if (!frame) {
        send(socket, {
          type: 'error',
          code: 'INVALID_FRAME',
          message: 'frame is not valid JSON for the realtime protocol',
        });
        return;
      }
      if (frame.type === 'sync.request') sendSnapshot();
      else if (frame.type === 'ping') send(socket, { type: 'pong', at: frame.at });
    });

    sendSnapshot();

    // Keep proxies from closing an idle dashboard socket.
    const keepAlive = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.ping();
        } catch {
          // Already closing.
        }
      }
    }, 30_000);
    keepAlive.unref?.();

    const remove = (): void => {
      clearInterval(keepAlive);
      dashboards.delete(socket);
    };
    socket.on('close', remove);
    socket.on('error', remove);
  };

  const onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    let url: URL;
    try {
      url = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? 'localhost'}`,
      );
    } catch {
      rejectUpgrade(socket, 400, 'invalid URL');
      return;
    }

    if (url.pathname === '/ws/device') {
      const token = bearerToken(request) || url.searchParams.get('token') || '';
      const requestedEnv = (url.searchParams.get('env') ?? '').trim();

      let env = '';
      if (token && safeEqual(token, config.token)) {
        env = requestedEnv;
      } else if (token) {
        const agent = repo.findAgentByTokenHash(hashToken(token));
        if (agent?.status === 'active') {
          env = agent.env;
        }
      }

      if (!env) {
        rejectUpgrade(socket, 401, 'device token is missing or invalid');
        return;
      }
      if (requestedEnv && requestedEnv !== env) {
        rejectUpgrade(socket, 403, 'token is scoped to a different env');
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        attachDevice(ws, env);
      });
      return;
    }

    if (url.pathname === '/ws/bridge') {
      const token = bearerToken(request) || url.searchParams.get('token') || '';
      const requestedEnv = (url.searchParams.get('env') ?? '').trim();

      let env = '';
      if (token && safeEqual(token, config.token)) {
        env = requestedEnv;
      } else if (token) {
        const agent = repo.findAgentByTokenHash(hashToken(token));
        if (agent?.status === 'active') env = agent.env;
      }

      if (!env) {
        rejectUpgrade(socket, 401, 'bridge token is missing or invalid');
        return;
      }
      if (requestedEnv && requestedEnv !== env) {
        rejectUpgrade(socket, 403, 'token is scoped to a different env');
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        attachBridge(ws, env);
      });
      return;
    }

    if (url.pathname === '/ws/realtime') {
      const ticket = url.searchParams.get('ticket') ?? '';
      const bearer = bearerToken(request);
      const adminByToken = Boolean(bearer) && safeEqual(bearer, config.token);
      const validTicket =
        ticket !== '' &&
        verifyRealtimeTicket(ticket, config.approvalLinkSecret) !== null;

      if (!adminByToken && !validTicket) {
        rejectUpgrade(socket, 401, 'realtime ticket is missing or invalid');
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        attachDashboard(ws);
      });
      return;
    }

    const registered = upgradeHandlers.get(url.pathname);
    if (registered) {
      registered(request, socket, head, url);
      return;
    }

    rejectUpgrade(socket, 404, 'unknown websocket endpoint');
  };

  app.server.on('upgrade', onUpgrade);
  app.log.info('realtime websocket gateway enabled');

  let closed = false;
  return {
    broadcast,
    sendToDevice(env, frame) {
      const device = devices.get(env);
      if (!device || device.socket.readyState !== WebSocket.OPEN) return false;
      send(device.socket, frame);
      return true;
    },
    isDeviceConnected: (env) => {
      const device = devices.get(env);
      return Boolean(device && device.socket.readyState === WebSocket.OPEN);
    },
    sendToBridge(env, frame) {
      const bridge = bridges.get(env);
      if (!bridge || bridge.readyState !== WebSocket.OPEN) return false;
      send(bridge, frame);
      return true;
    },
    isBridgeConnected: (env) => {
      const bridge = bridges.get(env);
      return Boolean(bridge && bridge.readyState === WebSocket.OPEN);
    },
    disconnectEnv(env, reason = 'env was removed') {
      const device = devices.get(env);
      if (device) {
        clearInterval(device.timer);
        devices.delete(env);
        try {
          device.socket.close(4005, reason);
        } catch {
          // Already closed.
        }
      }
      const bridge = bridges.get(env);
      if (bridge) {
        bridges.delete(env);
        try {
          bridge.close(4005, reason);
        } catch {
          // Already closed.
        }
      }
    },
    bridgeCount: () => bridges.size,
    onDeviceFrame(handler) {
      deviceFrameHandlers.add(handler);
      return () => deviceFrameHandlers.delete(handler);
    },
    onDeviceConnected(handler) {
      deviceConnectedHandlers.add(handler);
      return () => deviceConnectedHandlers.delete(handler);
    },
    onDeviceDisconnected(handler) {
      deviceDisconnectedHandlers.add(handler);
      return () => deviceDisconnectedHandlers.delete(handler);
    },
    registerUpgradePath(path, handler) {
      upgradeHandlers.set(path, handler);
      return () => {
        if (upgradeHandlers.get(path) === handler) upgradeHandlers.delete(path);
      };
    },
    deviceCount: () => devices.size,
    dashboardCount: () => dashboards.size,
    close: () => {
      if (closed) return;
      closed = true;
      app.server.off('upgrade', onUpgrade);
      for (const device of devices.values()) {
        clearInterval(device.timer);
        try {
          device.socket.terminate();
        } catch {
          // Already closed.
        }
      }
      devices.clear();
      for (const bridge of bridges.values()) {
        try {
          bridge.terminate();
        } catch {
          // Already closed.
        }
      }
      bridges.clear();
      for (const dashboard of dashboards) {
        try {
          dashboard.terminate();
        } catch {
          // Already closed.
        }
      }
      dashboards.clear();
      deviceFrameHandlers.clear();
      deviceConnectedHandlers.clear();
      deviceDisconnectedHandlers.clear();
      upgradeHandlers.clear();
      try {
        wss.close();
      } catch {
        // No clients left.
      }
    },
  };
}

/** Helper used by routes/tests to describe what a device reported. */
export function summarizeCapabilities(
  capabilities: DeviceCapabilities | undefined,
): string[] {
  if (!capabilities) return [];
  return capabilities.tools.map((tool) => tool.name);
}

/** Helper used by tests and future terminal routing. */
export function isDeviceAgent(agent: Agent): boolean {
  return agent.transport === 'ws';
}
