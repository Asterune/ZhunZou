import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DeviceConnectionInput } from '@zhunzou/shared';

import { createDatabase } from '../src/db/client.js';
import { TicketRepository } from '../src/repository.js';

/**
 * The node card the scheduler routes on lives in `devices`: the placement
 * profile (role, tags, free memory, concurrency, repo inventory) is persisted
 * with every hello and rebuilt on read, so a restarted hub keeps its map.
 */
function connectionInput(
  overrides: Partial<DeviceConnectionInput> = {},
): DeviceConnectionInput {
  return {
    env: 'mac-mini-1',
    protocolVersion: 1,
    capabilities: {
      protocol: 1,
      os: 'darwin',
      arch: 'arm64',
      hostname: 'studio-mini',
      machineId: 'mm-fingerprint-0001',
      tools: [],
      features: [],
    },
    stats: { freeMemBytes: 6 * 1024 * 1024 * 1024, cpuCount: 8 },
    transport: 'ws',
    profile: {
      nodeId: 'mac-mini-1',
      hostname: 'studio-mini',
      role: 'worker',
      tags: ['office', 'mac-mini'],
      maxConcurrency: 2,
      repos: [{ name: 'pte-dojo', path: '/Users/qiliu/code/pte-dojo' }],
    },
    ...overrides,
  };
}

describe('node profile persistence', () => {
  let dir = '';
  let handle: ReturnType<typeof createDatabase>;
  let repo: TicketRepository;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhunzou-nodes-'));
    handle = createDatabase(join(dir, 'hub.db'));
    repo = new TicketRepository(handle.db);
  });

  afterAll(() => {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores the role, tags, memory ceiling and repo inventory', () => {
    repo.recordDeviceConnection(connectionInput(), 1_700_000_000_000);

    const device = repo.listDevices(1_700_000_000_000).find((item) => item.id === 'mm-fingerprint-0001');
    expect(device?.profile).toMatchObject({
      nodeId: 'mm-fingerprint-0001',
      hostname: 'studio-mini',
      role: 'worker',
      tags: ['office', 'mac-mini'],
      maxConcurrency: 2,
      freeMemoryMB: 6144,
    });
    expect(device?.profile?.repos[0]?.name).toBe('pte-dojo');
  });

  it('keeps one card and lets a later heartbeat revise it', () => {
    repo.recordDeviceConnection(
      connectionInput({
        env: 'mac-mini-1b',
        profile: {
          nodeId: 'ignored-by-hub',
          hostname: 'studio-mini',
          role: 'portal',
          tags: ['office'],
          maxConcurrency: 1,
          repos: [
            { name: 'pte-dojo', path: '/Users/qiliu/code/pte-dojo' },
            { name: 'pte-crawler', path: '/Users/qiliu/code/pte-crawler' },
          ],
        },
      }),
      1_700_000_060_000,
    );

    const cards = repo.listDevices(1_700_000_060_000);
    const mine = cards.filter((item) => item.id === 'mm-fingerprint-0001');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.profile).toMatchObject({
      role: 'portal',
      repos: [
        { name: 'pte-dojo', path: '/Users/qiliu/code/pte-dojo' },
        { name: 'pte-crawler', path: '/Users/qiliu/code/pte-crawler' },
      ],
    });
  });

  it('reports no profile for a node that never sent one', () => {
    const input = connectionInput({ env: 'legacy-box' });
    delete input.profile;
    repo.recordDeviceConnection(input, 1_700_000_120_000);

    const device = repo
      .listDevices(1_700_000_120_000)
      .find((item) => item.id === 'mm-fingerprint-0001');
    // The revision above stuck: a profile-less beat must not erase it.
    expect(device?.profile?.role).toBe('portal');
  });

  it('upgrades a devices table that predates the profile columns', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'zhunzou-nodes-legacy-'));
    const path = join(legacyDir, 'hub.db');
    const now = Date.now();

    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        machine_id TEXT,
        host TEXT,
        os TEXT,
        capabilities TEXT,
        device_stats TEXT,
        transport TEXT,
        last_seen_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
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
      INSERT INTO devices (id, host, created_at, updated_at)
        VALUES ('host:lq', 'LQ', 1, 1);
    `);
    legacy.close();

    const upgraded = createDatabase(path);
    const columns = (
      upgraded.sqlite.prepare('PRAGMA table_info(devices)').all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toEqual(
      expect.arrayContaining(['role', 'tags', 'max_concurrency', 'free_memory_mb', 'repos']),
    );

    const upgradedRepo = new TicketRepository(upgraded.db);
    const existing = upgradedRepo
      .listDevices(now)
      .find((item) => item.id === 'host:lq');
    expect(existing?.profile).toMatchObject({
      nodeId: 'host:lq',
      role: 'worker',
      tags: [],
      maxConcurrency: 1,
      repos: [],
    });

    upgraded.sqlite.close();
    rmSync(legacyDir, { recursive: true, force: true });
  });
});
