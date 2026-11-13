import { z } from 'zod';

import {
  DEVICE_PROTOCOL_VERSION,
  deviceCapabilitiesSchema,
  deviceStatsSchema,
} from './device.js';
import {
  agentSchema,
  agentTaskSchema,
  chatMessageSchema,
  chatSessionSchema,
  decisionTicketSchema,
  syncStateSchema,
  ticketIdSchema,
} from './schemas.js';
import {
  TERMINAL_SIGNALS,
  terminalSessionSchema,
} from './terminal.js';
import { nodeProfileSchema } from './node.js';
import { permissionActionSchema, supervisorDecisionSchema } from './supervisor.js';

/**
 * Realtime frames.
 *
 * The hub uses one JSON envelope for devices and dashboards. Terminal frames
 * will be added in a later phase; keeping the envelope stable means the web
 * client can ignore frame types it does not understand.
 */
export const realtimeClientFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocol: z.number().int().positive().default(DEVICE_PROTOCOL_VERSION),
    env: z.string().trim().min(1).max(64).optional(),
    projectName: z.string().trim().min(1).max(128).optional(),
    capabilities: deviceCapabilitiesSchema,
    stats: deviceStatsSchema.optional(),
    /** Placement profile (role, tags, repos, free memory); see NODE_REGISTER. */
    profile: nodeProfileSchema.optional(),
  }),
  z.object({
    type: z.literal('heartbeat'),
    at: z.number().int().nonnegative(),
    stats: deviceStatsSchema.optional(),
    /** Re-sent when the inventory changed, e.g. a new checkout appeared. */
    profile: nodeProfileSchema.optional(),
  }),
  z.object({
    type: z.literal('ping'),
    at: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('sync.request'),
  }),
  z.object({
    type: z.literal('task.claim'),
    requestId: z.string().trim().min(1).max(64),
    timeoutMs: z.number().int().min(0).max(55_000).optional(),
  }),
  z.object({
    type: z.literal('task.complete'),
    requestId: z.string().trim().min(1).max(64).optional(),
    taskId: ticketIdSchema,
    status: z.enum(['DONE', 'FAILED']),
    result: z.string().trim().max(4_000).optional(),
  }),
  z.object({
    type: z.literal('task.log'),
    taskId: ticketIdSchema,
    stream: z.enum(['stdout', 'stderr', 'system']),
    chunk: z.string().min(1).max(16_384),
  }),
  z.object({
    type: z.literal('task.release'),
    requestId: z.string().trim().min(1).max(64).optional(),
    taskId: ticketIdSchema,
    requeue: z.boolean().default(true),
    reason: z.string().trim().max(500).optional(),
  }),
  z.object({
    type: z.literal('ticket.wait'),
    requestId: z.string().trim().min(1).max(64),
    ticketId: ticketIdSchema,
    timeoutMs: z.number().int().min(0).max(55_000).optional(),
  }),
  z.object({
    /** PERMISSION_REQUEST: the node parks an agent action until the hub rules. */
    type: z.literal('permission.request'),
    requestId: z.string().trim().min(1).max(64),
    taskId: ticketIdSchema.optional(),
    ticketId: ticketIdSchema.optional(),
    action: permissionActionSchema,
    timeoutMs: z.number().int().min(0).max(55_000).optional(),
  }),
  z.object({
    type: z.literal('chat.claim'),
    requestId: z.string().trim().min(1).max(64),
    timeoutMs: z.number().int().min(0).max(55_000).optional(),
  }),
  z.object({
    type: z.literal('chat.event'),
    sessionId: ticketIdSchema,
    messageId: ticketIdSchema,
    stream: z.enum(['stdout', 'stderr', 'system']),
    chunk: z.string().min(1).max(16_384),
  }),
  z.object({
    type: z.literal('chat.complete'),
    requestId: z.string().trim().min(1).max(64).optional(),
    sessionId: ticketIdSchema,
    messageId: ticketIdSchema,
    status: z.enum(['DONE', 'FAILED']),
    content: z.string().max(20_000).optional(),
    externalId: z.string().max(128).optional(),
    error: z.string().max(2_000).optional(),
  }),
  z.object({
    type: z.literal('pty.ready'),
    sessionId: ticketIdSchema,
    pid: z.number().int().positive().optional(),
    shell: z.string().trim().max(512).optional(),
  }),
  z.object({
    type: z.literal('pty.output'),
    sessionId: ticketIdSchema,
    seq: z.number().int().nonnegative(),
    data: z.string().max(65_536),
  }),
  z.object({
    type: z.literal('pty.exit'),
    sessionId: ticketIdSchema,
    code: z.number().int().nullable(),
    signal: z.string().trim().max(32).optional(),
  }),
  z.object({
    type: z.literal('pty.error'),
    sessionId: ticketIdSchema,
    code: z.string().trim().min(1).max(64),
    message: z.string().trim().max(500),
  }),
]);

export type RealtimeClientFrame = z.infer<typeof realtimeClientFrameSchema>;

export const realtimeServerFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    protocol: z.number().int().positive(),
    serverTime: z.number().int().nonnegative(),
    heartbeatMs: z.number().int().positive(),
    role: z.enum(['device', 'dashboard', 'bridge']),
    env: z.string().trim().max(64).optional(),
  }),
  z.object({
    type: z.literal('device.updated'),
    agent: agentSchema,
  }),
  z.object({
    type: z.literal('sync.changed'),
    rev: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('sync.snapshot'),
    rev: z.number().int().nonnegative(),
    state: syncStateSchema,
  }),
  z.object({
    type: z.literal('ack'),
    requestId: z.string().trim().max(64).optional(),
    at: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('task.assigned'),
    requestId: z.string().trim().min(1).max(64),
    task: agentTaskSchema.nullable(),
    timedOut: z.boolean(),
  }),
  z.object({
    type: z.literal('task.completed'),
    requestId: z.string().trim().max(64).optional(),
    task: agentTaskSchema,
  }),
  z.object({
    type: z.literal('task.released'),
    requestId: z.string().trim().max(64).optional(),
    task: agentTaskSchema,
  }),
  z.object({
    type: z.literal('ticket.resolved'),
    requestId: z.string().trim().min(1).max(64),
    ticket: decisionTicketSchema,
    timedOut: z.boolean(),
  }),
  z.object({
    /** SUPERVISOR_DECISION: the answer to a parked permission.request. */
    type: z.literal('supervisor.decision'),
    requestId: z.string().trim().min(1).max(64).optional(),
    taskId: ticketIdSchema.optional(),
    ticketId: ticketIdSchema.optional(),
    decision: supervisorDecisionSchema,
  }),
  z.object({
    type: z.literal('chat.assigned'),
    requestId: z.string().trim().min(1).max(64),
    session: chatSessionSchema.nullable(),
    message: chatMessageSchema.nullable(),
    timedOut: z.boolean(),
  }),
  z.object({
    type: z.literal('chat.completed'),
    requestId: z.string().trim().max(64).optional(),
    session: chatSessionSchema,
    message: chatMessageSchema,
  }),
  z.object({
    type: z.literal('device.offline'),
    env: z.string().trim().min(1).max(64),
    at: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('pong'),
    at: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('pty.create'),
    sessionId: ticketIdSchema,
    shell: z.string().trim().max(512).optional(),
    cwd: z.string().trim().max(1024).optional(),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal('pty.attach'),
    sessionId: ticketIdSchema,
  }),
  z.object({
    type: z.literal('pty.input'),
    sessionId: ticketIdSchema,
    data: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal('pty.resize'),
    sessionId: ticketIdSchema,
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
  z.object({
    type: z.literal('pty.signal'),
    sessionId: ticketIdSchema,
    signal: z.enum(TERMINAL_SIGNALS),
  }),
  z.object({
    type: z.literal('pty.close'),
    sessionId: ticketIdSchema,
    reason: z.string().trim().max(200).optional(),
  }),
  z.object({
    type: z.literal('terminal.created'),
    session: terminalSessionSchema,
  }),
  z.object({
    type: z.literal('terminal.ready'),
    sessionId: ticketIdSchema,
    viewerId: z.string().trim().min(1).max(64),
    writerId: z.string().trim().min(1).max(64).nullable(),
    session: terminalSessionSchema,
  }),
  z.object({
    type: z.literal('terminal.control'),
    sessionId: ticketIdSchema,
    writerId: z.string().trim().min(1).max(64).nullable(),
    writerLabel: z.string().trim().max(80).optional(),
  }),
  z.object({
    type: z.literal('terminal.updated'),
    session: terminalSessionSchema,
  }),
  z.object({
    type: z.literal('terminal.output'),
    sessionId: ticketIdSchema,
    seq: z.number().int().nonnegative(),
    data: z.string().max(65_536),
  }),
  z.object({
    type: z.literal('terminal.exit'),
    sessionId: ticketIdSchema,
    code: z.number().int().nullable(),
    signal: z.string().trim().max(32).optional(),
  }),
  z.object({
    type: z.literal('terminal.error'),
    sessionId: ticketIdSchema,
    code: z.string().trim().min(1).max(64),
    message: z.string().trim().max(500),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string().trim().min(1).max(64),
    message: z.string().trim().max(500),
  }),
]);

export type RealtimeServerFrame = z.infer<typeof realtimeServerFrameSchema>;

export const REALTIME_HEARTBEAT_MS = 30_000;
export const REALTIME_HEARTBEAT_TIMEOUT_MS = 90_000;
export const REALTIME_MAX_FRAME_BYTES = 64 * 1024;

/**
 * The blueprint event names mapped onto the frames this transport actually
 * speaks, so both vocabularies resolve to one protocol instead of two.
 */
export const WS_EVENTS = {
  NODE_REGISTER: 'hello',
  NODE_HEARTBEAT: 'heartbeat',
  TASK_DISPATCH: 'task.assigned',
  TASK_LOG_STREAM: 'task.log',
  PERMISSION_REQUEST: 'permission.request',
  SUPERVISOR_DECISION: 'supervisor.decision',
} as const;

export type WsEventName = keyof typeof WS_EVENTS;

/** Parse a node → hub frame, or `null` when a peer sent something unusable. */
export function parseRealtimeClientFrame(
  value: unknown,
): RealtimeClientFrame | null {
  const parsed = realtimeClientFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Parse a hub → node frame, or `null` when a peer sent something unusable. */
export function parseRealtimeServerFrame(
  value: unknown,
): RealtimeServerFrame | null {
  const parsed = realtimeServerFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
