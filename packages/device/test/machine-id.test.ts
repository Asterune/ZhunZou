import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { machineId } from '../src/machine-id.js';

const race = vi.hoisted(() => ({
  armed: false,
  winner: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
}));

// Simulate the bridge and device daemons booting at the same instant: a
// competing writer lands the winning id just before our exclusive create.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync(
      file: Parameters<typeof actual.writeFileSync>[0],
      data: Parameters<typeof actual.writeFileSync>[1],
      options?: Parameters<typeof actual.writeFileSync>[2],
    ) {
      if (
        race.armed &&
        typeof file === 'string' &&
        file.endsWith('machine.json')
      ) {
        race.armed = false;
        actual.writeFileSync(file, JSON.stringify({ machineId: race.winner }));
      }
      actual.writeFileSync(file, data, options);
    },
  };
});

const dirs: string[] = [];

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-machine-'));
  dirs.push(dir);
  return join(dir, 'machine.json');
}

afterEach(() => {
  race.armed = false;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('machineId', () => {
  it('creates a fingerprint once and reuses it', () => {
    const path = tempPath();

    const first = machineId(path);

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(readFileSync(path, 'utf8')).machineId).toBe(first);
    expect(machineId(path)).toBe(first);
  });

  it('adopts the fingerprint another client already stored', () => {
    const path = tempPath();
    writeFileSync(path, JSON.stringify({ machineId: race.winner }));

    expect(machineId(path)).toBe(race.winner);
  });

  it('adopts the winner when a concurrent create wins the race', () => {
    const path = tempPath();
    race.armed = true;

    expect(machineId(path)).toBe(race.winner);
    expect(JSON.parse(readFileSync(path, 'utf8')).machineId).toBe(race.winner);
  });

  it('replaces a stored id that is too short to be a fingerprint', () => {
    const path = tempPath();
    writeFileSync(path, JSON.stringify({ machineId: 'abc' }));

    const id = machineId(path);

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(readFileSync(path, 'utf8')).machineId).toBe(id);
  });

  it('returns undefined when the file cannot be created', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhunzou-machine-'));
    dirs.push(dir);
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');

    expect(machineId(join(blocker, 'machine.json'))).toBeUndefined();
  });

  it('returns undefined for a corrupt file instead of minting a ghost id', () => {
    const path = tempPath();
    writeFileSync(path, '{ broken');

    expect(machineId(path)).toBeUndefined();
  });
});