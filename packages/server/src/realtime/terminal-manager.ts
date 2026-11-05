import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer, type RawData } from 'ws';

import type {
  CreateTerminalInput,
  ListTerminalAuditQuery,
  ListTerminalEventsQuery,
  ListTerminalsQuery,
  RealtimeClientFrame,
  RealtimeServerFrame,
  TerminalAuditListResponse,
  TerminalEvent,
  TerminalEventListResponse,
  TerminalSession,
  TerminalSessionStatus,
  TerminalStatsResponse,
  TerminalViewerFrame,
} from '@zhunzou/shared';
import {
  terminalViewerFrameSchema,
} from '@zhunzou/shared';

import type { ServerConfig } from '../config.js';
import { ConflictError, NotFoundError } from '../errors.js';
import type { TicketStore } from '../repository.js';
import type { RealtimeGateway } from './gateway.js';
import { rejectUpgrade } from './gateway.js';
import { verifyRealtimeTicket } from './ticket.js';

interface TerminalLogger {
  info(obj: unknown, message?: string): void;
  warn(obj: unknown, message?: string): void;
  error(obj: unknown, message?: string): void;
}

interface LiveTerminal {
  session: TerminalSession;
  seq: number;
  chunks: TerminalEvent[];
  bytes: number;
  viewers: Set<WebSocket>;
  viewerIds: Map<WebSocket, string>;
  writer: WebSocket | null;
  writerLabel?: string;
  pendingInput: string;
  pendingViewerId?: string;
  inputBytes: number;
  inputWindowStart: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  detachTimer: ReturnType<typeof setTimeout> | null;
  lastPersistAt: number;
}

export interface TerminalManagerOptions {
  config: ServerConfig;
  repo: TicketStore;
  gateway: RealtimeGateway;
  log?: TerminalLogger;
}

export interface TerminalManager {
  create(input: CreateTerminalInput): TerminalSession;
  get(id: number): TerminalSession | null;
  list(query: ListTerminalsQuery): {
    sessions: TerminalSession[];
    total: number;
  };
  close(id: number, reason?: string): TerminalSession;
  events(id: number, query: ListTerminalEventsQuery): TerminalEventListResponse;
  audit(id: number, query: ListTerminalAuditQuery): TerminalAuditListResponse;
  stats(): TerminalStatsResponse;
  closeAll(): void;
}

const MAX_CHUNK_BYTES = 16 * 1024;
const PERSIST_INTERVAL_MS = 5_000;

function sendFrame(ws: WebSocket, frame: RealtimeServerFrame): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(frame));
}

function parseViewerFrame(data: RawData): TerminalViewerFrame | null {
  const buffer = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  if (buffer.byteLength > 64 * 1024) return null;
  try {
    return terminalViewerFrameSchema.parse(
      JSON.parse(buffer.toString('utf8')),
    );
  } catch {
    return null;
  }
}

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

/**
 * Routes PTY frames between devices and browser terminals.
 *
 * Session metadata lives in SQLite, while scrollback and live viewers stay in
 * memory. A reconnecting device is asked to `pty.attach`; a reconnecting
 * browser replays the ring buffer from its last seq.
 */
export function createTerminalManager(
  options: TerminalManagerOptions,
): TerminalManager {
  const { config, repo, gateway } = options;
  const log = options.log;
  const liveTerminals = new Map<string, LiveTerminal>();
  const metrics = {
    sessionsCreated: 0,
    sessionsClosed: 0,
    inputBytes: 0,
    outputBytes: 0,
  };
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
  });

  const getLive = (id: number | string): LiveTerminal | undefined =>
    liveTerminals.get(String(id));

  const makeLive = (session: TerminalSession): LiveTerminal => ({
    session,
    seq: 0,
    chunks: [],
    bytes: 0,
    viewers: new Set(),
    viewerIds: new Map(),
    writer: null,
    pendingInput: '',
    inputBytes: 0,
    inputWindowStart: Date.now(),
    idleTimer: null,
    detachTimer: null,
    lastPersistAt: 0,
  });

  const persist = (
    live: LiveTerminal,
    patch: {
      status?: TerminalSessionStatus;
      lastActiveAt?: number;
      closedAt?: number | null;
      exitCode?: number | null;
      error?: string | null;
    },
    now = Date.now(),
    force = true,
  ): void => {
    if (!force && now - live.lastPersistAt < PERSIST_INTERVAL_MS) {
      live.session = {
        ...live.session,
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.lastActiveAt !== undefined
          ? { lastActiveAt: patch.lastActiveAt }
          : {}),
      };
      return;
    }

    const updated = repo.updateTerminalSession(
      Number(live.session.id),
      patch,
      now,
    );
    if (updated) live.session = updated;
    live.lastPersistAt = now;
  };

  const clearTimers = (live: LiveTerminal): void => {
    if (live.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = null;
    }
    if (live.detachTimer) {
      clearTimeout(live.detachTimer);
      live.detachTimer = null;
    }
  };

  const closeViewers = (live: LiveTerminal, code = 1000, reason = 'session closed'): void => {
    for (const viewer of live.viewers) {
      try {
        viewer.close(code, reason);
      } catch {
        // Already closed.
      }
    }
    live.viewers.clear();
    live.viewerIds.clear();
    live.writer = null;
    live.writerLabel = undefined;
  };

  const removeLive = (live: LiveTerminal): void => {
    flushInputAudit(live);
    clearTimers(live);
    closeViewers(live);
    liveTerminals.delete(live.session.id);
  };

  const broadcastToViewers = (
    live: LiveTerminal,
    frame: RealtimeServerFrame,
  ): void => {
    for (const viewer of live.viewers) sendFrame(viewer, frame);
  };

  const scheduleIdle = (live: LiveTerminal): void => {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = setTimeout(() => {
      try {
        closeSession(Number(live.session.id), 'idle timeout');
      } catch {
        removeLive(live);
      }
    }, config.terminalIdleTimeoutMs);
    live.idleTimer.unref?.();
  };

  const scheduleDetachTimeout = (live: LiveTerminal): void => {
    if (live.detachTimer) clearTimeout(live.detachTimer);
    live.detachTimer = setTimeout(() => {
      loseSession(live, 'DEVICE_TIMEOUT', '设备未在保留时间内重新连接');
    }, config.terminalDetachTtlMs);
    live.detachTimer.unref?.();
  };

  const touch = (live: LiveTerminal, now = Date.now()): void => {
    live.session = { ...live.session, lastActiveAt: now };
    persist(live, { lastActiveAt: now }, now, false);
    scheduleIdle(live);
  };

  const audit = (
    live: LiveTerminal,
    kind: 'CREATE' | 'INPUT' | 'RESIZE' | 'SIGNAL' | 'CLAIM' | 'CLOSE',
    viewerId?: string,
    data?: string,
  ): void => {
    try {
      repo.appendTerminalAudit({
        sessionId: Number(live.session.id),
        env: live.session.env,
        kind,
        ...(viewerId ? { viewerId } : {}),
        ...(data ? { data: data.slice(0, 2_000) } : {}),
      });
    } catch (error) {
      log?.warn(
        { err: (error as Error).message, session: live.session.id },
        'failed to append terminal audit',
      );
    }
  };

  const flushInputAudit = (live: LiveTerminal): void => {
    if (!live.pendingInput) return;
    const data = live.pendingInput;
    live.pendingInput = '';
    audit(live, 'INPUT', live.pendingViewerId, data);
    live.pendingViewerId = undefined;
  };

  const writerIdOf = (live: LiveTerminal): string | undefined =>
    live.writer ? live.viewerIds.get(live.writer) : undefined;

  const broadcastControl = (live: LiveTerminal): void => {
    const writerId = writerIdOf(live);
    broadcastToViewers(live, {
      type: 'terminal.control',
      sessionId: live.session.id,
      writerId: writerId ?? null,
      ...(live.writerLabel ? { writerLabel: live.writerLabel } : {}),
    });
  };

  const claimWriter = (
    live: LiveTerminal,
    viewer: WebSocket,
    label?: string,
  ): void => {
    flushInputAudit(live);
    live.writer = viewer;
    live.writerLabel = label;
    broadcastControl(live);
    audit(live, 'CLAIM', live.viewerIds.get(viewer), label);
  };

  const releaseWriter = (live: LiveTerminal, exclude?: WebSocket): void => {
    let next: WebSocket | null = null;
    for (const candidate of live.viewers) {
      if (candidate === exclude) continue;
      next = candidate;
      break;
    }
    live.writer = next;
    live.writerLabel = undefined;
    broadcastControl(live);
  };

  const canWrite = (
    live: LiveTerminal,
    viewer: WebSocket,
    viewerId: string | undefined,
  ): boolean => {
    if (live.writer === viewer) return true;
    sendFrame(viewer, {
      type: 'terminal.error',
      sessionId: live.session.id,
      code: 'READ_ONLY',
      message: '另一个窗口持有输入控制权，请先点击「接管输入」',
    });
    void viewerId;
    return false;
  };

  const takeInputBudget = (live: LiveTerminal, data: string): boolean => {
    const now = Date.now();
    if (now - live.inputWindowStart >= 1_000) {
      live.inputWindowStart = now;
      live.inputBytes = 0;
    }
    const bytes = Buffer.byteLength(data);
    if (live.inputBytes + bytes > config.terminalInputBytesPerSec) {
      return false;
    }
    live.inputBytes += bytes;
    metrics.inputBytes += bytes;
    return true;
  };

  const appendOutput = (
    live: LiveTerminal,
    data: string,
    seq?: number,
  ): void => {
    if (!data) return;
    const now = Date.now();
    let next = seq ?? live.seq + 1;
    if (seq !== undefined && seq <= live.seq) {
      // Duplicate replay from a reconnecting device: skip it.
      return;
    }
    if (seq !== undefined) live.seq = Math.max(live.seq, seq);

    for (const part of splitChunks(data)) {
      if (seq === undefined) next = live.seq + 1;
      live.seq = Math.max(live.seq, next);
      const event: TerminalEvent = { seq: live.seq, data: part, createdAt: now };
      live.chunks.push(event);
      live.bytes += Buffer.byteLength(part);
      metrics.outputBytes += Buffer.byteLength(part);
      broadcastToViewers(live, {
        type: 'terminal.output',
        sessionId: live.session.id,
        seq: event.seq,
        data: part,
      });
      next += 1;
    }

    while (
      live.bytes > config.terminalScrollbackBytes &&
      live.chunks.length > 1
    ) {
      const dropped = live.chunks.shift();
      if (!dropped) break;
      live.bytes -= Buffer.byteLength(dropped.data);
    }

    touch(live, now);
  };

  const finishSession = (
    live: LiveTerminal,
    code: number | null,
    signal?: string,
  ): void => {
    const now = Date.now();
    flushInputAudit(live);
    persist(live, {
      status: 'CLOSED',
      closedAt: now,
      exitCode: code,
      lastActiveAt: now,
    });
    metrics.sessionsClosed += 1;
    audit(live, 'CLOSE', writerIdOf(live), `exit=${code ?? 'null'}`);
    broadcastToViewers(live, {
      type: 'terminal.exit',
      sessionId: live.session.id,
      code,
      ...(signal ? { signal } : {}),
    });
    gateway.broadcast({ type: 'terminal.updated', session: live.session });
    removeLive(live);
  };

  const loseSession = (
    live: LiveTerminal,
    code: string,
    message: string,
  ): void => {
    const now = Date.now();
    flushInputAudit(live);
    persist(live, {
      status: 'LOST',
      error: message.slice(0, 2_000),
      lastActiveAt: now,
      closedAt: now,
    });
    metrics.sessionsClosed += 1;
    audit(live, 'CLOSE', writerIdOf(live), `${code}: ${message}`);
    broadcastToViewers(live, {
      type: 'terminal.error',
      sessionId: live.session.id,
      code,
      message,
    });
    gateway.broadcast({ type: 'terminal.updated', session: live.session });
    removeLive(live);
  };

  const handleDeviceFrame = (
    env: string,
    frame: RealtimeClientFrame,
  ): void => {
    if (!frame.type.startsWith('pty.')) return;
    if (!('sessionId' in frame)) return;
    const live = getLive(frame.sessionId);
    if (!live || live.session.env !== env) return;

    switch (frame.type) {
      case 'pty.ready': {
        if (live.detachTimer) {
          clearTimeout(live.detachTimer);
          live.detachTimer = null;
        }
        persist(live, { status: 'ACTIVE', lastActiveAt: Date.now() });
        gateway.broadcast({ type: 'terminal.updated', session: live.session });
        scheduleIdle(live);
        break;
      }
      case 'pty.output':
        appendOutput(live, frame.data, frame.seq);
        break;
      case 'pty.exit':
        finishSession(
          live,
          frame.code,
          frame.signal,
        );
        break;
      case 'pty.error':
        loseSession(live, frame.code, frame.message);
        break;
      default:
        break;
    }
  };

  const handleDeviceConnected = (env: string): void => {
    for (const live of liveTerminals.values()) {
      if (live.session.env !== env) continue;
      if (live.detachTimer) {
        clearTimeout(live.detachTimer);
        live.detachTimer = null;
      }
      const delivered = gateway.sendToDevice(env, {
        type: 'pty.attach',
        sessionId: live.session.id,
      });
      if (!delivered) {
        loseSession(live, 'DEVICE_OFFLINE', '设备未连接，无法恢复终端');
      }
    }
  };

  const handleDeviceDisconnected = (env: string): void => {
    for (const live of liveTerminals.values()) {
      if (live.session.env !== env) continue;
      persist(live, { status: 'DETACHED', lastActiveAt: Date.now() });
      gateway.broadcast({ type: 'terminal.updated', session: live.session });
      scheduleDetachTimeout(live);
    }
  };

  const closeSession = (id: number, reason?: string): TerminalSession => {
    const live = getLive(id);
    if (!live) {
      const existing = repo.getTerminalSession(id);
      if (!existing) {
        throw new NotFoundError(`terminal ${id} not found`);
      }
      if (existing.status === 'CLOSED' || existing.status === 'LOST') {
        return existing;
      }
      const updated = repo.updateTerminalSession(id, {
        status: 'CLOSED',
        closedAt: Date.now(),
        ...(reason ? { error: reason } : {}),
      });
      metrics.sessionsClosed += 1;
      return updated ?? existing;
    }

    gateway.sendToDevice(live.session.env, {
      type: 'pty.close',
      sessionId: live.session.id,
      ...(reason ? { reason } : {}),
    });
    flushInputAudit(live);
    persist(live, {
      status: 'CLOSED',
      closedAt: Date.now(),
      lastActiveAt: Date.now(),
      ...(reason ? { error: reason } : {}),
    });
    metrics.sessionsClosed += 1;
    audit(live, 'CLOSE', writerIdOf(live), reason ?? 'closed by admin');
    broadcastToViewers(live, {
      type: 'terminal.exit',
      sessionId: live.session.id,
      code: null,
    });
    gateway.broadcast({ type: 'terminal.updated', session: live.session });
    removeLive(live);
    return live.session;
  };

  const attachViewer = (
    viewer: WebSocket,
    live: LiveTerminal,
    afterSeq: number,
  ): void => {
    if (live.viewers.size >= config.terminalMaxViewers) {
      sendFrame(viewer, {
        type: 'terminal.error',
        sessionId: live.session.id,
        code: 'TOO_MANY_VIEWERS',
        message: 'terminal viewer limit reached',
      });
      viewer.close(4029, 'too many viewers');
      return;
    }

    const viewerId = `v_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    live.viewers.add(viewer);
    live.viewerIds.set(viewer, viewerId);

    if (!live.writer) {
      live.writer = viewer;
      live.writerLabel = undefined;
    }

    sendFrame(viewer, {
      type: 'terminal.ready',
      sessionId: live.session.id,
      viewerId,
      writerId: writerIdOf(live) ?? null,
      session: live.session,
    });
    sendFrame(viewer, {
      type: 'terminal.control',
      sessionId: live.session.id,
      writerId: writerIdOf(live) ?? null,
    });
    for (const event of live.chunks) {
      if (event.seq <= afterSeq) continue;
      sendFrame(viewer, {
        type: 'terminal.output',
        sessionId: live.session.id,
        seq: event.seq,
        data: event.data,
      });
    }

    viewer.on('message', (data) => {
      const frame = parseViewerFrame(data);
      if (!frame) {
        sendFrame(viewer, {
          type: 'terminal.error',
          sessionId: live.session.id,
          code: 'INVALID_FRAME',
          message: 'terminal frame is invalid',
        });
        return;
      }

      switch (frame.type) {
        case 'terminal.input': {
          if (!canWrite(live, viewer, viewerId)) return;
          if (!takeInputBudget(live, frame.data)) {
            sendFrame(viewer, {
              type: 'terminal.error',
              sessionId: live.session.id,
              code: 'RATE_LIMITED',
              message: 'input rate limit exceeded; slow down',
            });
            return;
          }
          gateway.sendToDevice(live.session.env, {
            type: 'pty.input',
            sessionId: live.session.id,
            data: frame.data,
          });
          live.pendingInput += frame.data;
          live.pendingViewerId = viewerId;
          if (
            /[\r\n]/.test(frame.data) ||
            live.pendingInput.length >= 1_024
          ) {
            flushInputAudit(live);
          }
          touch(live);
          break;
        }
        case 'terminal.resize':
          if (!canWrite(live, viewer, viewerId)) return;
          gateway.sendToDevice(live.session.env, {
            type: 'pty.resize',
            sessionId: live.session.id,
            cols: frame.cols,
            rows: frame.rows,
          });
          audit(live, 'RESIZE', viewerId, `${frame.cols}x${frame.rows}`);
          touch(live);
          break;
        case 'terminal.signal':
          if (!canWrite(live, viewer, viewerId)) return;
          gateway.sendToDevice(live.session.env, {
            type: 'pty.signal',
            sessionId: live.session.id,
            signal: frame.signal,
          });
          audit(live, 'SIGNAL', viewerId, frame.signal);
          break;
        case 'terminal.close':
          try {
            closeSession(Number(live.session.id), frame.reason);
          } catch {
            removeLive(live);
          }
          break;
        case 'terminal.claim':
          claimWriter(live, viewer, frame.label);
          break;
        case 'terminal.release':
          if (live.writer === viewer) {
            flushInputAudit(live);
            releaseWriter(live, viewer);
            audit(live, 'CLAIM', viewerId, 'released');
          }
          break;
        case 'terminal.detach':
          viewer.close(1000, 'detached');
          break;
        case 'terminal.ping':
          sendFrame(viewer, { type: 'pong', at: frame.at });
          break;
        default:
          break;
      }
    });

    const remove = (): void => {
      live.viewers.delete(viewer);
      live.viewerIds.delete(viewer);
      if (live.writer === viewer) {
        flushInputAudit(live);
        releaseWriter(live);
      }
    };
    viewer.on('close', remove);
    viewer.on('error', remove);
  };

  const handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
  ): void => {
    if (!config.terminalEnabled) {
      rejectUpgrade(socket, 404, 'terminal sessions are disabled');
      return;
    }

    const ticket = url.searchParams.get('ticket') ?? '';
    if (!verifyRealtimeTicket(ticket, config.approvalLinkSecret)) {
      rejectUpgrade(socket, 401, 'terminal ticket is missing or invalid');
      return;
    }

    const rawId = url.searchParams.get('sessionId') ?? '';
    if (!/^[1-9]\d*$/.test(rawId)) {
      rejectUpgrade(socket, 400, 'invalid terminal session id');
      return;
    }

    const live = getLive(rawId);
    if (!live) {
      rejectUpgrade(socket, 404, 'terminal session is not live');
      return;
    }

    const rawAfter = url.searchParams.get('afterSeq') ?? '0';
    const afterSeq = /^\d+$/.test(rawAfter) ? Number(rawAfter) : 0;

    wss.handleUpgrade(request, socket, head, (viewer) => {
      attachViewer(viewer, live, afterSeq);
    });
  };

  const create = (input: CreateTerminalInput): TerminalSession => {
    if (!config.terminalEnabled) {
      throw new ConflictError(
        'terminal sessions are disabled',
        'TERMINAL_DISABLED',
      );
    }
    if (
      config.terminalAllowedEnvs.length > 0 &&
      !config.terminalAllowedEnvs.includes(input.env)
    ) {
      throw new ConflictError(
        `terminal is not allowed on ${input.env}`,
        'TERMINAL_FORBIDDEN',
      );
    }
    const agent = repo.getAgent(input.env);
    if (agent?.terminalEnabled === false) {
      throw new ConflictError(
        `terminal is disabled for ${input.env}`,
        'TERMINAL_FORBIDDEN',
      );
    }
    if (!gateway.isDeviceConnected(input.env)) {
      throw new ConflictError(
        `device ${input.env} is offline`,
        'DEVICE_OFFLINE',
      );
    }
    if (repo.countActiveTerminalSessions() >= config.terminalMaxSessions) {
      throw new ConflictError(
        'global terminal session limit reached',
        'TERMINAL_LIMIT',
      );
    }
    if (
      repo.countActiveTerminalSessions(input.env) >=
      config.terminalMaxSessionsPerDevice
    ) {
      throw new ConflictError(
        `terminal session limit reached for ${input.env}`,
        'TERMINAL_LIMIT',
      );
    }

    const title =
      input.title?.trim() ||
      `${input.projectName ?? input.env} terminal`;
    const session = repo.createTerminalSession({ ...input, title });
    const live = makeLive(session);
    liveTerminals.set(session.id, live);
    metrics.sessionsCreated += 1;
    audit(live, 'CREATE', undefined, `shell=${input.shell ?? 'default'} cwd=${input.cwd ?? 'default'}`);

    const delivered = gateway.sendToDevice(input.env, {
      type: 'pty.create',
      sessionId: session.id,
      ...(input.shell ? { shell: input.shell } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      cols: input.cols,
      rows: input.rows,
    });

    if (!delivered) {
      loseSession(live, 'DEVICE_OFFLINE', '设备未连接，无法创建终端');
      return live.session;
    }

    scheduleIdle(live);
    gateway.broadcast({ type: 'terminal.created', session });
    return session;
  };

  const events = (
    id: number,
    query: ListTerminalEventsQuery,
  ): TerminalEventListResponse => {
    const live = getLive(id);
    if (live) {
      const matching = live.chunks.filter((event) => event.seq > query.after);
      const events = matching.slice(0, query.limit);
      return {
        events,
        nextSeq: events.at(-1)?.seq ?? query.after,
        truncated: matching.length > events.length,
      };
    }

    const session = repo.getTerminalSession(id);
    if (!session) throw new NotFoundError(`terminal ${id} not found`);
    return { events: [], nextSeq: query.after, truncated: false };
  };

  // Rehydrate sessions from a previous server process. They stay DETACHED
  // until the device reconnects and answers `pty.attach`.
  for (const session of repo.listActiveTerminalSessions()) {
    const updated =
      repo.updateTerminalSession(Number(session.id), {
        status: 'DETACHED',
      }) ?? session;
    const live = makeLive(updated);
    liveTerminals.set(updated.id, live);
    if (gateway.isDeviceConnected(updated.env)) {
      gateway.sendToDevice(updated.env, {
        type: 'pty.attach',
        sessionId: updated.id,
      });
    } else {
      scheduleDetachTimeout(live);
    }
    scheduleIdle(live);
  }

  const offFrame = gateway.onDeviceFrame(handleDeviceFrame);
  const offConnected = gateway.onDeviceConnected(handleDeviceConnected);
  const offDisconnected = gateway.onDeviceDisconnected(
    handleDeviceDisconnected,
  );
  const offUpgrade = gateway.registerUpgradePath('/ws/terminal', handleUpgrade);
  log?.info({ sessions: liveTerminals.size }, 'terminal manager ready');

  return {
    create,
    get: (id) => repo.getTerminalSession(id),
    list: (query) => repo.listTerminalSessions(query),
    close: closeSession,
    events,
    audit: (id, query) => repo.listTerminalAudit(id, query),
    stats: () => {
      let viewers = 0;
      for (const live of liveTerminals.values()) viewers += live.viewers.size;
      return {
        enabled: config.terminalEnabled,
        active: liveTerminals.size,
        viewers,
        sessionsCreated: metrics.sessionsCreated,
        sessionsClosed: metrics.sessionsClosed,
        inputBytes: metrics.inputBytes,
        outputBytes: metrics.outputBytes,
      };
    },
    closeAll: () => {
      offFrame();
      offConnected();
      offDisconnected();
      offUpgrade();
      for (const live of liveTerminals.values()) {
        flushInputAudit(live);
        // Keep the PTY alive on the device: a graceful hub restart should be
        // followed by `pty.attach`, not by killing every shell. The device's
        // own detach TTL bounds an abandoned reconnect.
        persist(live, {
          status: 'DETACHED',
          lastActiveAt: Date.now(),
        });
        closeViewers(live);
      }
      liveTerminals.clear();
      try {
        wss.close();
      } catch {
        // No viewers left.
      }
    },
  };
}
