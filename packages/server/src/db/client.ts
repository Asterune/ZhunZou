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
CREATE INDEX IF NOT EXISTS idx_tickets_updated ON tickets(updated_at);

CREATE TABLE IF NOT EXISTS env_heartbeats (
  env TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  project_name TEXT,
  current_task TEXT,
  note TEXT,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_env_heartbeats_seen ON env_heartbeats(last_seen_at);

CREATE TABLE IF NOT EXISTS agents (
  env TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  version TEXT,
  host TEXT,
  os TEXT,
  protocol_version INTEGER,
  capabilities TEXT,
  device_stats TEXT,
  transport TEXT,
  connected_at INTEGER,
  terminal_enabled INTEGER NOT NULL DEFAULT 1,
  token_hash TEXT,
  token_prefix TEXT,
  token_created_at INTEGER,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_token_hash ON agents(token_hash);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_kind ON agents(kind);
CREATE INDEX IF NOT EXISTS idx_agents_updated ON agents(updated_at);

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
  result TEXT,
  lease_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_env ON agent_tasks(env);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_created ON agent_tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_updated ON agent_tasks(updated_at);

CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  stream TEXT NOT NULL,
  chunk TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id, id);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  env TEXT NOT NULL,
  project_name TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_message_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_env ON chat_sessions(env);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_status ON chat_sessions(status);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_status ON chat_messages(status);
CREATE INDEX IF NOT EXISTS idx_chat_messages_updated ON chat_messages(updated_at);

CREATE TABLE IF NOT EXISTS chat_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  stream TEXT NOT NULL,
  chunk TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_events_session ON chat_events(session_id, id);

CREATE TABLE IF NOT EXISTS terminal_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  env TEXT NOT NULL,
  project_name TEXT,
  title TEXT NOT NULL,
  shell TEXT,
  cwd TEXT,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  closed_at INTEGER,
  exit_code INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_terminal_sessions_env ON terminal_sessions(env);
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_status ON terminal_sessions(status);
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_updated ON terminal_sessions(updated_at);

CREATE TABLE IF NOT EXISTS terminal_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  env TEXT NOT NULL,
  kind TEXT NOT NULL,
  viewer_id TEXT,
  data TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_terminal_audit_session ON terminal_audit(session_id, id);
CREATE INDEX IF NOT EXISTS idx_terminal_audit_env ON terminal_audit(env);
CREATE INDEX IF NOT EXISTS idx_terminal_audit_created ON terminal_audit(created_at);

CREATE TABLE IF NOT EXISTS exchanges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  env TEXT NOT NULL,
  project_name TEXT,
  question TEXT,
  conclusion TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exchanges_env ON exchanges(env, id);
CREATE INDEX IF NOT EXISTS idx_exchanges_project ON exchanges(project_name, id);
CREATE INDEX IF NOT EXISTS idx_exchanges_created ON exchanges(created_at);

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
  ensureColumn(sqlite, 'agent_tasks', 'lease_at', 'INTEGER');
  ensureColumn(sqlite, 'agents', 'protocol_version', 'INTEGER');
  ensureColumn(sqlite, 'agents', 'capabilities', 'TEXT');
  ensureColumn(sqlite, 'agents', 'device_stats', 'TEXT');
  ensureColumn(sqlite, 'agents', 'transport', 'TEXT');
  ensureColumn(sqlite, 'agents', 'connected_at', 'INTEGER');
  ensureColumn(
    sqlite,
    'agents',
    'terminal_enabled',
    'INTEGER NOT NULL DEFAULT 1',
  );

  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}
