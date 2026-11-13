import { z } from 'zod';

import { AGENT_KINDS, ENGINE_EVENT_KINDS } from './constants.js';
import { ticketIdSchema } from './schemas.js';
import { permissionActionSchema } from './supervisor.js';

/**
 * Normalised engine events.
 *
 * The bridge reads a local CLI's structured output stream and turns it into
 * these three facts; the hub stores them beside the task so a parked run can
 * be resumed and an audited later. Raw output keeps flowing to `task_logs`
 * untouched — an unrecognised line costs one event, never any bytes.
 */

/**
 * An engine-native session id doubles as a command-line argument, so it is
 * restricted to a charset that cannot smuggle in an option. Ids an engine
 * reports outside this shape are simply not turned into events.
 */
export const engineSessionIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{1,128}$/, 'sessionId must be argv-safe')
  .refine((value) => !value.startsWith('-'), {
    message: 'sessionId must not start with a dash',
  });

/** True when an engine-reported id can safely become a child-process argument. */
export function isArgvSafeSessionId(value: unknown): value is string {
  return engineSessionIdSchema.safeParse(value).success;
}

export const engineEventSchema = z
  .object({
    kind: z.enum(ENGINE_EVENT_KINDS),
    /** Which client produced it; decides the resume arguments, not the event. */
    engine: z.enum(AGENT_KINDS).optional(),
    tool: z.string().trim().min(1).max(120).optional(),
    sessionId: engineSessionIdSchema.optional(),
    /** What the engine wants approved. Absent when it only names a tool. */
    action: permissionActionSchema.optional(),
  })
  .superRefine((event, ctx) => {
    if (event.kind === 'session' && !event.sessionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sessionId'],
        message: 'a session event must carry the engine session id',
      });
    }
    if (event.kind === 'tool_call' && !event.tool) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tool'],
        message: 'a tool call event must name the tool',
      });
    }
    if (
      event.kind === 'permission_required' &&
      !event.action &&
      !event.tool
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tool'],
        message: 'a permission request needs an action or at least a tool name',
      });
    }
  });

/** What the hub stores and returns: the verdict fields are filled in. */
export type EngineEvent = z.infer<typeof engineEventSchema>;

/**
 * What a node reports. `z.input` on purpose: the bridge names the tool and the
 * paths, and never asserts the containment verdict — `outsideWorkspace` is the
 * hub's to derive, so the field is optional on the way in.
 */
export type EngineEventInput = z.input<typeof engineEventSchema>;

/** Payload accepted by POST /api/tasks/:id/events; one flush per batch. */
export const reportTaskEventsSchema = z.object({
  events: z.array(engineEventSchema).min(1).max(50),
});

export type ReportTaskEventsInput = z.infer<typeof reportTaskEventsSchema>;

export const taskEventSchema = z.object({
  id: z.number().int().positive(),
  taskId: ticketIdSchema,
  kind: z.enum(ENGINE_EVENT_KINDS),
  engine: z.enum(AGENT_KINDS).optional(),
  tool: z.string().trim().min(1).max(120).optional(),
  sessionId: engineSessionIdSchema.optional(),
  action: permissionActionSchema.optional(),
  createdAt: z.number().int().nonnegative(),
});

export type TaskEvent = z.infer<typeof taskEventSchema>;

/** Query accepted by GET /api/tasks/:id/events. */
export const listTaskEventsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export type ListTaskEventsQuery = z.infer<typeof listTaskEventsQuerySchema>;

export const taskEventListResponseSchema = z.object({
  events: z.array(taskEventSchema),
  nextAfter: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export type TaskEventListResponse = z.infer<typeof taskEventListResponseSchema>;
