import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCurrentRelease } from '../src/install-layout.js';
import { compareVersions, runUpgrade } from '../src/upgrade.js';

interface Fixture {
  version: string;
  files: Record<string, string>;
  /** Override a published digest to exercise integrity checks. */
  corrupt?: string;
}

let server: Server | undefined;
let hubUrl = '';
let root = '';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function startHub(fixture: Fixture): Promise<string> {
  const manifest = {
    version: fixture.version,
    releasedAt: Date.now(),
    files: Object.fromEntries(
      Object.entries(fixture.files).map(([name, content]) => [
        name,
        {
          sha256:
            name === fixture.corrupt
              ? 'f'.repeat(64)
              : sha256(content),
          size: Buffer.byteLength(content),
        },
      ]),
    ),
  };

  server = createServer((request, response) => {
    const url = request.url ?? '/';
    if (url === '/api/bridge/latest') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(manifest));
      return;
    }
    const prefix = `/releases/bridge/${fixture.version}/`;
    if (url.startsWith(prefix)) {
      const name = url.slice(prefix.length);
      const content = fixture.files[name];
      if (content !== undefined) {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end(content);
        return;
      }
    }
    response.writeHead(404);
    response.end('not found');
  });

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('failed to bind test hub');
  }
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zhunzou-upgrade-'));
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('compareVersions', () => {
  it('compares numeric segments instead of strings', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('v1.2.0', '1.1.9')).toBe(1);
  });

  it('ranks a release above its prereleases', () => {
    expect(compareVersions('1.2.0', '1.2.0-beta.3')).toBe(1);
    expect(compareVersions('1.2.0-beta.2', '1.2.0-beta.10')).toBe(-1);
  });
});

describe('runUpgrade', () => {
  it('downloads a newer release and points current.json at it', async () => {
    hubUrl = await startHub({
      version: '0.2.0',
      files: { 'mcp.mjs': 'export const v = "0.2.0";', 'cli.mjs': '' },
    });

    const result = await runUpgrade({
      hubUrl,
      installRoot: root,
      currentVersion: '0.1.0',
    });

    expect(result.status).toBe('updated');
    expect(result.to).toBe('0.2.0');
    expect(
      readFileSync(join(root, 'versions', '0.2.0', 'mcp.mjs'), 'utf8'),
    ).toContain('0.2.0');
    expect(readCurrentRelease(root)).toMatchObject({ version: '0.2.0' });
  });

  it('reports up-to-date without writing anything', async () => {
    hubUrl = await startHub({ version: '0.2.0', files: { 'mcp.mjs': 'x' } });

    const result = await runUpgrade({
      hubUrl,
      installRoot: root,
      currentVersion: '0.2.0',
    });

    expect(result.status).toBe('up-to-date');
    expect(existsSync(join(root, 'current.json'))).toBe(false);
    expect(existsSync(join(root, 'versions'))).toBe(false);
  });

  it('only reports availability in check mode', async () => {
    hubUrl = await startHub({ version: '0.3.0', files: { 'mcp.mjs': 'x' } });

    const result = await runUpgrade({
      hubUrl,
      installRoot: root,
      currentVersion: '0.2.0',
      checkOnly: true,
    });

    expect(result.status).toBe('available');
    expect(existsSync(join(root, 'current.json'))).toBe(false);
  });

  it('rejects a file whose sha256 does not match', async () => {
    hubUrl = await startHub({
      version: '0.2.0',
      files: { 'mcp.mjs': 'tampered' },
      corrupt: 'mcp.mjs',
    });

    await expect(
      runUpgrade({ hubUrl, installRoot: root, currentVersion: '0.1.0' }),
    ).rejects.toThrow(/sha256/);
    expect(existsSync(join(root, 'current.json'))).toBe(false);
  });

  it('refuses manifests with path traversal entries', async () => {
    hubUrl = await startHub({
      version: '0.2.0',
      files: { '../evil.mjs': 'oops' },
    });

    await expect(
      runUpgrade({ hubUrl, installRoot: root, currentVersion: '0.1.0' }),
    ).rejects.toThrow(/非法文件名/);
  });

  it('rolls back to the newest older installed version', async () => {
    for (const version of ['0.1.0', '0.2.0']) {
      mkdirSync(join(root, 'versions', version), { recursive: true });
      writeFileSync(join(root, 'versions', version, 'mcp.mjs'), version);
    }
    writeFileSync(
      join(root, 'current.json'),
      JSON.stringify({ version: '0.2.0' }),
    );

    const result = await runUpgrade({
      hubUrl: 'http://127.0.0.1:1',
      installRoot: root,
      rollback: true,
    });

    expect(result.status).toBe('rolled-back');
    expect(result.to).toBe('0.1.0');
    expect(readCurrentRelease(root)).toMatchObject({ version: '0.1.0' });
  });

  it('refuses to upgrade an npm-installed or source checkout', async () => {
    await expect(
      runUpgrade({
        hubUrl: 'http://127.0.0.1:1',
        installRoot: '/tmp/app/node_modules/zhunzou-bridge',
        rollback: true,
      }),
    ).rejects.toThrow(/npm/);

    await expect(
      runUpgrade({
        hubUrl: 'http://127.0.0.1:1',
        installRoot: '/tmp/repo/packages/bridge/dist',
        rollback: true,
      }),
    ).rejects.toThrow(/构建产物/);
  });
});
