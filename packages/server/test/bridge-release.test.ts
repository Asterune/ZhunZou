import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: FastifyInstance;
let dir: string;
let releases: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zhunzou-release-'));
  releases = join(dir, 'releases');
  mkdirSync(join(releases, '0.2.0'), { recursive: true });
  writeFileSync(join(releases, '0.2.0', 'mcp.mjs'), '// bridge 0.2.0\n');
  writeFileSync(
    join(releases, 'latest.json'),
    JSON.stringify({
      version: '0.2.0',
      releasedAt: 1_700_000_000_000,
      notes: '首次发布',
      files: {
        'mcp.mjs': { sha256: 'a'.repeat(64), size: 16 },
      },
    }),
  );

  const config = loadConfig({
    NODE_ENV: 'test',
    HUB_SECRET_TOKEN: 'release-test-token',
    DATABASE_PATH: join(dir, 'test.db'),
    GLOBAL_RULES_PATH: join(dir, 'RULES.md'),
    META_AGENT_ENABLED: 'false',
    SERVE_WEB: 'false',
    BRIDGE_RELEASES_PATH: releases,
    PUBLIC_BASE_URL: 'https://hub.test',
  });

  app = await buildApp({ config, logger: false });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('bridge release hosting', () => {
  it('publishes the manifest without a token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/bridge/latest',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.version).toBe('0.2.0');
    expect(body.baseUrl).toBe('https://hub.test/releases/bridge/0.2.0');
    expect(body.files['mcp.mjs'].sha256).toHaveLength(64);
  });

  it('serves the bundle under /releases/bridge/', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/releases/bridge/0.2.0/mcp.mjs',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('bridge 0.2.0');
  });

  it('returns a JSON 404 for missing release files', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/releases/bridge/0.2.0/nope.mjs',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 404 when nothing has been published', async () => {
    const emptyDir = join(dir, 'empty-releases');
    mkdirSync(emptyDir, { recursive: true });
    const config = loadConfig({
      NODE_ENV: 'test',
      HUB_SECRET_TOKEN: 'release-test-token',
      DATABASE_PATH: join(dir, 'empty.db'),
      GLOBAL_RULES_PATH: join(dir, 'RULES.md'),
      META_AGENT_ENABLED: 'false',
      SERVE_WEB: 'false',
      BRIDGE_RELEASES_PATH: emptyDir,
    });
    const emptyApp = await buildApp({ config, logger: false });

    const response = await emptyApp.inject({
      method: 'GET',
      url: '/api/bridge/latest',
    });
    expect(response.statusCode).toBe(404);
    await emptyApp.close();
  });
});
