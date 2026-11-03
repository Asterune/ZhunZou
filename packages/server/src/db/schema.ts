import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import type {
  EnvStatus,
  RuleCandidateStatus,
  TaskStatus,
  TicketOption,
  TicketStatus,
} from '@zhunzou/shared';

export const tickets = sqliteTable(
  'tickets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    env: text('env').notNull(),
    projectName: text('project_name').notNull(),
    status: text('status').$type<TicketStatus>().notNull(),

    doneSummary: text('done_summary').notNull(),
    blockerQuestion: text('blocker_question').notNull(),
    nextStepPlan: text('next_step_plan').notNull(),

    options: text('options', { mode: 'json' }).$type<TicketOption[]>().notNull(),
    recommendedOption: text('recommended_option').notNull(),

    selectedOption: text('selected_option'),
    customInstruction: text('custom_instruction'),
    resolvedBy: text('resolved_by').$type<'META_AGENT' | 'HUMAN' | 'TIMEOUT'>(),
    resolutionReason: text('resolution_reason'),

    /** Auto-resolve deadline; null/undefined disables the SLA. */
    expiresAt: integer('expires_at'),

    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_tickets_status').on(table.status),
    index('idx_tickets_project').on(table.projectName),
    index('idx_tickets_created').on(table.createdAt),
  ],
);

export const envHeartbeats = sqliteTable('env_heartbeats', {
  env: text('env').primaryKey(),
  status: text('status').$type<EnvStatus>().notNull(),
  projectName: text('project_name'),
  currentTask: text('current_task'),
  note: text('note'),
  lastSeenAt: integer('last_seen_at').notNull(),
});

export const agentTasks = sqliteTable(
  'agent_tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    env: text('env').notNull(),
    projectName: text('project_name'),
    title: text('title').notNull(),
    instruction: text('instruction').notNull(),
    status: text('status').$type<TaskStatus>().notNull(),
    attempts: integer('attempts').notNull().default(0),

    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    claimedAt: integer('claimed_at'),
    completedAt: integer('completed_at'),
    result: text('result'),
  },
  (table) => [
    index('idx_agent_tasks_status').on(table.status),
    index('idx_agent_tasks_env').on(table.env),
    index('idx_agent_tasks_created').on(table.createdAt),
  ],
);

export const workspaceProjects = sqliteTable(
  'workspace_projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    env: text('env').notNull(),
    projectName: text('project_name').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_workspace_projects_env_project').on(
      table.env,
      table.projectName,
    ),
    index('idx_workspace_projects_env').on(table.env),
  ],
);

export const ruleCandidates = sqliteTable(
  'rule_candidates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ticketId: integer('ticket_id').notNull(),
    content: text('content').notNull(),
    status: text('status').$type<RuleCandidateStatus>().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_rule_candidates_status').on(table.status),
    index('idx_rule_candidates_ticket').on(table.ticketId),
    index('idx_rule_candidates_created').on(table.createdAt),
  ],
);

export type TicketRow = typeof tickets.$inferSelect;
export type RuleCandidateRow = typeof ruleCandidates.$inferSelect;
export type RuleCandidateInsert = typeof ruleCandidates.$inferInsert;
export type TicketInsert = typeof tickets.$inferInsert;
export type HeartbeatRow = typeof envHeartbeats.$inferSelect;
export type AgentTaskRow = typeof agentTasks.$inferSelect;
export type AgentTaskInsert = typeof agentTasks.$inferInsert;
export type WorkspaceProjectRow = typeof workspaceProjects.$inferSelect;
export type WorkspaceProjectInsert = typeof workspaceProjects.$inferInsert;
