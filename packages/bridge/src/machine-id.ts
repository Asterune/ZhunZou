import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Lives next to the fleet config so every client on the box reads one value. */
export function machineIdPath(): string {
  return join(homedir(), '.zhunzou', 'machine.json');
}

const cache = new Map<string, string>();

function readStored(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const stored = JSON.parse(readFileSync(path, 'utf8')) as {
    machineId?: unknown;
  };
  if (
    typeof stored?.machineId === 'string' &&
    stored.machineId.length >= 8 &&
    stored.machineId.length <= 64
  ) {
    return stored.machineId;
  }
  return undefined;
}

/**
 * The machine's stable fingerprint, created on first use.
 *
 * The hub groups agents onto device cards with it, because a hostname is not
 * an identity: imaged clones boot with the same one and a renamed machine
 * would otherwise lose its history. Returns undefined when the home directory
 * cannot be written — reporting nothing keeps the hub on its hostname
 * fallback, while inventing a fresh id per start would mint a ghost device.
 */
export function machineId(path = machineIdPath()): string | undefined {
  const cached = cache.get(path);
  if (cached) return cached;

  try {
    const existed = existsSync(path);
    const stored = readStored(path);
    if (stored) {
      cache.set(path, stored);
      return stored;
    }

    const id = randomUUID();
    mkdirSync(dirname(path), { recursive: true });
    try {
      // Exclusive create: the bridge and the device daemon can boot at the
      // same instant; the loser adopts the winner's id instead of minting a
      // second fingerprint for the same box.
      writeFileSync(path, `${JSON.stringify({ machineId: id }, null, 2)}\n`, {
        mode: 0o600,
        flag: existed ? 'w' : 'wx',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
      const winner = readStored(path);
      if (!winner) return undefined;
      cache.set(path, winner);
      return winner;
    }
    cache.set(path, id);
    return id;
  } catch {
    return undefined;
  }
}