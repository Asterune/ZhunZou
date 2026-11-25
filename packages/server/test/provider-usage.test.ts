import { describe, expect, it } from 'vitest';

import {
  ProviderUsageReader,
  deriveProviderUsageUrl,
} from '../src/provider-usage.js';

const METERS = {
  usage: {
    rolling: {
      status: 'ok',
      percent: 3,
      resetsAt: '2026-11-25T14:47:37.000Z',
    },
    weekly: {
      status: 'ok',
      percent: 12,
      resetsAt: '2026-11-30T00:00:00.000Z',
    },
    monthly: {
      status: 'ok',
      percent: 1,
      resetsAt: '2026-12-24T00:50:18.000Z',
    },
  },
};

describe('deriveProviderUsageUrl', () => {
  it('turns the Go inference base into the usage endpoint', () => {
    expect(
      deriveProviderUsageUrl('https://opencode.ai/inference/go/openai/v1'),
    ).toBe('https://opencode.ai/inference/go/v1/usage');
    expect(
      deriveProviderUsageUrl('https://opencode.ai/inference/go/anthropic/v1/'),
    ).toBe('https://opencode.ai/inference/go/v1/usage');
  });

  it('stays silent for providers without a known endpoint', () => {
    expect(deriveProviderUsageUrl('https://api.openai.com/v1')).toBeUndefined();
    expect(deriveProviderUsageUrl(undefined)).toBeUndefined();
  });
});

describe('ProviderUsageReader', () => {
  it('parses the three meters and caches the answer', async () => {
    let calls = 0;
    let now = 1_000;
    const reader = new ProviderUsageReader({
      url: 'https://example.test/usage',
      apiKey: 'key',
      provider: 'opencode-go',
      now: () => now,
      ttlMs: 60_000,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify(METERS), { status: 200 });
      },
    });

    const first = await reader.read();
    expect(first.supported).toBe(true);
    expect(first.usage?.rolling.percent).toBe(3);
    expect(first.usage?.weekly.percent).toBe(12);

    now += 30_000;
    await reader.read();
    expect(calls).toBe(1);

    now += 31_000;
    await reader.read();
    expect(calls).toBe(2);
  });

  it('marks a key without entitlement as unsupported', async () => {
    const reader = new ProviderUsageReader({
      url: 'https://example.test/usage',
      apiKey: 'key',
      provider: 'opencode-go',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'EntitlementError', message: 'Go required' },
          }),
          { status: 403 },
        ),
    });

    const result = await reader.read();
    expect(result.supported).toBe(false);
    expect(result.usage).toBeNull();
    expect(result.error).toContain('不支持');
  });

  it('reports unsupported when nothing is configured', async () => {
    const reader = new ProviderUsageReader({});
    const result = await reader.read();
    expect(result.supported).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
