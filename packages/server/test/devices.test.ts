import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { Agent, Device } from '@zhunzou/shared';

import { createDatabase } from '../src/db/client.js';
import { TicketRepository, type IdentityConflict } from '../src/repository.js';
import { createTestContext } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

/**
 * The `agents` table as it stood before devices existed: no device_id, and the
 * machine lived only in a free-text host column.
 */
const LEGACY_AGENTS = `
CREATE TABLE agents (
  env TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  version TEXT,
  host TEXT,
  os TEXT,
  token_hash TEXT,
  token_prefix TEXT,
  token_created_at INTEGER,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

async function register(
  ctx: Ctx,
  payload: Record<string, unknown>,
): Promise<Agent> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/agents',
    headers: ctx.auth,
    payload,
  });
  return (response.json() as { agent: Agent }).agent;
}

async function heartbeat(
  ctx: Ctx,
  env: string,
  agent: Record<string, string>,
): Promise<void> {
  await ctx.app.inject({
    method: 'POST',
    url: '/api/status/heartbeat',
    headers: ctx.auth,
    payload: { env, status: 'Idle', agent },
  });
}

async function devices(ctx: Ctx): Promise<Device[]> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/devices',
    headers: ctx.auth,
  });
  return (response.json() as { devices: Device[] }).devices;
}

describe('device migration', () => {
  it('gives every machine that only reported a hostname its own card', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhunzou-device-'));
    const path = join(dir, 'hub.db');
    const now = Date.now();

    const legacy = new Database(path);
    legacy.exec(LEGACY_AGENTS);
    const insert = legacy.prepare(
      `INSERT INTO agents (env, name, kind, status, host, os, created_at, updated_at)
       VALUES (?, ?, 'cursor', 'active', ?, ?, ?, ?)`,
    );
    insert.run('cursor-erp', 'cursor-erp', 'lq', 'win32-x64', now, now);
    insert.run('cursor-crm', 'cursor-crm', 'LQ ', 'win32-x64', now, now);
    insert.run('opencode-erp', 'opencode-erp', 'office-pc', 'darwin-arm64', now, now);
    legacy.close();

    const { db } = createDatabase(path);
    const repo = new TicketRepository(db);

    // Case and spacing differences are the same machine, so they share a card.
    // A backfilled card carries the normalized spelling; the raw hostname comes
    // back as soon as that machine reports in again.
    expect(repo.listDevices(now)).toMatchObject([
      { id: 'host:lq', host: 'lq', envs: ['cursor-crm', 'cursor-erp'] },
      { id: 'host:office-pc', envs: ['opencode-erp'] },
    ]);
    expect(repo.getAgent('cursor-erp')?.deviceId).toBe('host:lq');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('devices', () => {
  it('separates clones that report the same hostname', async () => {
    const ctx = await createTestContext();
    try {
      const first = await register(ctx, {
        env: 'cursor-erp',
        kind: 'cursor',
        host: 'lq',
        machineId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      });
      // Disk imaging leaves many machines with one hostname; only the
      // fingerprint can tell them apart.
      const second = await register(ctx, {
        env: 'cursor-erp',
        kind: 'cursor',
        host: 'lq',
        machineId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
      });

      expect(first.env).toBe('cursor-erp');
      expect(second.env).toBe('cursor-erp-lq');
      expect(await devices(ctx)).toHaveLength(2);
    } finally {
      await ctx.close();
    }
  });

  it('adopts the hostname card once a machine proves its fingerprint', async () => {
    const ctx = await createTestContext();
    const fingerprint = 'cccccccc-3333-4333-8333-cccccccccccc';
    try {
      const agent = await register(ctx, {
        env: 'cursor-erp',
        kind: 'cursor',
        host: 'lq',
      });
      expect(agent.deviceId).toBe('host:lq');

      await heartbeat(ctx, 'cursor-erp', { host: 'lq', machineId: fingerprint });
      // The alias can only be retired after the agent has moved off it, so a
      // second beat is what actually clears the duplicate card.
      await heartbeat(ctx, 'cursor-erp', { host: 'lq', machineId: fingerprint });

      expect(ctx.app.repo.getAgent('cursor-erp')?.deviceId).toBe(fingerprint);
      expect((await devices(ctx)).map((device) => device.id)).toEqual([
        fingerprint,
      ]);
    } finally {
      await ctx.close();
    }
  });

  it('refuses machine metadata from another fingerprint on one hostname', async () => {
    const ctx = await createTestContext();
    const mine = 'dddddddd-4444-4444-8444-dddddddddddd';
    try {
      await register(ctx, {
        env: 'cursor-erp',
        kind: 'cursor',
        host: 'lq',
        machineId: mine,
      });

      await heartbeat(ctx, 'cursor-erp', {
        host: 'lq',
        os: 'linux-x64',
        machineId: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
      });

      const agent = ctx.app.repo.getAgent('cursor-erp');
      expect(agent?.os).not.toBe('linux-x64');
      expect(agent?.deviceId).toBe(mine);
    } finally {
      await ctx.close();
    }
  });

  it('lists the agents running on each machine', async () => {
    const ctx = await createTestContext();
    try {
      await register(ctx, { env: 'cursor-erp', kind: 'cursor', host: 'lq' });
      await register(ctx, { env: 'opencode-erp', kind: 'opencode', host: 'lq' });

      const [device] = await devices(ctx);
      expect(device).toMatchObject({
        id: 'host:lq',
        host: 'lq',
        online: true,
        envs: ['cursor-erp', 'opencode-erp'],
      });
    } finally {
      await ctx.close();
    }
  });

  it('forgets a machine when its last agent is deleted', async () => {
    const ctx = await createTestContext();
    try {
      await register(ctx, { env: 'cursor-erp', kind: 'cursor', host: 'lq' });
      await ctx.app.inject({
        method: 'DELETE',
        url: '/api/agents/cursor-erp',
        headers: ctx.auth,
      });

      expect(await devices(ctx)).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});

describe('identity conflicts', () => {
  const mine = 'ffffffff-6666-4666-8666-ffffffffffff';
  const theirs = 'gggggggg-7777-4777-8777-gggggggggggg';

  function repoWithConflicts(): {
    repo: TicketRepository;
    conflicts: IdentityConflict[];
    cleanup: () => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'zhunzou-conflict-'));
    const { db } = createDatabase(join(dir, 'hub.db'));
    const conflicts: IdentityConflict[] = [];
    const seeded = new TicketRepository(db);
    seeded.registerAgent({
      env: 'cursor-erp',
      kind: 'cursor',
      host: 'lq',
      machineId: mine,
    });
    const repo = new TicketRepository(db, {
      onIdentityConflict: (conflict) => conflicts.push(conflict),
    });
    return { repo, conflicts, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('reports a beat from a stranger wearing the owner hostname', () => {
    const { repo, conflicts, cleanup } = repoWithConflicts();
    try {
      repo.recordAgentPresence('cursor-erp', {
        host: 'lq',
        os: 'linux-x64',
        machineId: theirs,
      });

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        env: 'cursor-erp',
        owner: { host: 'lq', machineId: mine },
        claimed: { host: 'lq', machineId: theirs },
      });
      expect(repo.getAgent('cursor-erp')?.os).not.toBe('linux-x64');
    } finally {
      cleanup();
    }
  });

  it('stays quiet while the owning machine keeps reporting', () => {
    const { repo, conflicts, cleanup } = repoWithConflicts();
    try {
      repo.recordAgentPresence('cursor-erp', { host: 'lq', machineId: mine });
      repo.recordAgentPresence('cursor-erp', { host: 'lq' });
      repo.recordAgentPresence('cursor-erp', undefined);

      expect(conflicts).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
