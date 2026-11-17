#!/usr/bin/env node
/**
 * Merge the spellings of one project into the spelling the hub already uses.
 *
 * Heartbeats, tickets and sessions all store a project as free text, so one
 * checkout can be recorded as `FitAI-`, `FitAI` and `fitai`. The running
 * server now resolves new writes through `projectKey`, but rows written
 * before that keep splitting the dashboard. This script rewrites those rows
 * and drops duplicate bindings.
 *
 * Matching mirrors `packages/shared/src/projects.ts` (case, inner whitespace
 * and trailing `-_.` are ignored). The canonical spelling is the one with the
 * most references, so a single typo never renames a project.
 *
 * Usage (from packages/server, where better-sqlite3 is installed):
 *   node scripts/merge-duplicate-projects.mjs --db ../../data/zhunzou.db
 *   node scripts/merge-duplicate-projects.mjs --db <path> --sql merge.sql
 *   node scripts/merge-duplicate-projects.mjs --db <path> --apply
 *
 * Without `--apply` nothing is written: the script prints the plan. `--apply`
 * writes a JSON backup of every affected table next to the database first.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

/** Column-bearing tables, in the order their labels should win. */
const TABLES = [
  'tickets',
  'agent_tasks',
  'chat_sessions',
  'env_heartbeats',
  'exchanges',
  'terminal_sessions',
  'enrollment_codes',
];

function projectKey(name) {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[\s._-]+$/, '');
}

function display(name) {
  return name.trim().replace(/\s+/g, ' ');
}

function parseArgs(argv) {
  const args = { db: '', apply: false, sql: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') args.db = argv[++index] ?? '';
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--sql') args.sql = argv[++index] ?? '';
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function hasProjectColumn(db, table) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  return columns.some((column) => column.name === 'project_name');
}

/** name → { total, bindings, firstSeenAt } across every table we touch. */
function collectUsage(db, tables) {
  const usage = new Map();
  const bump = (name, field, amount = 1) => {
    if (typeof name !== 'string' || !name.trim()) return;
    const key = projectKey(name);
    if (!key) return;
    const entry = usage.get(key) ?? {
      spellings: new Map(),
      total: 0,
      bindings: 0,
      references: 0,
      firstSeenAt: Number.MAX_SAFE_INTEGER,
    };
    entry.total += amount;
    if (field === 'bindings') entry.bindings += amount;
    else entry.references += amount;
    const spelling = entry.spellings.get(name) ?? {
      count: 0,
      firstSeenAt: Number.MAX_SAFE_INTEGER,
    };
    spelling.count += amount;
    entry.spellings.set(name, spelling);
    usage.set(key, entry);
  };

  for (const row of db
    .prepare(
      'SELECT project_name AS name, COUNT(*) AS n, MIN(created_at) AS first FROM workspace_projects GROUP BY project_name',
    )
    .all()) {
    bump(row.name, 'bindings', row.n);
  }

  for (const table of tables) {
    if (!hasProjectColumn(db, table)) continue;
    for (const row of db
      .prepare(
        `SELECT project_name AS name, COUNT(*) AS n FROM ${table} WHERE project_name IS NOT NULL GROUP BY project_name`,
      )
      .all()) {
      bump(row.name, 'references', row.n);
    }
  }

  // Earliest sighting per spelling, so a tie goes to the older label.
  for (const table of ['tickets', 'workspace_projects']) {
    if (!hasProjectColumn(db, table)) continue;
    for (const row of db
      .prepare(
        `SELECT project_name AS name, MIN(created_at) AS first FROM ${table} WHERE project_name IS NOT NULL GROUP BY project_name`,
      )
      .all()) {
      const key = projectKey(row.name);
      const entry = usage.get(key);
      const spelling = entry?.spellings.get(row.name);
      if (!spelling) continue;
      spelling.firstSeenAt = Math.min(spelling.firstSeenAt, row.first ?? Infinity);
      entry.firstSeenAt = Math.min(entry.firstSeenAt, row.first ?? Infinity);
    }
  }

  return usage;
}

/** key → canonical spelling. */
function chooseCanonical(usage, log) {
  const canonical = new Map();
  for (const [key, entry] of usage) {
    const candidates = [...entry.spellings.entries()].sort(
      (left, right) =>
        right[1].count - left[1].count ||
        (left[1].firstSeenAt ?? Infinity) - (right[1].firstSeenAt ?? Infinity) ||
        left[0].localeCompare(right[0]),
    );
    canonical.set(key, display(candidates[0][0]));
    if (candidates.length > 1) {
      log(
        `merge ${candidates.map(([name, stat]) => `${name}(${stat.count})`).join(' + ')} → ${display(candidates[0][0])}`,
      );
    }
  }
  return canonical;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.db) {
    console.log(
      'usage: node scripts/merge-duplicate-projects.mjs --db <sqlite path> [--sql <out.sql>] [--apply]',
    );
    process.exit(args.help ? 0 : 1);
  }

  const db = new Database(args.db);
  const log = (message) => console.log(message);
  const existingTables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  const tables = TABLES.filter(
    (table) => existingTables.has(table) && hasProjectColumn(db, table),
  );

  const usage = collectUsage(db, tables);
  const canonicalByKey = chooseCanonical(usage, log);

  /** Every distinct stored spelling that should be rewritten. */
  const renames = new Map();
  for (const table of tables) {
    for (const row of db
      .prepare(
        `SELECT DISTINCT project_name AS name FROM ${table} WHERE project_name IS NOT NULL`,
      )
      .all()) {
      const canonical = canonicalByKey.get(projectKey(row.name));
      if (!canonical || canonical === row.name) continue;
      const list = renames.get(table) ?? [];
      list.push({ from: row.name, to: canonical });
      renames.set(table, list);
    }
  }

  // Duplicate bindings: one row per (env, canonical project).
  const bindings = db
    .prepare(
      'SELECT id, env, project_name AS name, created_at AS createdAt, updated_at AS updatedAt FROM workspace_projects ORDER BY id',
    )
    .all();
  const keep = new Map();
  const dropBindings = [];
  const renameBindings = [];
  for (const row of bindings) {
    const canonical = canonicalByKey.get(projectKey(row.name)) ?? display(row.name);
    const slot = `${row.env}\u0000${projectKey(canonical)}`;
    const kept = keep.get(slot);
    if (kept) {
      dropBindings.push(row.id);
      kept.createdAt = Math.min(kept.createdAt, row.createdAt);
      kept.updatedAt = Math.max(kept.updatedAt, row.updatedAt);
      continue;
    }
    keep.set(slot, { id: row.id, canonical, createdAt: row.createdAt, updatedAt: row.updatedAt });
  }
  for (const row of keep.values()) {
    const original = bindings.find((item) => item.id === row.id);
    if (original && original.name !== row.canonical) {
      renameBindings.push({ id: row.id, to: row.canonical });
    }
  }

  const statements = [];
  for (const [table, list] of renames) {
    for (const { from, to } of list) {
      statements.push({
        sql: `UPDATE ${table} SET project_name = ? WHERE project_name = ?`,
        params: [to, from],
        label: `${table}: ${from} → ${to}`,
      });
    }
  }
  for (const id of dropBindings) {
    statements.push({
      sql: 'DELETE FROM workspace_projects WHERE id = ?',
      params: [id],
      label: `workspace_projects#${id}: duplicate binding`,
    });
  }
  for (const row of renameBindings) {
    statements.push({
      sql: 'UPDATE workspace_projects SET project_name = ?, updated_at = ? WHERE id = ?',
      params: [row.to, Date.now(), row.id],
      label: `workspace_projects#${row.id}: → ${row.to}`,
    });
  }
  // Keep the merged timestamps on the surviving binding.
  for (const row of keep.values()) {
    const original = bindings.find((item) => item.id === row.id);
    if (
      !original ||
      (original.createdAt === row.createdAt && original.updatedAt === row.updatedAt)
    ) {
      continue;
    }
    statements.push({
      sql: 'UPDATE workspace_projects SET created_at = ?, updated_at = ? WHERE id = ?',
      params: [row.createdAt, row.updatedAt, row.id],
      label: `workspace_projects#${row.id}: merged timestamps`,
    });
  }

  if (!statements.length) {
    log('nothing to merge');
    return;
  }

  if (args.sql) {
    const escape = (value) =>
      value === null ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`;
    const lines = [
      'BEGIN IMMEDIATE;',
      ...statements.map(
        (statement) => `${formatStatement(statement, escape)};`,
      ),
      'COMMIT;',
      '',
    ];
    writeFileSync(args.sql, lines.join('\n'), 'utf8');
    log(`sql written to ${args.sql}`);
  }

  log(`\n${statements.length} statement(s):`);
  for (const statement of statements) log(`  ${statement.label}`);

  if (!args.apply) {
    log('\ndry run: pass --apply to write (a JSON backup is written first)');
    return;
  }

  const backupDir = join(dirname(args.db), 'backups');
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupDir, `projects-merge-${stamp}.json`);
  const backup = {};
  for (const table of ['workspace_projects', ...tables]) {
    backup[table] = db.prepare(`SELECT * FROM ${table}`).all();
  }
  writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8');
  log(`backup written to ${backupPath}`);

  const apply = db.transaction(() => {
    for (const statement of statements) {
      db.prepare(statement.sql).run(...statement.params);
    }
  });
  apply();
  log(`applied ${statements.length} statement(s)`);
}

function formatStatement(statement, escape) {
  let index = 0;
  const sql = statement.sql.replace(/\?/g, () => escape(statement.params[index++]));
  return sql;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
