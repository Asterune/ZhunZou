#!/usr/bin/env python3
"""One-off: tidy the hub's project and client names.

Merges historical project spellings, drops bindings left by test environments,
and gives each client a human name (the kind is overwritten by every heartbeat,
so it cannot carry the display name).
"""
import sqlite3
import time

DB = '/opt/zhunzou/data/zhunzou.db'

RENAMES = {
    'zhunzou': 'agent-hub',
    'qoder-qidemacbook-pro.local': 'agent-hub',
    'FitAI-': 'FitAI',
}
JUNK_BINDINGS = ['T', 'a', 'b', 'publish-check']
AGENT_NAMES = {
    'cursor-qidemacbook-pro.local': 'Cursor',
    'claude-qidemacbook-pro.local': 'Claude Code',
    'codex-qidemacbook-pro.local': 'Codex',
    'qoder-qidemacbook-pro.local': 'Qoder',
    'opencode-qidemacbook-pro.local': 'OpenCode',
    'agent-fitai': 'OpenCode · FitAI',
    'agent-ai-ledger': 'OpenCode · AI Ledger',
}

now = int(time.time() * 1000)
con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
cur = con.cursor()
cur.execute('PRAGMA busy_timeout = 5000')

TABLES = [
    'tickets',
    'agent_tasks',
    'chat_sessions',
    'exchanges',
    'env_heartbeats',
    'fleet_workspaces',
]

def counts(label):
    rows = cur.execute(
        'select project_name, count(*) from tickets group by project_name order by 2 desc'
    ).fetchall()
    print(label, 'tickets:', ', '.join(f'{r[0] or "(none)"}={r[1]}' for r in rows))

counts('before')

con.execute('BEGIN IMMEDIATE')
try:
    # workspace_projects is unique on (env, project_name); merge duplicates.
    for old, new in RENAMES.items():
        envs = [r[0] for r in cur.execute(
            'select distinct env from workspace_projects where project_name = ?', (old,)
        )]
        for env in envs:
            exists = cur.execute(
                'select 1 from workspace_projects where env = ? and project_name = ?',
                (env, new),
            ).fetchone()
            if exists:
                cur.execute(
                    'delete from workspace_projects where env = ? and project_name = ?',
                    (env, old),
                )
            else:
                cur.execute(
                    'update workspace_projects set project_name = ?, updated_at = ? '
                    'where env = ? and project_name = ?',
                    (new, now, env, old),
                )

    # decision_demotions is unique on (project_name, category).
    for old, new in RENAMES.items():
        cats = [r[0] for r in cur.execute(
            'select distinct category from decision_demotions where project_name = ?', (old,)
        )]
        for cat in cats:
            if cur.execute(
                'select 1 from decision_demotions where project_name = ? and category = ?',
                (new, cat),
            ).fetchone():
                cur.execute(
                    'delete from decision_demotions where project_name = ? and category = ?',
                    (old, cat),
                )
            else:
                cur.execute(
                    'update decision_demotions set project_name = ? '
                    'where project_name = ? and category = ?',
                    (new, old, cat),
                )

    for table in TABLES:
        for old, new in RENAMES.items():
            cur.execute(
                f'update {table} set project_name = ? where project_name = ?',
                (new, old),
            )

    for name in JUNK_BINDINGS:
        cur.execute('delete from workspace_projects where project_name = ?', (name,))

    for env, name in AGENT_NAMES.items():
        cur.execute(
            'update agents set name = ?, updated_at = ? where env = ?',
            (name, now, env),
        )

    con.commit()
except Exception:
    con.rollback()
    raise

counts('after')
print('bindings:')
for row in cur.execute(
    'select project_name, count(*) from workspace_projects group by project_name order by 1'
):
    print(f'  {row[0]}={row[1]}')
print('agents:')
for row in cur.execute('select env, name, kind from agents order by env'):
    print(f'  {row[0]} -> {row[1]} ({row[2]})')
print('tickets total:', cur.execute('select count(*) from tickets').fetchone()[0])
con.close()
