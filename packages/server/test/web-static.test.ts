import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zhunzou-web-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head><title>ZHUNZOU_MARKER</title></head><body><div id="app"></div></body></html>',
  );
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log("hub");');

  const config = loadConfig({
    NODE_ENV: 'test',
    HUB_SECRET_TOKEN: 'web-test-token',
    DATABASE_PATH: join(dir, 'test.db'),
    GLOBAL_RULES_PATH: join(dir, 'RULES.md'),
    META_AGENT_ENABLED: 'false',
    SERVE_WEB: 'true',
    WEB_DIST_PATH: dir,
  });

  app = await buildApp({ config, logger: false });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('web dashboard static hosting', () => {
  it('serves index.html at /', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.body).toContain('ZHUNZOU_MARKER');
  });

  it('serves hashed assets with immutable caching', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/assets/app-abc123.js',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('console.log');
    expect(response.headers['cache-control']).toContain('immutable');
  });

  it('falls back to index.html for unknown non-API routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/tickets/104' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('ZHUNZOU_MARKER');
  });

  it('keeps API 404s as JSON', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/does-not-exist',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('keeps the health check working', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
  });
});
