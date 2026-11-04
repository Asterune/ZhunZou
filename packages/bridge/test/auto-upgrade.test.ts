import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { maybeAutoUpgrade } from '../src/auto-upgrade.js';
import { readCurrentRelease } from '../src/install-layout.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zhunzou-auto-upgrade-'));
  delete process.env.ZHUNZOU_AUTO_UPGRADE;
  delete process.env.ZHUNZOU_AUTO_UPGRADE_INTERVAL_MS;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.ZHUNZOU_AUTO_UPGRADE;
  delete process.env.ZHUNZOU_AUTO_UPGRADE_INTERVAL_MS;
});

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function fakeFetch(version: string, files: Record<string, string>) {
  const manifest = {
    version,
    releasedAt: Date.now(),
    files: Object.fromEntries(
      Object.entries(files).map(([name, content]) => [
        name,
        { sha256: sha256(content), size: Buffer.byteLength(content) },
      ]),
    ),
  };

  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/api/bridge/latest')) {
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const prefix = `/releases/bridge/${version}/`;
    const index = url.indexOf(prefix);
    const name = index === -1 ? '' : url.slice(index + prefix.length);
    const content = files[name];
    if (content === undefined) return new Response('not found', { status: 404 });
    return new Response(content, { status: 200 });
  }) as typeof fetch;

  return { fetchImpl, calls };
}

describe('maybeAutoUpgrade', () => {
  it('installs a newer release and applies it on the next launch', async () => {
    const { fetchImpl } = fakeFetch('1.1.0', { 'mcp.mjs': 'new mcp' });

    const result = await maybeAutoUpgrade({
      hubUrl: 'https://hub.example.com',
      installRoot: root,
      fetchImpl,
      log: () => undefined,
    });

    expect(result?.status).toBe('updated');
    expect(readCurrentRelease(root)?.version).toBe('1.1.0');
    expect(existsSync(join(root, 'versions', '1.1.0', 'mcp.mjs'))).toBe(true);
  });

  it('checks at most once per interval', async () => {
    const { fetchImpl, calls } = fakeFetch('1.1.0', { 'mcp.mjs': 'new mcp' });
    const now = Date.now();

    await maybeAutoUpgrade({
      hubUrl: 'https://hub.example.com',
      installRoot: root,
      fetchImpl,
      now,
      log: () => undefined,
    });
    const second = await maybeAutoUpgrade({
      hubUrl: 'https://hub.example.com',
      installRoot: root,
      fetchImpl,
      now: now + 60_000,
      log: () => undefined,
    });

    expect(second).toBeNull();
    expect(calls).toHaveLength(2); // manifest + one file, not a second check
  });

  it('honours ZHUNZOU_AUTO_UPGRADE=0', async () => {
    process.env.ZHUNZOU_AUTO_UPGRADE = '0';
    const { fetchImpl, calls } = fakeFetch('1.1.0', { 'mcp.mjs': 'new mcp' });

    const result = await maybeAutoUpgrade({
      hubUrl: 'https://hub.example.com',
      installRoot: root,
      fetchImpl,
      log: () => undefined,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('never writes versions/ into a source checkout', async () => {
    // A repo build lives at packages/bridge/dist-standalone, next to the
    // package.json that names this package.
    const installRoot = join(root, 'dist-standalone');
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'zhunzou-bridge' }),
      'utf8',
    );
    const { fetchImpl, calls } = fakeFetch('1.1.0', { 'mcp.mjs': 'new mcp' });

    const result = await maybeAutoUpgrade({
      hubUrl: 'https://hub.example.com',
      installRoot,
      fetchImpl,
      log: () => undefined,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
    expect(existsSync(join(installRoot, 'versions'))).toBe(false);
  });

  it('swallows hub failures but still stamps the attempt', async () => {
    const result = await maybeAutoUpgrade({
      hubUrl: 'https://hub.example.com',
      installRoot: root,
      fetchImpl: (async () => new Response('down', { status: 503 })) as typeof fetch,
      log: () => undefined,
    });

    expect(result).toBeNull();
    const stamp = JSON.parse(
      readFileSync(join(root, '.auto-upgrade.json'), 'utf8'),
    ) as { checkedAt: number };
    expect(typeof stamp.checkedAt).toBe('number');
  });
});
