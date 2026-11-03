import { describe, expect, it } from 'vitest';

import type { DecisionTicket } from '@zhunzou/shared';

import type { MetaAgentConfig } from '../src/config.js';
import {
  createRuleDistiller,
  fallbackRule,
} from '../src/rule-distiller.js';

const ticket: DecisionTicket = {
  id: '104',
  env: 'company-cursor',
  projectName: 'yikuaomed-erp',
  status: 'HUMAN_RESOLVED',
  doneSummary: '完成登录页表单校验',
  blockerQuestion: '错误提示用 Toast 还是行内文案？',
  nextStepPlan: '确定后接入统一错误处理',
  options: [
    { key: 'A', label: 'Toast 提示' },
    { key: 'B', label: '行内文案' },
  ],
  recommendedOption: 'A',
  selectedOption: 'B',
  customInstruction: '先只改登录页',
  resolvedBy: 'HUMAN',
  createdAt: 1,
  updatedAt: 2,
};

function config(overrides: Partial<MetaAgentConfig> = {}): MetaAgentConfig {
  return {
    provider: 'openai',
    enabled: true,
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'sk-test',
    model: 'deepseek-chat',
    timeoutMs: 1000,
    endpoint: '',
    headers: {},
    ...overrides,
  };
}

describe('fallbackRule', () => {
  it('produces a usable rule without an LLM', () => {
    const rule = fallbackRule(ticket);
    expect(rule.startsWith('- ')).toBe(true);
    expect(rule).toContain('yikuaomed-erp');
    expect(rule).toContain('方案 B');
    expect(rule).toContain('行内文案');
    expect(rule).toContain('先只改登录页');
  });
});

describe('createRuleDistiller', () => {
  it('uses the deterministic fallback when the provider is none', async () => {
    const distiller = createRuleDistiller(config({ provider: 'none' }));
    await expect(distiller.distill(ticket)).resolves.toBe(fallbackRule(ticket));
  });

  it('uses the LLM and sanitizes a fenced bullet', async () => {
    const distiller = createRuleDistiller(
      config(),
      (async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '```markdown\n- 表单错误提示优先使用行内文案。\n```' } },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
    );

    await expect(distiller.distill(ticket)).resolves.toBe(
      '- 表单错误提示优先使用行内文案。',
    );
  });

  it('honors an explicit SKIP verdict', async () => {
    const distiller = createRuleDistiller(
      config(),
      (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'SKIP' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
    );

    await expect(distiller.distill(ticket)).resolves.toBeNull();
  });

  it('falls back when the LLM request fails', async () => {
    const warnings: string[] = [];
    const distiller = createRuleDistiller(
      config(),
      (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch,
      { warn: (_obj, msg) => warnings.push(msg ?? '') },
    );

    await expect(distiller.distill(ticket)).resolves.toBe(fallbackRule(ticket));
    expect(warnings.length).toBe(1);
  });

  it('supports the generic HTTP distiller endpoint', async () => {
    let captured: { url: string; body: unknown } | null = null;
    const distiller = createRuleDistiller(
      config({ provider: 'http', endpoint: 'https://brain.internal/distill' }),
      (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), body: JSON.parse(String(init?.body)) };
        return new Response(JSON.stringify({ rule: '统一使用行内错误提示。' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    );

    await expect(distiller.distill(ticket)).resolves.toBe(
      '- 统一使用行内错误提示。',
    );
    expect(captured).toMatchObject({
      url: 'https://brain.internal/distill',
      body: { type: 'distill_rule' },
    });
  });

  it('skips a review-style JSON response from the HTTP endpoint', async () => {
    const distiller = createRuleDistiller(
      config({ provider: 'http', endpoint: 'https://brain.internal/distill' }),
      (async () =>
        new Response('{"canResolve":false,"reason":"需要人工"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    );

    await expect(distiller.distill(ticket)).resolves.toBeNull();
  });

  it('does nothing for tickets that were not human-resolved', async () => {
    const distiller = createRuleDistiller(config({ provider: 'none' }));
    await expect(
      distiller.distill({ ...ticket, status: 'AUTO_RESOLVED' }),
    ).resolves.toBeNull();
  });
});
