import { describe, expect, it } from 'vitest';

import { loadDeviceConfig } from '../src/config.js';

const base = { ZHUNZOU_HUB_URL: 'http://127.0.0.1:8787', HUB_TOKEN: 'zz_test' };

describe('loadDeviceConfig', () => {
  it('beats faster than the hub routing window so a node never flakes offline', () => {
    const config = loadDeviceConfig(base);

    expect(config.heartbeatMs).toBe(15_000);
    expect(config.heartbeatMs * 2).toBeLessThanOrEqual(30_000);
  });

  it('describes an unconfigured machine as a plain worker', () => {
    const config = loadDeviceConfig(base);

    expect(config.node).toEqual({
      role: 'worker',
      tags: [],
      maxConcurrency: 1,
      scanDirs: [],
    });
  });

  it('reads the routing profile from the environment', () => {
    const config = loadDeviceConfig({
      ...base,
      ZHUNZOU_NODE_ROLE: 'hybrid',
      ZHUNZOU_NODE_TAGS: ' office , gpu,',
      ZHUNZOU_MAX_CONCURRENCY: '4',
      ZHUNZOU_SCAN_DIRS: '~/code,/srv/work',
    });

    expect(config.node).toEqual({
      role: 'hybrid',
      tags: ['office', 'gpu'],
      maxConcurrency: 4,
      scanDirs: [`${process.env.HOME}/code`, '/srv/work'],
    });
  });

  it('drops an unknown role and keeps the worker default', () => {
    const config = loadDeviceConfig({ ...base, ZHUNZOU_NODE_ROLE: 'overlord' });

    expect(config.node?.role).toBe('worker');
  });

  it('keeps the profile inside the contract bounds', () => {
    const manyTags = Array.from({ length: 14 }, (_, index) => `tag-${index}`).join(',');

    expect(loadDeviceConfig({ ...base, ZHUNZOU_MAX_CONCURRENCY: '99' }).node)
      .toMatchObject({ maxConcurrency: 16 });
    expect(loadDeviceConfig({ ...base, ZHUNZOU_MAX_CONCURRENCY: '0' }).node)
      .toMatchObject({ maxConcurrency: 1 });
    expect(loadDeviceConfig({ ...base, ZHUNZOU_NODE_TAGS: manyTags }).node?.tags).toHaveLength(10);
  });

  it('honours the legacy env labels the bridge already uses', () => {
    const config = loadDeviceConfig({
      HUB_URL: 'https://hub.example.com/',
      HUB_SECRET_TOKEN: 'admin',
      AGENT_ENV: 'studio-mini',
      ZHUNZOU_NODE_ROLE: 'portal',
    });

    expect(config.env).toBe('studio-mini');
    expect(config.hubUrl).toBe('https://hub.example.com');
    expect(config.node).toMatchObject({ role: 'portal', tags: [] });
  });

  it('still requires a token', () => {
    expect(() => loadDeviceConfig({ ZHUNZOU_HUB_URL: 'http://127.0.0.1:8787' })).toThrow(
      /HUB_TOKEN is required/,
    );
  });
});
