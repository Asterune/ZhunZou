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
  task_id INTEGER,
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

CREATE TABLE IF NOT EXISTS env_runners (
  env TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  env TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  version TEXT,
  host TEXT,
  os TEXT,
  device_id TEXT,
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

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  machine_id TEXT,
  host TEXT,
  os TEXT,
  capabilities TEXT,
  device_stats TEXT,
  role TEXT,
  tags TEXT,
  max_concurrency INTEGER,
  free_memory_mb INTEGER,
  repos TEXT,
  transport TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_machine_id ON devices(machine_id);
CREATE INDEX IF NOT EXISTS idx_devices_host ON devices(host);
CREATE INDEX IF NOT EXISTS idx_devices_seen ON devices(last_seen_at);

CREATE TABLE IF NOT EXISTS learned_rules (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  pattern_type TEXT NOT NULL,
  action TEXT NOT NULL,
  kind TEXT,
  source TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  hits INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_learned_rules_pattern ON learned_rules(pattern, action);
CREATE INDEX IF NOT EXISTS idx_learned_rules_enabled ON learned_rules(enabled);

CREATE TABLE IF NOT EXISTS enrollment_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL,
  code_prefix TEXT NOT NULL,
  env TEXT,
  label TEXT,
  project_name TEXT,
  kind TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_env TEXT,
  used_host TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1,
  use_count INTEGER NOT NULL DEFAULT 0,
  used_envs TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollment_code_hash ON enrollment_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_enrollment_expires ON enrollment_codes(expires_at);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  env TEXT NOT NULL,
  project_name TEXT,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  repo_name TEXT,
  engine TEXT,
  origin TEXT NOT NULL DEFAULT 'HUB_DISPATCH',
  session_id TEXT,
  managed_by_supervisor INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  workspace_path TEXT,
  fix_prompt TEXT,
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
  error_signature TEXT,
  diagnosis TEXT,
  diff_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id, id);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  engine TEXT,
  tool TEXT,
  session_id TEXT,
  action TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);

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
  origin TEXT NOT NULL DEFAULT 'human',
  rationale TEXT,
  decision TEXT,
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

CREATE TABLE IF NOT EXISTS fleet_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  path TEXT NOT NULL,
  project_name TEXT NOT NULL,
  env TEXT NOT NULL,
  adapter TEXT,
  associated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (host, path)
);

CREATE INDEX IF NOT EXISTS idx_fleet_candidates_host ON fleet_candidates(host);

CREATE TABLE IF NOT EXISTS fleet_workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  env TEXT NOT NULL,
  path TEXT NOT NULL,
  project_name TEXT NOT NULL,
  adapter TEXT,
  status TEXT NOT NULL,
  error TEXT,
  token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (host, path),
  UNIQUE (env)
);

CREATE INDEX IF NOT EXISTS idx_fleet_workspaces_host ON fleet_workspaces(host);
CREATE INDEX IF NOT EXISTS idx_fleet_workspaces_status ON fleet_workspaces(status);

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
  ensureColumn(sqlite, 'tickets', 'task_id', 'INTEGER');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_tickets_task ON tickets(task_id);');
  ensureColumn(sqlite, 'agent_tasks', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(sqlite, 'agent_tasks', 'lease_at', 'INTEGER');
  // Supervisor fields: a pre-Phase-1 hub has no routing, origin or retry
  // history, so every existing row is a console dispatch that never healed.
  ensureColumn(sqlite, 'agent_tasks', 'repo_name', 'TEXT');
  ensureColumn(sqlite, 'agent_tasks', 'engine', 'TEXT');
  ensureColumn(sqlite, 'agent_tasks', 'origin', "TEXT NOT NULL DEFAULT 'HUB_DISPATCH'");
  ensureColumn(sqlite, 'agent_tasks', 'session_id', 'TEXT');
  ensureColumn(sqlite, 'agent_tasks', 'managed_by_supervisor', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(sqlite, 'agent_tasks', 'retry_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(sqlite, 'agent_tasks', 'workspace_path', 'TEXT');
  // The L2 fix prompt waits here until the claim that runs the retry takes it.
  ensureColumn(sqlite, 'agent_tasks', 'fix_prompt', 'TEXT');
  // Indexed only after the column exists: an upgrade from a table that predates
  // it would otherwise abort on the missing column.
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_agent_tasks_repo ON agent_tasks(repo_name);');
  // Node placement profile: an upgraded hub has cards but no routing facts, so
  // its existing nodes read back as plain workers until they report again.
  ensureColumn(sqlite, 'devices', 'role', 'TEXT');
  ensureColumn(sqlite, 'devices', 'tags', 'TEXT');
  ensureColumn(sqlite, 'devices', 'max_concurrency', 'INTEGER');
  ensureColumn(sqlite, 'devices', 'free_memory_mb', 'INTEGER');
  ensureColumn(sqlite, 'devices', 'repos', 'TEXT');
  // Diagnostic columns turn a log row into evidence the circuit breaker can compare.
  ensureColumn(sqlite, 'task_logs', 'error_signature', 'TEXT');
  ensureColumn(sqlite, 'task_logs', 'diagnosis', 'TEXT');
  ensureColumn(sqlite, 'task_logs', 'diff_hash', 'TEXT');
  ensureColumn(sqlite, 'agents', 'protocol_version', 'INTEGER');
  ensureColumn(sqlite, 'agents', 'capabilities', 'TEXT');
  ensureColumn(sqlite, 'agents', 'device_stats', 'TEXT');
  ensureColumn(sqlite, 'agents', 'transport', 'TEXT');
  ensureColumn(sqlite, 'agents', 'connected_at', 'INTEGER');
  ensureColumn(sqlite, 'agents', 'terminal_enabled', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(sqlite, 'agents', 'device_id', 'TEXT');
  // Created after the column: the DDL above runs against deployments that
  // still have the pre-device `agents` table, where the column does not exist
  // yet, and an index on a missing column aborts the whole upgrade.
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_agents_device ON agents(device_id);');
  // Devices are a new entity, so the machines already reported through
  // agents.host need their cards backfilled — otherwise every upgraded hub
  // starts empty and the existing nodes look like they vanished. The synthetic
  // `host:<hostname>` key is what a client that never reported a fingerprint
  // resolves to, so both sides agree without another round trip. Hostnames are
  // normalized the same way env-allocator does (lowercase, no `.local`), or a
  // macOS box ends up with one card per suffix variant.
  const normalizedHost = `CASE WHEN lower(trim(host)) LIKE '%.local'
    THEN substr(lower(trim(host)), 1, length(lower(trim(host))) - 6)
    ELSE lower(trim(host)) END`;
  sqlite.exec(`
    INSERT OR IGNORE INTO devices (id, host, os, last_seen_at, created_at, updated_at)
    SELECT 'host:' || ${normalizedHost},
           ${normalizedHost},
           MAX(os),
           MAX(COALESCE(last_seen_at, created_at)),
           MIN(created_at),
           MAX(updated_at)
      FROM agents
     WHERE host IS NOT NULL AND trim(host) <> ''
     GROUP BY ${normalizedHost};

    UPDATE agents
       SET device_id = 'host:' || ${normalizedHost}
     WHERE device_id IS NULL AND host IS NOT NULL AND trim(host) <> '';

    -- Cards minted before normalization keyed the raw suffix; fold them into
    -- the normalized key so one machine keeps exactly one card.
    INSERT OR IGNORE INTO devices (id, machine_id, host, os, capabilities, device_stats, transport, last_seen_at, created_at, updated_at)
    SELECT substr(id, 1, length(id) - 6),
           machine_id, host, os, capabilities, device_stats, transport,
           last_seen_at, created_at, updated_at
      FROM devices
     WHERE id LIKE 'host:%.local';

    UPDATE agents
       SET device_id = substr(device_id, 1, length(device_id) - 6)
     WHERE device_id LIKE 'host:%.local';

    DELETE FROM devices WHERE id LIKE 'host:%.local';
  `);
  ensureColumn(sqlite, 'chat_messages', 'origin', "TEXT NOT NULL DEFAULT 'human'");
  ensureColumn(sqlite, 'chat_messages', 'rationale', 'TEXT');
  ensureColumn(sqlite, 'chat_messages', 'decision', 'TEXT');
  // One code may enroll several clients on the same machine (Cursor,
  // OpenCode, Claude Code, Codex) instead of forcing one code per client.
  ensureColumn(sqlite, 'enrollment_codes', 'max_uses', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(sqlite, 'enrollment_codes', 'use_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(sqlite, 'enrollment_codes', 'used_envs', 'TEXT');
  // Codes created before multi-client enrollment were single-use; without this
  // backfill they would look unused (use_count = 0) and could be replayed.
  sqlite.exec(`
    UPDATE enrollment_codes
       SET use_count = 1
     WHERE used_at IS NOT NULL AND use_count = 0;
    UPDATE enrollment_codes
       SET used_envs = '["' || used_env || '"]'
     WHERE used_env IS NOT NULL AND used_envs IS NULL;
  `);

  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}
