import { z } from 'zod';

import { ticketIdSchema } from './schemas.js';

export const TERMINAL_SESSION_STATUSES = [
  'STARTING',
  'ACTIVE',
  'DETACHED',
  'CLOSED',
  'LOST',
] as const;

export type TerminalSessionStatus =
  (typeof TERMINAL_SESSION_STATUSES)[number];

export const TERMINAL_SIGNALS = [
  'SIGINT',
  'SIGTERM',
  'SIGKILL',
  'SIGTSTP',
] as const;

export type TerminalSignal = (typeof TERMINAL_SIGNALS)[number];

export const TERMINAL_AUDIT_KINDS = [
  'CREATE',
  'INPUT',
  'RESIZE',
  'SIGNAL',
  'CLAIM',
  'CLOSE',
] as const;

export type TerminalAuditKind = (typeof TERMINAL_AUDIT_KINDS)[number];

export const TERMINAL_SESSION_STATUSES_ACTIVE: TerminalSessionStatus[] = [
  'STARTING',
  'ACTIVE',
  'DETACHED',
];

export const terminalSessionSchema = z.object({
  id: ticketIdSchema,
  env: z.string().trim().min(1).max(64),
  projectName: z.string().trim().min(1).max(128).optional(),
  title: z.string().trim().min(1).max(120),
  shell: z.string().trim().max(512).optional(),
  cwd: z.string().trim().max(1024).optional(),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
  status: z.enum(TERMINAL_SESSION_STATUSES),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastActiveAt: z.number().int().nonnegative(),
  closedAt: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().optional(),
  error: z.string().max(2000).optional(),
});

export type TerminalSession = z.infer<typeof terminalSessionSchema>;

export const createTerminalSchema = z.object({
  env: z.string().trim().min(1).max(64),
  projectName: z.string().trim().min(1).max(128).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  shell: z.string().trim().max(512).optional(),
  cwd: z.string().trim().max(1024).optional(),
  cols: z.number().int().min(1).max(1000).default(120),
  rows: z.number().int().min(1).max(1000).default(30),
});

export type CreateTerminalInput = z.infer<typeof createTerminalSchema>;

export const terminalInputSchema = z.object({
  data: z.string().min(1).max(8_192),
});

export type TerminalInput = z.infer<typeof terminalInputSchema>;

export const terminalResizeSchema = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});

export type TerminalResizeInput = z.infer<typeof terminalResizeSchema>;

export const terminalSignalSchema = z.object({
  signal: z.enum(TERMINAL_SIGNALS),
});

export type TerminalSignalInput = z.infer<typeof terminalSignalSchema>;

export const terminalCloseSchema = z.object({
  reason: z.string().trim().max(200).optional(),
});

export type TerminalCloseInput = z.infer<typeof terminalCloseSchema>;

export const listTerminalsQuerySchema = z.object({
  env: z.string().trim().min(1).max(64).optional(),
  status: z.enum(TERMINAL_SESSION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type ListTerminalsQuery = z.infer<typeof listTerminalsQuerySchema>;

export const listTerminalEventsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export type ListTerminalEventsQuery = z.infer<
  typeof listTerminalEventsQuerySchema
>;

/** One scrollback chunk returned by the HTTP fallback / replay endpoint. */
export const terminalEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  data: z.string(),
  createdAt: z.number().int().nonnegative(),
});

export type TerminalEvent = z.infer<typeof terminalEventSchema>;

export const terminalResponseSchema = z.object({ session: terminalSessionSchema });

export const terminalListResponseSchema = z.object({
  sessions: z.array(terminalSessionSchema),
  total: z.number().int().nonnegative(),
});

export const terminalEventListResponseSchema = z.object({
  events: z.array(terminalEventSchema),
  nextSeq: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export type TerminalResponse = z.infer<typeof terminalResponseSchema>;
export type TerminalListResponse = z.infer<typeof terminalListResponseSchema>;
export type TerminalEventListResponse = z.infer<
  typeof terminalEventListResponseSchema
>;

/** One audited action on a terminal session. */
export const terminalAuditEntrySchema = z.object({
  id: ticketIdSchema,
  sessionId: ticketIdSchema,
  env: z.string().trim().min(1).max(64),
  kind: z.enum(TERMINAL_AUDIT_KINDS),
  viewerId: z.string().trim().max(64).optional(),
  data: z.string().max(2_000).optional(),
  createdAt: z.number().int().nonnegative(),
});

export type TerminalAuditEntry = z.infer<typeof terminalAuditEntrySchema>;

export const listTerminalAuditQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type ListTerminalAuditQuery = z.infer<
  typeof listTerminalAuditQuerySchema
>;

export const terminalAuditExportQuerySchema = z.object({
  format: z.enum(['jsonl', 'csv']).default('jsonl'),
});

export type TerminalAuditExportQuery = z.infer<
  typeof terminalAuditExportQuerySchema
>;

export const terminalAuditListResponseSchema = z.object({
  entries: z.array(terminalAuditEntrySchema),
  nextAfter: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export type TerminalAuditListResponse = z.infer<
  typeof terminalAuditListResponseSchema
>;

export const terminalStatsResponseSchema = z.object({
  enabled: z.boolean(),
  active: z.number().int().nonnegative(),
  viewers: z.number().int().nonnegative(),
  sessionsCreated: z.number().int().nonnegative(),
  sessionsClosed: z.number().int().nonnegative(),
  inputBytes: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
});

export type TerminalStatsResponse = z.infer<
  typeof terminalStatsResponseSchema
>;

/** Input is capped so a paste cannot occupy a single WebSocket frame forever. */
export const TERMINAL_MAX_INPUT_BYTES = 8_192;

/**
 * Frames sent by a browser terminal viewer over `/ws/terminal`.
 * The endpoint is bound to one session, so frames do not carry a session id.
 */
export const terminalViewerFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('terminal.input'),
    data: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal('terminal.resize'),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
  z.object({
    type: z.literal('terminal.signal'),
    signal: z.enum(TERMINAL_SIGNALS),
  }),
  z.object({
    type: z.literal('terminal.close'),
    reason: z.string().trim().max(200).optional(),
  }),
  z.object({
    type: z.literal('terminal.detach'),
  }),
  z.object({
    type: z.literal('terminal.claim'),
    label: z.string().trim().max(80).optional(),
  }),
  z.object({
    type: z.literal('terminal.release'),
  }),
  z.object({
    type: z.literal('terminal.ping'),
    at: z.number().int().nonnegative(),
  }),
]);

export type TerminalViewerFrame = z.infer<typeof terminalViewerFrameSchema>;
