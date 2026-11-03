import { describe, expect, it } from 'vitest';
import type { MetaAgent } from '../src/meta-agent.js';
import {
  buildUserPrompt,
  createMetaAgent,
  MetaAgentError,
  parseMetaReview,
} from '../src/meta-agent.js';
import { createTestContext, sleep, ticketInput, waitFor, type TestContext } from './helpers.js';
import type { DecisionTicket } from '@zhunzou/shared';

const ticket: DecisionTicket = {
  id: '42',
  env: 'home-opencode',
  projectName: 'yikuaomed-erp',
  status: 'PENDING_META',
  doneSummary: '完成登录表单',
  blockerQuestion: '错误提示用 Toast 还是行内文案？',
  nextStepPlan: '选定后补测试',
  options: [
    { key: 'A', label: 'Toast' },
    { key: 'B', label: '行内文案' },
  ],
  recommendedOption: 'A',
  createdAt: 1,
  updatedAt: 1,
};

describe('parseMetaReview', () => {
  it('parses a fenced JSON verdict', () => {
    const review = parseMetaReview(
      '```json\n{"canResolve": true, "selectedOption": "A", "reason": "规范允许"}\n```',
      ticket,
    );
    expect(review).toEqual({
      canResolve: true,
      selectedOption: 'A',
      reason: '规范允许',
    });
  });

  it('refuses to resolve when the model invents an option', () => {
    const review = parseMetaReview(
      '{"canResolve": true, "selectedOption": "Z", "reason": "随便选"}',
      ticket,
    );
    expect(review.canResolve).toBe(false);
    expect(review.selectedOption).toBeUndefined();
    expect(review.reason).toContain('不存在');
  });

  it('keeps an explicit escalation', () => {
    const review = parseMetaReview(
      '{"canResolve": false, "reason": "涉及数据库变更"}',
      ticket,
    );
    expect(review).toEqual({ canResolve: false, reason: '涉及数据库变更' });
  });

  it('refuses to auto-resolve a destructive option', () => {
    const review = parseMetaReview(
      '{"canResolve": true, "selectedOption": "A", "reason": "看起来可行"}',
      {
        ...ticket,
        options: [
          { key: 'A', label: '删除生产数据', risk: 'destructive' },
          { key: 'B', label: '保留数据' },
        ],
      },
    );

    expect(review.canResolve).toBe(false);
    expect(review.reason).toContain('destructive');
  });

  it('throws on malformed output', () => {
    expect(() => parseMetaReview('not json at all', ticket)).toThrow(MetaAgentError);
  });

  it('throws when canResolve is missing', () => {
    expect(() => parseMetaReview('{"selectedOption": "A"}', ticket)).toThrow(
      /canResolve/,
    );
  });
});

describe('buildUserPrompt', () => {
  it('contains the rules and the three-line brief', () => {
    const prompt = buildUserPrompt(ticket, '1. 一律使用 Pinia。');
    expect(prompt).toContain('一律使用 Pinia');
    expect(prompt).toContain('错误提示用 Toast');
    expect(prompt).toContain('"recommendedOption": "A"');
  });

  it('includes historical precedents when provided', () => {
    const precedent: DecisionTicket = {
      ...ticket,
      id: '103',
      status: 'HUMAN_RESOLVED',
      selectedOption: 'B',
      customInstruction: '先只改登录页',
      resolvedBy: 'HUMAN',
      resolutionReason: '行内反馈更贴近字段',
    };

    const prompt = buildUserPrompt(ticket, '规则', [precedent]);

    expect(prompt).toContain('# 历史判例');
    expect(prompt).toContain('#103');
    expect(prompt).toContain('人工审批');
    expect(prompt).toContain('决定：B（行内文案）');
    expect(prompt).toContain('先只改登录页');
  });

  it('omits the precedent section when there is no history', () => {
    expect(buildUserPrompt(ticket, '规则')).not.toContain('# 历史判例');
  });
});

describe('createMetaAgent', () => {
  it('does not call the LLM when no API key is configured', async () => {
    let called = false;
    const agent = createMetaAgent(
      {
        enabled: true,
        provider: 'openai',
        endpoint: '',
        headers: {},
        baseUrl: 'https://example.invalid/v1',
        apiKey: '',
        model: 'test',
        timeoutMs: 1000,
      },
      (async () => {
        called = true;
        return new Response('{}');
      }) as unknown as typeof fetch,
    );

    const review = await agent.review(ticket, '');
    expect(review.canResolve).toBe(false);
    expect(review.reason).toContain('OPENAI_API_KEY');
    expect(called).toBe(false);
  });

  it('calls an OpenAI-compatible endpoint and parses the verdict', async () => {
    let captured: { url: string; body: unknown; auth: string | null } | null = null;

    const agent = createMetaAgent(
      {
        enabled: true,
        provider: 'openai',
        endpoint: '',
        headers: {},
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'sk-test',
        model: 'deepseek-chat',
        timeoutMs: 1000,
      },
      (async (url: string | URL | Request, init?: RequestInit) => {
        captured = {
          url: String(url),
          body: JSON.parse(String(init?.body)),
          auth: new Headers(init?.headers).get('authorization'),
        };
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"canResolve": true, "selectedOption": "B", "reason": "行内文案更符合规范"}',
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    );

    const review = await agent.review(ticket, '规则：优先行内反馈');
    expect(review).toMatchObject({ canResolve: true, selectedOption: 'B' });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://example.invalid/v1/chat/completions');
    expect(captured!.auth).toBe('Bearer sk-test');
    expect((captured!.body as { model: string }).model).toBe('deepseek-chat');
  });

  it('sends OpenCode Go session headers and disables DeepSeek thinking', async () => {
    let headers: Headers | null = null;
    let body: Record<string, unknown> = {};

    const agent = createMetaAgent(
      {
        enabled: true,
        provider: 'openai',
        endpoint: '',
        headers: {},
        baseUrl: 'https://opencode.ai/inference/go/openai/v1',
        apiKey: 'sk-test',
        model: 'deepseek-v4.1-flash',
        timeoutMs: 1000,
      },
      (async (_url: string | URL | Request, init?: RequestInit) => {
        headers = new Headers(init?.headers);
        body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"canResolve": false, "reason": "需要人工"}' } },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    );

    await agent.review(ticket, '');

    expect(headers).not.toBeNull();
    expect(headers!.get('x-opencode-session')).toBeTruthy();
    expect(headers!.get('user-agent')).toBe('zhunzou/0.1');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('supports the generic HTTP provider with custom headers', async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | null =
      null;

    const agent = createMetaAgent(
      {
        enabled: true,
        provider: 'http',
        endpoint: 'https://brain.internal/decide',
        headers: { authorization: 'Bearer internal' },
        baseUrl: '',
        apiKey: '',
        model: '',
        timeoutMs: 1000,
      },
      (async (url: string | URL | Request, init?: RequestInit) => {
        captured = {
          url: String(url),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        };
        return new Response(
          '{"canResolve":true,"selectedOption":"A","reason":"内部规则命中"}',
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    );

    const review = await agent.review(ticket, '规则：优先推荐方案');

    expect(review).toMatchObject({ canResolve: true, selectedOption: 'A' });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://brain.internal/decide');
    expect(captured!.headers.get('authorization')).toBe('Bearer internal');
    expect(captured!.body).toEqual({
      ticket,
      rules: '规则：优先推荐方案',
    });
  });

  it('always escalates when the provider is none', async () => {
    let called = false;
    const agent = createMetaAgent(
      {
        enabled: false,
        provider: 'none',
        endpoint: '',
        headers: {},
        baseUrl: '',
        apiKey: 'sk-test',
        model: 'test',
        timeoutMs: 1000,
      },
      (async () => {
        called = true;
        return new Response('{}');
      }) as unknown as typeof fetch,
    );

    const review = await agent.review(ticket, '');
    expect(review.canResolve).toBe(false);
    expect(review.reason).toContain('META_AGENT_PROVIDER=none');
    expect(called).toBe(false);
  });

  it('escalates when the HTTP provider has no endpoint', async () => {
    const agent = createMetaAgent({
      enabled: true,
      provider: 'http',
      endpoint: '',
      headers: {},
      baseUrl: '',
      apiKey: '',
      model: '',
      timeoutMs: 1000,
    });

    const review = await agent.review(ticket, '');
    expect(review.canResolve).toBe(false);
    expect(review.reason).toContain('META_AGENT_ENDPOINT');
  });

  it('surfaces HTTP failures as MetaAgentError', async () => {
    const agent = createMetaAgent(
      {
        enabled: true,
        provider: 'openai',
        endpoint: '',
        headers: {},
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'sk-test',
        model: 'test',
        timeoutMs: 1000,
      },
      (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch,
    );

    await expect(agent.review(ticket, '')).rejects.toThrow(/429/);
  });
});

describe('Meta-Agent server integration', () => {
  it('auto-resolves a ticket and wakes the long poll', async () => {
    const agent: MetaAgent = {
      review: async () => ({ canResolve: true, selectedOption: 'A', reason: '符合规范' }),
    };
    const ctx: TestContext = await createTestContext(agent);

    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: ctx.auth,
        payload: ticketInput(),
      });
      const createdTicket = created.json().ticket as DecisionTicket;

      const resolved = await waitFor(() => {
        const current = ctx.app.repo.get(Number(createdTicket.id));
        return current?.status === 'AUTO_RESOLVED' ? current : null;
      });

      expect(resolved.resolvedBy).toBe('META_AGENT');
      expect(resolved.selectedOption).toBe('A');
      expect(resolved.resolutionReason).toBe('符合规范');

      const wait = await ctx.app.inject({
        method: 'GET',
        url: `/api/tickets/${createdTicket.id}/wait?timeout=1000`,
        headers: ctx.auth,
      });
      expect(wait.json()).toMatchObject({ resolved: true, timedOut: false });
    } finally {
      await ctx.close();
    }
  });

  it('escalates to a human when the Meta-Agent declines', async () => {
    const agent: MetaAgent = {
      review: async () => ({ canResolve: false, reason: '涉及数据库 schema 变更' }),
    };
    const ctx = await createTestContext(agent);

    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: ctx.auth,
        payload: ticketInput(),
      });
      const id = created.json().ticket.id as string;

      const escalated = await waitFor(() => {
        const current = ctx.app.repo.get(Number(id));
        return current?.status === 'PENDING_HUMAN' ? current : null;
      });
      expect(escalated.resolutionReason).toContain('schema');
    } finally {
      await ctx.close();
    }
  });

  it('escalates to a human when the Meta-Agent crashes', async () => {
    const agent: MetaAgent = {
      review: async () => {
        throw new MetaAgentError('upstream exploded');
      },
    };
    const ctx = await createTestContext(agent);

    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: ctx.auth,
        payload: ticketInput(),
      });
      const id = created.json().ticket.id as string;

      const escalated = await waitFor(() => {
        const current = ctx.app.repo.get(Number(id));
        return current?.status === 'PENDING_HUMAN' ? current : null;
      });
      expect(escalated.resolutionReason).toContain('预审失败');
    } finally {
      await ctx.close();
    }
  });

  it('passes same-project historical decisions to the Meta-Agent', async () => {
    const calls: DecisionTicket[][] = [];
    const agent: MetaAgent = {
      review: async (_ticket, _rules, precedents = []) => {
        calls.push(precedents);
        return { canResolve: false, reason: '保持人工' };
      },
    };
    const ctx = await createTestContext(agent);

    try {
      const first = await ctx.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: ctx.auth,
        payload: ticketInput({ projectName: 'precedent-project' }),
      });
      const firstId = first.json().ticket.id as string;

      await waitFor(() => calls.length >= 1);
      await ctx.app.inject({
        method: 'POST',
        url: `/api/tickets/${firstId}/resolve`,
        headers: ctx.auth,
        payload: { selectedOption: 'B' },
      });

      const second = await ctx.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: ctx.auth,
        payload: ticketInput({ projectName: 'precedent-project' }),
      });
      expect(second.statusCode).toBe(201);

      const withHistory = await waitFor(
        () => calls.find((items) => items.length > 0) ?? null,
      );

      expect(withHistory.map((ticket) => ticket.id)).toContain(firstId);
      expect(withHistory[0]?.selectedOption).toBe('B');
    } finally {
      await ctx.close();
    }
  });

  it('never overwrites a human decision with a late Meta-Agent verdict', async () => {
    const agent: MetaAgent = {
      review: async () => {
        await sleep(200);
        return { canResolve: true, selectedOption: 'A', reason: '迟到的自动决定' };
      },
    };
    const ctx = await createTestContext(agent);

    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: ctx.auth,
        payload: ticketInput(),
      });
      const id = created.json().ticket.id as string;

      const human = await ctx.app.inject({
        method: 'POST',
        url: `/api/tickets/${id}/resolve`,
        headers: ctx.auth,
        payload: { selectedOption: 'B', customInstruction: '我拍板用 B' },
      });
      expect(human.statusCode).toBe(200);

      await sleep(350);

      const final = ctx.app.repo.get(Number(id));
      expect(final?.status).toBe('HUMAN_RESOLVED');
      expect(final?.selectedOption).toBe('B');
      expect(final?.resolvedBy).toBe('HUMAN');
    } finally {
      await ctx.close();
    }
  });
});
