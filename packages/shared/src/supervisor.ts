import { z } from 'zod';

import {
  DIAGNOSIS_SUMMARY_MAX_CHARS,
  LEARNED_RULE_ACTIONS,
  LEARNED_RULE_PATTERN_TYPES,
  LEARNED_RULE_SOURCES,
  PERMISSION_ACTION_KINDS,
  SUPERVISOR_DECISIONS,
  SUPERVISOR_LAYERS,
  TASK_ENGINES,
} from './constants.js';

/**
 * The supervisor contract: what an agent asks for, how the hub rules on it, and
 * what a human approval leaves behind as a reusable rule.
 */

/** True when a reported path is not inside the checkout the task owns. */
function escapesWorkspace(path: string, workspaceRoot: string): boolean {
  const root = workspaceRoot.replace(/[/\\]+$/, '');
  return !(path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`));
}

export const permissionActionSchema = z
  .object({
    kind: z.enum(PERMISSION_ACTION_KINDS),
    command: z.string().trim().min(1).max(2000).optional(),
    paths: z.array(z.string().trim().min(1).max(1024)).max(50).optional(),
    cwd: z.string().trim().min(1).max(1024).optional(),
    workspaceRoot: z.string().trim().min(1).max(1024).optional(),
    /**
     * The client may claim the action stays inside the workspace; the hub
     * re-derives it from the paths so a compromised node cannot talk itself in.
     */
    outsideWorkspace: z.boolean().optional(),
    engine: z.enum(TASK_ENGINES).optional(),
    requestedAt: z.number().int().nonnegative().optional(),
  })
  .superRefine((action, ctx) => {
    if (!action.command && !(action.paths?.length ?? 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a permission request must carry a command or at least one path',
      });
    }
  })
  .transform((action) => {
    const escapes =
      Boolean(action.workspaceRoot) &&
      (action.paths ?? []).some((path) => escapesWorkspace(path, action.workspaceRoot!));
    // The reported flag can only ever tighten the verdict: paths that leave the
    // checkout are outside it even when the node insists otherwise.
    return { ...action, outsideWorkspace: action.outsideWorkspace || escapes };
  });

export type PermissionAction = z.infer<typeof permissionActionSchema>;
/** What a node may report: the verdict field is the hub's to fill in. */
export type PermissionActionInput = z.input<typeof permissionActionSchema>;

/** The strict JSON the L2 diagnosis prompt demands back. */
export const supervisorDiagnosisSchema = z
  .object({
    // The gray zone never auto-refuses, so DENY is not on offer here.
    decision: z.enum(['APPROVE', 'RETRY_WITH_FIX', 'ESCALATE_TO_HUMAN']),
    diagnosisSummary: z.string().trim().min(1).max(DIAGNOSIS_SUMMARY_MAX_CHARS),
    fixPrompt: z.string().trim().min(1).max(4000).optional(),
    /** Normalised error text, so two identical failures can be recognised. */
    errorSignature: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((value) => value.decision !== 'RETRY_WITH_FIX' || Boolean(value.fixPrompt), {
    message: 'a retry decision needs a fix prompt to hand the engine',
    path: ['fixPrompt'],
  });

export type SupervisorDiagnosis = z.infer<typeof supervisorDiagnosisSchema>;

/** What the supervisor finally records, whichever layer produced it. */
export const supervisorDecisionSchema = z
  .object({
    decision: z.enum(SUPERVISOR_DECISIONS),
    layer: z.enum(SUPERVISOR_LAYERS),
    reason: z.string().trim().min(1).max(500),
    /** Set when a learned rule answered, for hit counting and audit. */
    ruleId: z.string().trim().min(1).max(64).optional(),
    diagnosisSummary: z.string().trim().min(1).max(500).optional(),
    fixPrompt: z.string().trim().min(1).max(4000).optional(),
    decidedAt: z.number().int().nonnegative().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.layer === 'L1' && value.fixPrompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'the deterministic layer cannot carry a fix prompt',
        path: ['fixPrompt'],
      });
    }
    if (value.decision === 'RETRY_WITH_FIX' && !value.fixPrompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a retry decision needs a fix prompt to hand the engine',
        path: ['fixPrompt'],
      });
    }
  });

export type SupervisorDecision = z.infer<typeof supervisorDecisionSchema>;

/** A command pattern a human already approved (or refused) and that may answer again. */
export const learnedRuleSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    pattern: z.string().min(1).max(500),
    patternType: z.enum(LEARNED_RULE_PATTERN_TYPES),
    action: z.enum(LEARNED_RULE_ACTIONS),
    /** Narrow to one action kind; unset matches any kind. */
    kind: z.enum(PERMISSION_ACTION_KINDS).optional(),
    source: z.enum(LEARNED_RULE_SOURCES),
    enabled: z.boolean().default(true),
    hits: z.number().int().nonnegative().default(0),
    note: z.string().trim().max(500).optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .superRefine((rule, ctx) => {
    if (rule.patternType !== 'regex') return;
    try {
      new RegExp(rule.pattern);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'regex pattern does not compile',
        path: ['pattern'],
      });
    }
  });

export type LearnedRule = z.infer<typeof learnedRuleSchema>;

/**
 * Payload for granting an allowance: the caller only names the pattern; the
 * hub fills in the defaults (`glob` / `ALLOW` / `HUMAN_APPROVAL`).
 */
export const createLearnedRuleSchema = z
  .object({
    pattern: z.string().trim().min(1).max(500),
    patternType: z.enum(LEARNED_RULE_PATTERN_TYPES).default('glob'),
    action: z.enum(LEARNED_RULE_ACTIONS).default('ALLOW'),
    kind: z.enum(PERMISSION_ACTION_KINDS).optional(),
    source: z.enum(LEARNED_RULE_SOURCES).default('HUMAN_APPROVAL'),
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((rule, ctx) => {
    if (rule.patternType !== 'regex') return;
    try {
      new RegExp(rule.pattern);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'regex pattern does not compile',
        path: ['pattern'],
      });
    }
  });

export type CreateLearnedRuleInput = z.input<typeof createLearnedRuleSchema>;

/**
 * Payload accepted by PATCH /api/learned-rules/:id.
 *
 * Only the switch is movable: an allowance that turns out to be wrong has to
 * be revocable in one call, and the history of what it decided stays put.
 */
export const updateLearnedRuleSchema = z.object({
  enabled: z.boolean(),
});

export type UpdateLearnedRuleInput = z.infer<typeof updateLearnedRuleSchema>;

/** Query accepted by GET /api/learned-rules. */
export const listLearnedRulesQuerySchema = z.object({
  // `z.coerce.boolean()` reads the string "false" as true, which is the one
  // answer a caller must never get by accident.
  enabledOnly: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((value) => value === 'true' || value === '1'),
  action: z.enum(LEARNED_RULE_ACTIONS).optional(),
});

export type ListLearnedRulesQuery = z.infer<typeof listLearnedRulesQuerySchema>;
