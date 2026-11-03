import { describe, expect, it } from 'vitest';

import { loadConfig, REPO_ROOT } from '../src/config.js';

describe('loadConfig', () => {
  it('keeps the in-memory SQLite path intact', () => {
    const config = loadConfig({ DATABASE_PATH: ':memory:' });
    expect(config.dbPath).toBe(':memory:');
  });

  it('resolves relative storage paths against the repository root', () => {
    const config = loadConfig({ DATABASE_PATH: './data/x.db' });
    expect(config.dbPath).toBe(`${REPO_ROOT}/data/x.db`);
  });

  it('serves the web build by default and allows opting out', () => {
    expect(loadConfig({}).serveWeb).toBe(true);
    expect(loadConfig({}).webDistPath).toBe(`${REPO_ROOT}/packages/web/dist`);
    expect(loadConfig({ SERVE_WEB: 'false' }).serveWeb).toBe(false);
  });

  it('falls back to the development token outside production', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.token).toBe('dev-token');
  });

  it('refuses to boot in production without a token', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/HUB_SECRET_TOKEN/);
  });

  it('accepts a production token and clamps numeric options', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      HUB_SECRET_TOKEN: 'a-very-long-production-secret',
      PORT: '99999',
      WAIT_TIMEOUT_MS: '999999',
    });

    expect(config.port).toBe(65_535);
    expect(config.waitTimeoutMs).toBe(55_000);
    expect(config.isProduction).toBe(true);
  });

  it('exposes pluggable Meta-Agent providers', () => {
    expect(loadConfig({}).metaAgent).toMatchObject({
      provider: 'openai',
      enabled: true,
    });
    expect(
      loadConfig({ META_AGENT_ENABLED: 'false' }).metaAgent.provider,
    ).toBe('none');
    expect(
      loadConfig({
        META_AGENT_PROVIDER: 'http',
        META_AGENT_ENDPOINT: 'https://brain.internal/decide',
        META_AGENT_HEADERS: '{"authorization":"Bearer x"}',
      }).metaAgent,
    ).toMatchObject({
      provider: 'http',
      endpoint: 'https://brain.internal/decide',
      headers: { authorization: 'Bearer x' },
    });
  });

  it('rejects invalid Meta-Agent configuration', () => {
    expect(() => loadConfig({ META_AGENT_PROVIDER: 'magic' })).toThrow(
      /META_AGENT_PROVIDER/,
    );
    expect(() => loadConfig({ META_AGENT_HEADERS: '[]' })).toThrow(
      /META_AGENT_HEADERS/,
    );
    expect(() => loadConfig({ META_AGENT_HEADERS: 'not-json' })).toThrow(
      /META_AGENT_HEADERS/,
    );
  });

  it('parses notifier channels and keeps the webhook fallback', () => {
    expect(loadConfig({}).notifications).toEqual([]);
    expect(loadConfig({ WEBHOOK_URL: 'https://hooks.example/x' }).notifications).toEqual([
      { type: 'webhook', url: 'https://hooks.example/x' },
    ]);
    expect(
      loadConfig({
        NOTIFY_CHANNELS: 'bark, feishu, telegram, console',
        BARK_KEY: 'device-key',
        FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/hook',
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_CHAT_ID: '42',
      }).notifications,
    ).toEqual([
      { type: 'bark', url: 'https://api.day.app/device-key' },
      { type: 'feishu', url: 'https://open.feishu.cn/hook' },
      { type: 'telegram', token: 'bot-token', chatId: '42' },
      { type: 'console' },
    ]);
  });

  it('rejects unknown or incomplete notifier channels', () => {
    expect(() => loadConfig({ NOTIFY_CHANNELS: 'pager' })).toThrow(
      /unknown notification channel/,
    );
    expect(() => loadConfig({ NOTIFY_CHANNELS: 'slack' })).toThrow(
      /SLACK_WEBHOOK_URL/,
    );
  });

  it('parses timeout, sweeper and stale-task policies', () => {
    expect(loadConfig({})).toMatchObject({
      autoResolveTimeoutMs: 0,
      autoResolveProjects: [],
      sweepIntervalMs: 5_000,
      taskClaimTimeoutMs: 30 * 60 * 1000,
      taskHardTimeoutMs: 6 * 60 * 60 * 1000,
      taskMaxAttempts: 3,
    });

    expect(
      loadConfig({
        AUTO_RESOLVE_TIMEOUT_MS: '600000',
        AUTO_RESOLVE_PROJECTS: 'erp, cms',
        SWEEP_INTERVAL_MS: '1000',
        TASK_CLAIM_TIMEOUT_MS: '60000',
        TASK_HARD_TIMEOUT_MS: '7200000',
        TASK_MAX_ATTEMPTS: '5',
      }),
    ).toMatchObject({
      autoResolveTimeoutMs: 600_000,
      autoResolveProjects: ['erp', 'cms'],
      sweepIntervalMs: 1_000,
      taskClaimTimeoutMs: 60_000,
      taskHardTimeoutMs: 7_200_000,
      taskMaxAttempts: 5,
    });
  });

  it('parses public approval-link settings', () => {
    expect(
      loadConfig({
        HUB_SECRET_TOKEN: 'api-token',
        PUBLIC_BASE_URL: 'https://hub.example.com/',
        APPROVAL_LINK_SECRET: 'link-secret',
        APPROVAL_LINK_TTL_MS: '60000',
      }),
    ).toMatchObject({
      publicBaseUrl: 'https://hub.example.com',
      approvalLinkSecret: 'link-secret',
      approvalLinkTtlMs: 60_000,
    });

    expect(
      loadConfig({
        HUB_SECRET_TOKEN: 'api-token',
        PUBLIC_BASE_URL: '',
        APPROVAL_LINK_SECRET: '',
      }),
    ).toMatchObject({
      publicBaseUrl: '',
      approvalLinkSecret: 'api-token',
    });
  });

  it('reads plugin modules from a comma-separated list', () => {
    expect(loadConfig({ HUB_PLUGINS: './a.mjs, ./b.mjs' }).plugins).toEqual([
      './a.mjs',
      './b.mjs',
    ]);
  });
});
