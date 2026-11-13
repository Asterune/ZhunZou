import { describe, expect, it } from 'vitest';

import { agentTaskSchema, type AgentTask } from '@zhunzou/shared';

import type { MetaAgentConfig } from '../src/config.js';
import { createHealer, type FailureEvidence } from '../src/supervisor/healer.js';

function config(overrides: Partial<MetaAgentConfig> = {}): MetaAgentConfig {
  return {
    provider: 'openai',
    enabled: true,
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'sk-test',
    model: 'deepseek-chat',
    timeoutMs: 1_000,
    endpoint: '',
    headers: {},
    ...overrides,
  };
}

const task: AgentTask = agentTaskSchema.parse({
  id: '7',
  env: 'office-cursor',
  title: '修好构建',
  instruction: '把类型错误清零并跑通 pnpm test。',
  status: 'FAILED',
  attempts: 1,
  createdAt: 1,
  updatedAt: 2,
});

const evidence: FailureEvidence = {
  task,
  lastSignature: 'TS2322 src/a.ts',
  heals: [],
  logTail: 'src/a.ts(3,5): error TS2322',
};

const VERDICT =
  '{"decision":"RETRY_WITH_FIX","diagnosisSummary":"类型没对上","fixPrompt":"补上返回类型再跑一次"}';

interface Recorded {
  url: string;
  init: RequestInit;
}

function respondTo(body: unknown, status = 200) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    };
  }) as unknown as typeof fetch;

  return { calls, fetchImpl };
}

function chatCompletion(content: string) {
  return { choices: [{ message: { content } }] };
}

describe('L2 diagnosis client', () => {
  it('A1: stays silent, and silent means silent, when the provider is off', async () => {
    const { calls, fetchImpl } = respondTo(chatCompletion(VERDICT));
    const healer = createHealer(config({ provider: 'none', enabled: false }), fetchImpl);

    await expect(healer.diagnose(evidence)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('A2: does not call an endpoint it has no key for', async () => {
    const { calls, fetchImpl } = respondTo(chatCompletion(VERDICT));
    const healer = createHealer(config({ apiKey: '' }), fetchImpl);

    await expect(healer.diagnose(evidence)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('A3: returns the verdict the model gave', async () => {
    const { fetchImpl } = respondTo(chatCompletion(VERDICT));
    const healer = createHealer(config(), fetchImpl);

    await expect(healer.diagnose(evidence)).resolves.toEqual({
      decision: 'RETRY_WITH_FIX',
      diagnosisSummary: '类型没对上',
      fixPrompt: '补上返回类型再跑一次',
    });
  });

  it('A4: treats prose as no answer, not as a guess', async () => {
    const { fetchImpl } = respondTo(
      chatCompletion('这个任务看起来需要人工确认一下目录权限。'),
    );
    const healer = createHealer(config(), fetchImpl);

    await expect(healer.diagnose(evidence)).resolves.toBeUndefined();
  });

  it('A5: swallows a provider failure instead of failing the run', async () => {
    const warnings: unknown[] = [];
    const { fetchImpl } = respondTo('upset', 500);
    const healer = createHealer(config(), fetchImpl, {
      warn: (obj) => warnings.push(obj),
    });

    await expect(healer.diagnose(evidence)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('A6: gives up on a provider that stops answering', async () => {
    let aborted = false;
    const fetchImpl = ((_url: unknown, init: RequestInit = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      })) as unknown as typeof fetch;

    const healer = createHealer(config({ timeoutMs: 25 }), fetchImpl);
    await expect(healer.diagnose(evidence)).resolves.toBeUndefined();
    expect(aborted).toBe(true);
  });

  it('A7: asks for a machine-readable answer at zero temperature', async () => {
    const { calls, fetchImpl } = respondTo(chatCompletion(VERDICT));
    const healer = createHealer(config({ model: 'deepseek-chat' }), fetchImpl);

    await healer.diagnose(evidence);

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(calls[0]!.url).toBe('https://example.invalid/v1/chat/completions');
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(Number(body.max_tokens)).toBeLessThanOrEqual(800);
    // The reasoning trace is what turns a strict JSON answer into prose.
    expect(body.thinking).toEqual({ type: 'disabled' });
    const roles = (body.messages as Array<{ role: string; content: string }>).map(
      (message) => message.role,
    );
    expect(roles).toEqual(['system', 'user']);
  });

  it('A8: speaks the generic HTTP provider the same way the judge does', async () => {
    const { calls, fetchImpl } = respondTo({
      decision: 'ESCALATE_TO_HUMAN',
      diagnosisSummary: '需要人决定要不要删数据',
    });
    const healer = createHealer(
      config({ provider: 'http', endpoint: 'https://example.invalid/diagnose' }),
      fetchImpl,
    );

    await expect(healer.diagnose(evidence)).resolves.toMatchObject({
      decision: 'ESCALATE_TO_HUMAN',
    });
    expect(calls[0]!.url).toBe('https://example.invalid/diagnose');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.type).toBe('diagnose');
    expect((body.task as AgentTask).id).toBe('7');
    expect(body.evidence).toMatchObject({ lastSignature: 'TS2322 src/a.ts' });
  });

  it('A8b: does not call an http provider with no endpoint configured', async () => {
    const { calls, fetchImpl } = respondTo({ decision: 'APPROVE', diagnosisSummary: 'x' });
    const healer = createHealer(config({ provider: 'http', endpoint: '' }), fetchImpl);

    await expect(healer.diagnose(evidence)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
