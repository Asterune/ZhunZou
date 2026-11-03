import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

const DDL = `
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  env TEXT NOT NULL,
  project_name TEXT NOT NULL,
  status TEXT NOT NULL,
  done_summary TEXT NOT NULL,
  blocker_question TEXT NOT NULL,
  next_step_plan TEXT NOT NULL,
  options TEXT NOT NULL,
  recommended_option TEXT NOT NULL,
  selected_option TEXT,
  custom_instruction TEXT,
  resolved_by TEXT,
  resolution_reason TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_name);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at);

CREATE TABLE IF NOT EXISTS env_heartbeats (
  env TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  project_name TEXT,
  current_task TEXT,
  note TEXT,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  env TEXT NOT NULL,
  project_name TEXT,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claimed_at INTEGER,
  completed_at INTEGER,
  result TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_env ON agent_tasks(env);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_created ON agent_tasks(created_at);

CREATE TABLE IF NOT EXISTS workspace_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  env TEXT NOT NULL,
  project_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (env, project_name)
);

CREATE INDEX IF NOT EXISTS idx_workspace_projects_env ON workspace_projects(env);

CREATE TABLE IF NOT EXISTS rule_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rule_candidates_status ON rule_candidates(status);
CREATE INDEX IF NOT EXISTS idx_rule_candidates_ticket ON rule_candidates(ticket_id);
CREATE INDEX IF NOT EXISTS idx_rule_candidates_created ON rule_candidates(created_at);
`;

export type SqliteDatabase = InstanceType<typeof Database>;
export type DrizzleDatabase = BetterSQLite3Database<typeof schema>;

/**
 * `CREATE TABLE IF NOT EXISTS` does not add columns to existing deployments.
 * Keep tiny, idempotent migrations here instead of pulling in a migration tool.
 */
function ensureColumn(
  sqlite: SqliteDatabase,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;

  if (!columns.some((item) => item.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function createDatabase(dbPath: string): {
  sqlite: SqliteDatabase;
  db: DrizzleDatabase;
} {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.exec(DDL);

  ensureColumn(sqlite, 'tickets', 'expires_at', 'INTEGER');
  ensureColumn(sqlite, 'agent_tasks', 'attempts', 'INTEGER NOT NULL DEFAULT 0');

  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}
