import { z } from 'zod';

import {
  DEFAULT_WAIT_TIMEOUT_MS,
  ENV_STATUSES,
  MAX_WAIT_TIMEOUT_MS,
  OPTION_RISKS,
  AGENT_KINDS,
  AGENT_STATUSES,
  RULE_CANDIDATE_STATUSES,
  CHAT_MESSAGE_DECISIONS,
  CHAT_MESSAGE_ORIGINS,
  CHAT_MESSAGE_STATUSES,
  CHAT_ROLES,
  CHAT_SESSION_STATUSES,
  DECISION_KINDS,
  DECISION_VERDICTS,
  TASK_LOG_STREAMS,
  TASK_STATUSES,
  TICKET_STATUSES,
} from './constants.js';
import {
  DEVICE_TRANSPORTS,
  deviceCapabilitiesSchema,
  deviceStatsSchema,
} from './device.js';

/* ------------------------------------------------------------------ */
/* Branded-ish scalars                                                 */
/* ------------------------------------------------------------------ */

/** Ticket IDs are positive integers, serialized as decimal strings. */
export const ticketIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'ticket id must be a positive integer string');

const envSchema = z.string().trim().min(1).max(64);
const projectNameSchema = z.string().trim().min(1).max(128);
const shortTextSchema = z.string().trim().min(1).max(500);
const longTextSchema = z.string().trim().min(1).max(2000);

/* ------------------------------------------------------------------ */
/* Ticket                                                              */
/* ------------------------------------------------------------------ */

export const ticketOptionSchema = z.object({
  key: z.string().trim().min(1).max(8),
  label: z.string().trim().min(1).max(80),
  prosCons: z.string().trim().max(300).optional(),
  risk: z
    .enum(OPTION_RISKS)
    .optional()
    .describe(
      'safe | caution | destructive. Destructive options are never auto-approved and require explicit human confirmation.',
    ),
});

export const ticketStatusSchema = z.enum(TICKET_STATUSES);

/**
 * The full persisted ticket, as returned by the API.
 */
export const decisionTicketSchema = z.object({
  id: ticketIdSchema,
  env: envSchema,
  projectName: projectNameSchema,
  status: ticketStatusSchema,

  doneSummary: shortTextSchema,
  blockerQuestion: longTextSchema,
  nextStepPlan: longTextSchema,

  options: z.array(ticketOptionSchema).min(2).max(6),
  recommendedOption: z.string().trim().min(1).max(8),

  selectedOption: z.string().trim().min(1).max(8).optional(),
  customInstruction: z.string().trim().max(2000).optional(),
  resolvedBy: z.enum(['META_AGENT', 'HUMAN', 'TIMEOUT']).optional(),
  resolutionReason: z.string().trim().max(2000).optional(),

  /** When set, the ticket is auto-resolved with the recommended option at this time. */
  expiresAt: z.number().int().nonnegative().optional(),

  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

/**
 * Payload accepted by POST /api/tickets.
 * Everything required to build a three-line brief plus closed-form options.
 */
export const createTicketSchema = z
  .object({
    env: envSchema,
    projectName: projectNameSchema,
    doneSummary: shortTextSchema,
    blockerQuestion: longTextSchema,
    nextStepPlan: longTextSchema,
    options: z.array(ticketOptionSchema).min(2).max(6),
    recommendedOption: z.string().trim().min(1).max(8),
  })
  .superRefine((value, ctx) => {
    const keys = value.options.map((option) => option.key);
    const uniqueKeys = new Set(keys);

    if (uniqueKeys.size !== keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'option keys must be unique',
      });
    }

    if (!uniqueKeys.has(value.recommendedOption)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recommendedOption'],
        message: 'recommendedOption must reference one of the provided options',
      });
    }
  });

/** Payload accepted by POST /api/tickets/:id/resolve. */
export const resolveTicketSchema = z.object({
  selectedOption: z.string().trim().min(1).max(8),
  customInstruction: z.string().trim().max(2000).optional(),
  /** Required when the selected option is marked `destructive`. */
  confirmDestructive: z.boolean().optional(),
});

/** Payload accepted by POST /api/tickets/:id/extend. */
export const extendTicketSchema = z.object({
  minutes: z.coerce.number().int().min(1).max(1440).default(10),
});

/** Payload accepted by POST /api/tickets/batch-resolve. */
export const batchResolveTicketsSchema = z.object({
  ticketIds: z.array(ticketIdSchema).min(1).max(50),
  /** Omit to use each ticket's own recommended option. */
  selectedOption: z.string().trim().min(1).max(8).optional(),
  customInstruction: z.string().trim().max(2000).optional(),
  confirmDestructive: z.boolean().optional(),
});

/** Query accepted by GET /api/tickets. */
export const listTicketsQuerySchema = z.object({
  status: ticketStatusSchema.optional(),
  projectName: projectNameSchema.optional(),
  env: envSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Query accepted by GET /api/tickets/:id/wait. */
export const waitQuerySchema = z.object({
  timeout: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_TIMEOUT_MS)
    .default(DEFAULT_WAIT_TIMEOUT_MS),
});

/* ------------------------------------------------------------------ */
/* Heartbeat                                                           */
/* ------------------------------------------------------------------ */

/** Metadata a bridge can attach to its heartbeats (and first escalation). */
export const agentMetaSchema = z.object({
  kind: z.enum(AGENT_KINDS).optional(),
  version: z.string().trim().max(40).optional(),
  host: z.string().trim().max(120).optional(),
  os: z.string().trim().max(60).optional(),
});

export const heartbeatSchema = z.object({
  env: envSchema,
  status: z.enum(ENV_STATUSES),
  projectName: projectNameSchema.optional(),
  currentTask: z.string().trim().max(300).optional(),
  note: z.string().trim().max(500).optional(),
  /** Optional client metadata; the hub auto-registers the agent from it. */
  agent: agentMetaSchema.optional(),
});

export const envHeartbeatSchema = z.object({
  env: envSchema,
  status: z.enum(ENV_STATUSES),
  projectName: projectNameSchema.optional(),
  currentTask: z.string().trim().max(300).optional(),
  note: z.string().trim().max(500).optional(),
  lastSeenAt: z.number().int().nonnegative(),
  online: z.boolean(),
});

/* ------------------------------------------------------------------ */
/* Agent registry                                                      */
/* ------------------------------------------------------------------ */

/**
 * A registered bridge/agent. `env` is the stable identity used by tickets,
 * tasks and heartbeats; the other fields make it manageable from the console.
 *
 * Tokens are never returned in this shape — only a prefix for identification.
 */
export const agentSchema = z.object({
  env: envSchema,
  name: z.string().trim().min(1).max(64),
  kind: z.enum(AGENT_KINDS),
  status: z.enum(AGENT_STATUSES),
  version: z.string().max(40).optional(),
  host: z.string().max(120).optional(),
  os: z.string().max(60).optional(),
  /** Realtime device protocol version, present once a WS device connects. */
  protocolVersion: z.number().int().positive().optional(),
  /** Local CLI inventory and PTY capability reported by the device daemon. */
  capabilities: deviceCapabilitiesSchema.optional(),
  /** Last CPU/memory/load snapshot. */
  deviceStats: deviceStatsSchema.optional(),
  /** Which transport is currently attached: ws for the device daemon, http for legacy bridges. */
  transport: z.enum(DEVICE_TRANSPORTS).optional(),
  /** Whether the realtime WS peer is currently attached. */
  connected: z.boolean().optional(),
  /** Whether this device may open interactive terminals. */
  terminalEnabled: z.boolean().optional(),
  /** When the current WS connection was established. */
  connectedAt: z.number().int().nonnegative().optional(),
  /** First characters of the active token, for display; never the secret. */
  tokenPrefix: z.string().max(16).optional(),
  hasToken: z.boolean(),
  online: z.boolean(),
  lastSeenAt: z.number().int().nonnegative().optional(),
  projectName: projectNameSchema.optional(),
  currentTask: z.string().max(300).optional(),
  note: z.string().max(500).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const createAgentSchema = z.object({
  env: envSchema,
  name: z.string().trim().min(1).max(64).optional(),
  kind: z.enum(AGENT_KINDS).optional(),
  /** Optional machine metadata so auto-provisioned agents show on the right node. */
  host: z.string().trim().max(120).optional(),
  os: z.string().trim().max(60).optional(),
});

export const updateAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    kind: z.enum(AGENT_KINDS).optional(),
    status: z.enum(AGENT_STATUSES).optional(),
    terminalEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'at least one field must be provided',
  });

export const listAgentsQuerySchema = z.object({
  status: z.enum(AGENT_STATUSES).optional(),
});

/* ------------------------------------------------------------------ */
/* One-time enrollment codes                                           */
/* ------------------------------------------------------------------ */

/** Default lifetime of a one-click enrollment code. */
export const ENROLLMENT_CODE_TTL_MS = 15 * 60 * 1000;

/**
 * How many client slots a code may enroll on one machine by default.
 *
 * One command installs Cursor, OpenCode, Claude Code and Codex; each client
 * needs its own env (and therefore its own token), so a single-use code would
 * force users to generate one code per editor.
 */
export const ENROLLMENT_CODE_MAX_USES = 10;

export const enrollmentCodeSchema = z
  .string()
  .trim()
  .min(6)
  .max(64)
  // Accept "ABCDE-FGHIJ" as typed/copy-pasted by humans; hashing normalizes it.
  .transform((value) => value.replace(/[\s-]+/g, '').toUpperCase());

/** Admin creates a code and hands the installer one command. */
export const createEnrollmentSchema = z.object({
  /** Pre-bound env name; the installer derives one when omitted. */
  env: envSchema.optional(),
  /** Human label shown in the create response, e.g. "公司的 Windows". */
  label: z.string().trim().max(64).optional(),
  projectName: projectNameSchema.optional(),
  kind: z.enum(AGENT_KINDS).optional(),
  /** Override the 15-minute default. */
  ttlMinutes: z.number().int().min(1).max(24 * 60).optional(),
  /**
   * How many client slots one code may enroll on the same host: 1 for a
   * single client, up to 10 so one machine can attach Cursor / OpenCode /
   * Claude Code / Codex with a single install command.
   */
  maxUses: z.number().int().min(1).max(50).optional(),
});

/** Public exchange: the code is the capability. */
export const redeemEnrollmentSchema = z.object({
  code: enrollmentCodeSchema,
  host: z.string().trim().max(120).optional(),
  os: z.string().trim().max(60).optional(),
  kind: z.enum(AGENT_KINDS).optional(),
  /** Installer-derived env; falls back to the code's env or host slug. */
  env: envSchema.optional(),
  projectName: projectNameSchema.optional(),
  version: z.string().trim().max(40).optional(),
});

export const enrollmentSchema = z.object({
  /** Plaintext code; only returned when it is created. */
  code: z.string(),
  env: envSchema.optional(),
  label: z.string().optional(),
  projectName: projectNameSchema.optional(),
  kind: z.enum(AGENT_KINDS).optional(),
  expiresAt: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  /** Redemption budget for this code (one per client on the same host). */
  maxUses: z.number().int().positive(),
  /** How many times the code has already been redeemed. */
  useCount: z.number().int().nonnegative(),
});

export const enrollmentResponseSchema = z.object({
  enrollment: enrollmentSchema,
  commands: z.object({
    unix: z.string(),
    windows: z.string(),
  }),
});

export const enrollResponseSchema = z.object({
  hubUrl: z.string(),
  token: z.string(),
  env: envSchema,
  agent: agentSchema,
  projectName: projectNameSchema.optional(),
});

/* ------------------------------------------------------------------ */
/* Human → Agent tasks                                                 */
/* ------------------------------------------------------------------ */

export const taskStatusSchema = z.enum(TASK_STATUSES);

/** Full persisted task, as returned by the API. */
export const agentTaskSchema = z.object({
  id: ticketIdSchema,
  env: envSchema,
  projectName: projectNameSchema.optional(),
  title: z.string().trim().min(1).max(200),
  instruction: longTextSchema,
  status: taskStatusSchema,
  /** How many times a bridge has claimed this task. */
  attempts: z.number().int().nonnegative(),

  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  claimedAt: z.number().int().nonnegative().optional(),
  /** Last lease renewal; a live agent keeps it fresh while working. */
  leaseAt: z.number().int().nonnegative().optional(),
  completedAt: z.number().int().nonnegative().optional(),
  result: z.string().trim().max(4000).optional(),
});

/** Payload accepted by POST /api/tasks (dashboard dispatch). */
export const createTaskSchema = z.object({
  env: envSchema,
  projectName: projectNameSchema.optional(),
  title: z.string().trim().min(1).max(200),
  instruction: longTextSchema,
});

/** Query accepted by GET /api/tasks. */
export const listTasksQuerySchema = z.object({
  env: envSchema.optional(),
  status: taskStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** Query accepted by GET /api/tasks/next (bridge long-poll). */
export const nextTaskQuerySchema = z.object({
  env: envSchema,
  timeout: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_TIMEOUT_MS)
    .default(DEFAULT_WAIT_TIMEOUT_MS),
});

/** Payload accepted by POST /api/tasks/:id/complete. */
export const completeTaskSchema = z.object({
  status: z.enum(['DONE', 'FAILED']),
  result: z.string().trim().max(4000).optional(),
});

/**
 * Payload accepted by POST /api/tasks/:id/release.
 *
 * Used by the wake daemon when it claimed a task but could not hand it to any
 * local agent: `requeue` puts the task back in the queue so the next bridge or
 * wake adapter can retry it, otherwise it is failed immediately.
 */
export const releaseTaskSchema = z.object({
  requeue: z.boolean().default(true),
  reason: z.string().trim().max(500).optional(),
});

/* ------------------------------------------------------------------ */
/* Task execution logs                                                 */
/* ------------------------------------------------------------------ */

export const taskLogStreamSchema = z.enum(TASK_LOG_STREAMS);

export const taskLogSchema = z.object({
  id: z.number().int().positive(),
  taskId: ticketIdSchema,
  stream: taskLogStreamSchema,
  chunk: z.string().max(16_384),
  createdAt: z.number().int().nonnegative(),
});

/** Payload accepted by POST /api/tasks/:id/log. */
export const appendTaskLogSchema = z.object({
  stream: taskLogStreamSchema,
  chunk: z.string().min(1).max(16_384),
});

export const listTaskLogsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const taskLogListResponseSchema = z.object({
  logs: z.array(taskLogSchema),
  nextAfter: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

/* ------------------------------------------------------------------ */
/* Interactive sessions                                                */
/* ------------------------------------------------------------------ */

export const chatSessionSchema = z.object({
  id: ticketIdSchema,
  env: envSchema,
  projectName: projectNameSchema.optional(),
  title: z.string().trim().min(1).max(120),
  status: z.enum(CHAT_SESSION_STATUSES),
  /** CLI-native session id used to resume the conversation. */
  externalId: z.string().max(128).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastMessageAt: z.number().int().nonnegative().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  /**
   * Messages that still need human or runner attention (draft to adopt,
   * queued, or failed). Drives the unread-style dot in the session list.
   */
  pendingCount: z.number().int().nonnegative().optional(),
});

export const chatMessageSchema = z.object({
  id: ticketIdSchema,
  sessionId: ticketIdSchema,
  role: z.enum(CHAT_ROLES),
  content: z.string().max(32_000),
  status: z.enum(CHAT_MESSAGE_STATUSES),
  /** `agent` when this is a draft the hub wrote for the human to adopt. */
  origin: z.enum(CHAT_MESSAGE_ORIGINS),
  /** How the reply got queued; absent for human-typed messages. */
  decision: z.enum(CHAT_MESSAGE_DECISIONS).optional(),
  /** Why the agent proposed this reply; shown next to the draft. */
  rationale: z.string().max(2_000).optional(),
  error: z.string().max(2_000).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const chatEventSchema = z.object({
  id: z.number().int().positive(),
  sessionId: ticketIdSchema,
  messageId: ticketIdSchema,
  stream: taskLogStreamSchema,
  chunk: z.string().max(16_384),
  createdAt: z.number().int().nonnegative(),
});

export const createChatSessionSchema = z.object({
  env: envSchema,
  projectName: projectNameSchema.optional(),
  title: z.string().trim().min(1).max(120).optional(),
});

export const sendChatMessageSchema = z.object({
  content: z.string().trim().min(1).max(32_000),
});

/**
 * Draft a reply on the human's behalf (L1 "draft mode").
 *
 * The draft is stored as a `PROPOSED` user message. Only after a human adopts
 * it does it become `PENDING` and reach the bridge long-poll, so an agent can
 * never put words in the human's mouth unreviewed.
 */
export const proposeChatReplySchema = z.object({
  env: envSchema,
  /** Target conversation; when omitted the newest active session for `env` wins. */
  sessionId: ticketIdSchema.optional(),
  content: z.string().trim().min(1).max(32_000),
  rationale: z.string().trim().min(1).max(2_000).optional(),
});

export const adoptChatProposalSchema = z.object({
  /** Human edit applied while adopting; omitted means send as drafted. */
  content: z.string().trim().min(1).max(32_000).optional(),
});

/**
 * One submission to the hub's judgment layer.
 *
 * Under the "hub decides" model an agent never chooses between acting and
 * asking: it describes the exact action it wants to take, and the hub answers
 * `APPROVED` (proceed) or `PENDING` (a ticket now waits for a human).
 */
export const decisionRequestSchema = z.object({
  env: envSchema,
  projectName: projectNameSchema,
  kind: z.enum(DECISION_KINDS),
  /** The exact reply or next action the agent would take. */
  proposal: z.string().trim().min(1).max(32_000),
  /** One-line why, shown on the ticket and the transcript. */
  rationale: z.string().trim().max(2_000).optional(),
  /** Facts the hub should weigh: diff summary, test output, constraints. */
  context: z.string().trim().max(8_000).optional(),
  risk: z.enum(OPTION_RISKS).optional(),
  /** Chat session for `kind: "reply"`; omitted means newest active session. */
  sessionId: ticketIdSchema.optional(),
  /** A real fork the agent cannot resolve; hub may pick one instead of asking. */
  options: z.array(ticketOptionSchema).min(2).max(6).optional(),
  recommendedOption: z.string().trim().min(1).max(8).optional(),
  doneSummary: z.string().trim().max(2_000).optional(),
  nextStepPlan: z.string().trim().max(2_000).optional(),
});

export const decisionResponseSchema = z.object({
  verdict: z.enum(DECISION_VERDICTS),
  reason: z.string().max(2_000),
  /** Present when the hub approved a submission with a real fork. */
  selectedOption: z.string().max(8).optional(),
  /**
   * Present when `verdict` is `PENDING` (waiting for a human), and for an
   * approved non-reply step (the AUTO_RESOLVED audit record).
   */
  ticket: decisionTicketSchema.optional(),
  /** Present when an approved reply was queued for the agent. */
  session: chatSessionSchema.optional(),
  message: chatMessageSchema.optional(),
});

export const completeChatMessageSchema = z.object({
  status: z.enum(['DONE', 'FAILED']),
  content: z.string().max(20_000).optional(),
  externalId: z.string().max(128).optional(),
  error: z.string().max(2_000).optional(),
});

export const appendChatEventSchema = z.object({
  stream: taskLogStreamSchema,
  chunk: z.string().min(1).max(16_384),
});

export const listChatSessionsQuerySchema = z.object({
  env: envSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const nextChatMessageQuerySchema = z.object({
  env: envSchema,
  timeout: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_TIMEOUT_MS)
    .default(DEFAULT_WAIT_TIMEOUT_MS),
});

export const listChatEventsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  messageId: ticketIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const chatSessionResponseSchema = z.object({
  session: chatSessionSchema,
  messages: z.array(chatMessageSchema).optional(),
});

export const chatSessionListResponseSchema = z.object({
  sessions: z.array(chatSessionSchema),
});

export const chatMessageResponseSchema = z.object({
  session: chatSessionSchema,
  message: chatMessageSchema,
  assistant: chatMessageSchema.optional(),
});

export const chatEventListResponseSchema = z.object({
  events: z.array(chatEventSchema),
  nextAfter: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const nextChatMessageResponseSchema = z.object({
  session: chatSessionSchema.nullable(),
  message: chatMessageSchema.nullable(),
  timedOut: z.boolean(),
});

/* ------------------------------------------------------------------ */
/* Conversation exchanges mirrored from the IDE                       */
/* ------------------------------------------------------------------ */

/**
 * One turn of an IDE conversation: the question the human asked and the
 * conclusion the agent reported. Interactive MCP sessions do not stream
 * their transcript, so agents push this summary instead.
 */
export const exchangeSchema = z.object({
  id: ticketIdSchema,
  env: envSchema,
  projectName: projectNameSchema.optional(),
  question: z.string().max(4_000).optional(),
  conclusion: z.string().max(20_000).optional(),
  createdAt: z.number().int().nonnegative(),
});

export const reportExchangeSchema = z
  .object({
    env: envSchema,
    question: z.string().trim().min(1).max(4_000).optional(),
    conclusion: z.string().trim().min(1).max(20_000).optional(),
    projectName: projectNameSchema.optional(),
  })
  .refine((value) => Boolean(value.question ?? value.conclusion), {
    message: 'question 与 conclusion 至少填写一项',
  });

export const listExchangesQuerySchema = z.object({
  env: envSchema.optional(),
  projectName: projectNameSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const exchangeResponseSchema = z.object({
  exchange: exchangeSchema,
});

export const exchangeListResponseSchema = z.object({
  exchanges: z.array(exchangeSchema),
});

/* ------------------------------------------------------------------ */
/* Workspace ↔ project bindings                                       */
/* ------------------------------------------------------------------ */

/**
 * A project explicitly (or automatically) bound to an env. The dashboard
 * uses these bindings to populate the project dropdown when dispatching
 * tasks, so the human never has to retype a project name.
 */
export const workspaceProjectSchema = z.object({
  id: ticketIdSchema,
  env: envSchema,
  projectName: projectNameSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const bindWorkspaceProjectSchema = z.object({
  env: envSchema,
  projectName: projectNameSchema,
});

export const listWorkspaceProjectsQuerySchema = z.object({
  env: envSchema.optional(),
});

/* ------------------------------------------------------------------ */
/* Bridge self-update                                                  */
/* ------------------------------------------------------------------ */

/**
 * A published standalone bridge release. `latest.json` on the hub follows this
 * shape; the CLI validates it before downloading anything.
 */
export const bridgeReleaseFileSchema = z.object({
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'sha256 must be a lowercase hex digest'),
  size: z.number().int().nonnegative(),
});

export const bridgeReleaseManifestSchema = z.object({
  version: z.string().trim().min(1).max(64),
  releasedAt: z.number().int().nonnegative(),
  notes: z.string().max(2000).optional(),
  /** File name -> integrity metadata. The bridge ships mcp.mjs and cli.mjs. */
  files: z.record(z.string().min(1), bridgeReleaseFileSchema),
  /** Absolute download base. The server fills it in when omitted. */
  baseUrl: z.string().trim().min(1).optional(),
});

export type BridgeReleaseFile = z.infer<typeof bridgeReleaseFileSchema>;
export type BridgeReleaseManifest = z.infer<typeof bridgeReleaseManifestSchema>;

/* ------------------------------------------------------------------ */
/* API envelopes                                                       */
/* ------------------------------------------------------------------ */

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export const ticketResponseSchema = z.object({ ticket: decisionTicketSchema });

export const ticketListResponseSchema = z.object({
  tickets: z.array(decisionTicketSchema),
  total: z.number().int().nonnegative(),
});

export const waitResponseSchema = z.object({
  resolved: z.boolean(),
  timedOut: z.boolean(),
  ticket: decisionTicketSchema,
});

export const heartbeatResponseSchema = z.object({
  heartbeat: envHeartbeatSchema,
});

export const envListResponseSchema = z.object({
  envs: z.array(envHeartbeatSchema),
});

export const agentResponseSchema = z.object({ agent: agentSchema });

export const agentListResponseSchema = z.object({
  agents: z.array(agentSchema),
});

/** Issued once: the plaintext token is never stored or returned again. */
export const agentTokenResponseSchema = z.object({
  agent: agentSchema,
  token: z.string().min(1),
});

export const taskResponseSchema = z.object({ task: agentTaskSchema });

export const taskListResponseSchema = z.object({
  tasks: z.array(agentTaskSchema),
  total: z.number().int().nonnegative(),
});

export const nextTaskResponseSchema = z.object({
  task: agentTaskSchema.nullable(),
  timedOut: z.boolean(),
});

/** Query accepted by GET /api/resume (bridge restart recovery). */
export const resumeQuerySchema = z.object({
  env: envSchema,
  /** Only include terminal tickets updated after this timestamp. */
  since: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const resumeResponseSchema = z.object({
  tickets: z.array(decisionTicketSchema),
  tasks: z.array(agentTaskSchema),
});

/** Response for POST /api/tickets/batch-resolve. */
export const batchResolveResponseSchema = z.object({
  tickets: z.array(decisionTicketSchema),
  skipped: z.array(
    z.object({
      id: ticketIdSchema,
      reason: z.string(),
    }),
  ),
});

export const workspaceProjectResponseSchema = z.object({
  project: workspaceProjectSchema,
});

export const workspaceProjectListResponseSchema = z.object({
  projects: z.array(workspaceProjectSchema),
  total: z.number().int().nonnegative(),
});

/* ------------------------------------------------------------------ */
/* Dashboard sync long-poll                                            */
/* ------------------------------------------------------------------ */

/**
 * Query accepted by GET /api/sync.
 *
 * `after` is the revision the client already has; the request is held open
 * until the server revision moves past it (or the timeout elapses), so an
 * idle dashboard costs one request per timeout instead of a fixed poll rate.
 */
export const syncQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  timeout: z.coerce.number().int().min(0).max(55_000).default(25_000),
});

/** Everything the dashboard needs for one render, in a single response. */
export const syncStateSchema = z.object({
  envs: z.array(envHeartbeatSchema),
  tickets: z.array(decisionTicketSchema),
  tasks: z.array(agentTaskSchema),
  projects: z.array(workspaceProjectSchema),
  agents: z.array(agentSchema),
  exchanges: z.array(exchangeSchema),
});

export const syncResponseSchema = z.object({
  /** Monotonic revision; echo it back as `after` on the next request. */
  rev: z.number().int().nonnegative(),
  /** False on a clean timeout: the client's state is already current. */
  changed: z.boolean(),
  /** Present only when `changed` is true. */
  state: syncStateSchema.optional(),
});

export const rulesResponseSchema = z.object({
  content: z.string(),
  updatedAt: z.number().int().nonnegative(),
});

export const updateRulesSchema = z.object({
  content: z.string().min(1).max(100_000),
});

/* ------------------------------------------------------------------ */
/* Rule candidates distilled from human approvals                      */
/* ------------------------------------------------------------------ */

export const ruleCandidateStatusSchema = z.enum(RULE_CANDIDATE_STATUSES);

export const ruleCandidateSchema = z.object({
  id: ticketIdSchema,
  ticketId: ticketIdSchema,
  content: z.string().trim().min(1).max(1000),
  status: ruleCandidateStatusSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const listRuleCandidatesQuerySchema = z.object({
  status: ruleCandidateStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ruleCandidateListResponseSchema = z.object({
  candidates: z.array(ruleCandidateSchema),
  total: z.number().int().nonnegative(),
});

export const ruleCandidateActionResponseSchema = z.object({
  candidate: ruleCandidateSchema,
  rules: z
    .object({
      content: z.string(),
      updatedAt: z.number().int().nonnegative(),
    })
    .optional(),
});

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  now: z.number().int().nonnegative(),
});

/** Short-lived capability used by the browser to open a WebSocket. */
export const realtimeTicketResponseSchema = z.object({
  ticket: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
});

/* ------------------------------------------------------------------ */
/* Inferred types                                                      */
/* ------------------------------------------------------------------ */

export type DecisionTicket = z.infer<typeof decisionTicketSchema>;
export type TicketOption = z.infer<typeof ticketOptionSchema>;
export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type ResolveTicketInput = z.infer<typeof resolveTicketSchema>;
export type ExtendTicketInput = z.infer<typeof extendTicketSchema>;
export type BatchResolveTicketsInput = z.infer<
  typeof batchResolveTicketsSchema
>;
export type BatchResolveResponse = z.infer<
  typeof batchResolveResponseSchema
>;
export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;
export type WaitQuery = z.infer<typeof waitQuerySchema>;
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;
export type EnvHeartbeat = z.infer<typeof envHeartbeatSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type AgentMeta = z.infer<typeof agentMetaSchema>;
export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;
export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
export type AgentListResponse = z.infer<typeof agentListResponseSchema>;
export type AgentResponse = z.infer<typeof agentResponseSchema>;
export type AgentTokenResponse = z.infer<typeof agentTokenResponseSchema>;
export type CreateEnrollmentInput = z.infer<typeof createEnrollmentSchema>;
export type RedeemEnrollmentInput = z.infer<typeof redeemEnrollmentSchema>;
export type Enrollment = z.infer<typeof enrollmentSchema>;
export type EnrollmentResponse = z.infer<typeof enrollmentResponseSchema>;
export type EnrollResponse = z.infer<typeof enrollResponseSchema>;
export type TicketResponse = z.infer<typeof ticketResponseSchema>;
export type TicketListResponse = z.infer<typeof ticketListResponseSchema>;
export type WaitResponse = z.infer<typeof waitResponseSchema>;

export type AgentTask = z.infer<typeof agentTaskSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type NextTaskQuery = z.infer<typeof nextTaskQuerySchema>;
export type CompleteTaskInput = z.infer<typeof completeTaskSchema>;
export type ReleaseTaskInput = z.infer<typeof releaseTaskSchema>;
export type TaskLog = z.infer<typeof taskLogSchema>;
export type AppendTaskLogInput = z.infer<typeof appendTaskLogSchema>;
export type ListTaskLogsQuery = z.infer<typeof listTaskLogsQuerySchema>;
export type TaskLogListResponse = z.infer<typeof taskLogListResponseSchema>;

export type ChatSession = z.infer<typeof chatSessionSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatEvent = z.infer<typeof chatEventSchema>;
export type CreateChatSessionInput = z.infer<typeof createChatSessionSchema>;
export type SendChatMessageInput = z.infer<typeof sendChatMessageSchema>;
export type ProposeChatReplyInput = z.infer<typeof proposeChatReplySchema>;
export type AdoptChatProposalInput = z.infer<typeof adoptChatProposalSchema>;
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
export type DecisionResponse = z.infer<typeof decisionResponseSchema>;
export type CompleteChatMessageInput = z.infer<
  typeof completeChatMessageSchema
>;
export type AppendChatEventInput = z.infer<typeof appendChatEventSchema>;
export type ListChatSessionsQuery = z.infer<typeof listChatSessionsQuerySchema>;
export type NextChatMessageQuery = z.infer<typeof nextChatMessageQuerySchema>;
export type ListChatEventsQuery = z.infer<typeof listChatEventsQuerySchema>;
export type ChatSessionResponse = z.infer<typeof chatSessionResponseSchema>;
export type ChatSessionListResponse = z.infer<
  typeof chatSessionListResponseSchema
>;
export type ChatMessageResponse = z.infer<typeof chatMessageResponseSchema>;
export type ChatEventListResponse = z.infer<typeof chatEventListResponseSchema>;
export type NextChatMessageResponse = z.infer<
  typeof nextChatMessageResponseSchema
>;

export type Exchange = z.infer<typeof exchangeSchema>;
export type ReportExchangeInput = z.infer<typeof reportExchangeSchema>;
export type ListExchangesQuery = z.infer<typeof listExchangesQuerySchema>;
export type ExchangeResponse = z.infer<typeof exchangeResponseSchema>;
export type ExchangeListResponse = z.infer<typeof exchangeListResponseSchema>;
export type TaskResponse = z.infer<typeof taskResponseSchema>;
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;
export type NextTaskResponse = z.infer<typeof nextTaskResponseSchema>;
export type ResumeQuery = z.infer<typeof resumeQuerySchema>;
export type ResumeResponse = z.infer<typeof resumeResponseSchema>;
export type WorkspaceProject = z.infer<typeof workspaceProjectSchema>;
export type BindWorkspaceProjectInput = z.infer<
  typeof bindWorkspaceProjectSchema
>;
export type ListWorkspaceProjectsQuery = z.infer<
  typeof listWorkspaceProjectsQuerySchema
>;
export type WorkspaceProjectResponse = z.infer<
  typeof workspaceProjectResponseSchema
>;
export type WorkspaceProjectListResponse = z.infer<
  typeof workspaceProjectListResponseSchema
>;
export type SyncQuery = z.infer<typeof syncQuerySchema>;
export type SyncState = z.infer<typeof syncStateSchema>;
export type SyncResponse = z.infer<typeof syncResponseSchema>;
export type RulesResponse = z.infer<typeof rulesResponseSchema>;
export type UpdateRulesInput = z.infer<typeof updateRulesSchema>;
export type RuleCandidate = z.infer<typeof ruleCandidateSchema>;
export type ListRuleCandidatesQuery = z.infer<typeof listRuleCandidatesQuerySchema>;
export type RuleCandidateListResponse = z.infer<
  typeof ruleCandidateListResponseSchema
>;
export type RuleCandidateActionResponse = z.infer<
  typeof ruleCandidateActionResponseSchema
>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type RealtimeTicketResponse = z.infer<
  typeof realtimeTicketResponseSchema
>;
