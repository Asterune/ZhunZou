import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ChatMessage, ChatSession } from '@zhunzou/shared';

import {
  buildChatHandoff,
  CHAT_HANDOFF_MAX_CHARS,
  CHAT_HANDOFF_TURNS,
  estimateChatTokens,
  isContextOverflow,
  scheduleChatContextSummary,
  shouldSummarizeChatContext,
  summarizeChatContext,
} from '../src/chat-context.js';
import { createDatabase } from '../src/db/client.js';
import { TicketRepository } from '../src/repository.js';
import { createTestContext, type TestContext } from './helpers.js';

const BUDGET = 4_000;

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext(undefined, undefined, {
    CHAT_CONTEXT_BUDGET_TOKENS: String(BUDGET),
  });
});

afterAll(async () => {
  await ctx.close();
});

function fixtureSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: '42',
    env: 'company-cursor',
    title: '上下文轮换',
    status: 'ACTIVE',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function fixtureMessage(
  id: number,
  role: ChatMessage['role'],
  content: string,
): ChatMessage {
  return {
    id: String(id),
    sessionId: '42',
    role,
    content,
    status: 'DONE',
    createdAt: id,
    updatedAt: id,
  };
}

describe('estimateChatTokens', () => {
  it('uses the four-chars-per-token rule', () => {
    expect(estimateChatTokens('')).toBe(0);
    expect(estimateChatTokens('abcd')).toBe(1);
    expect(estimateChatTokens('a'.repeat(41))).toBe(11);
  });
});

describe('isContextOverflow', () => {
  it('recognises the phrasings CLIs use for an oversized prompt', () => {
    for (const error of [
      'Error: context length exceeded',
      'prompt is too long: 210000 tokens > 200000 maximum',
      'This model maximum context is 128k',
      '上下文长度超过上限',
    ]) {
      expect(isContextOverflow(error)).toBe(true);
    }
  });

  it('leaves unrelated failures alone', () => {
    expect(isContextOverflow('rate limit exceeded')).toBe(false);
    expect(isContextOverflow(undefined)).toBe(false);
  });
});

describe('buildChatHandoff', () => {
  it('keeps the newest turns and says what was dropped', () => {
    const messages = Array.from({ length: CHAT_HANDOFF_TURNS + 4 }, (_, index) =>
      fixtureMessage(
        index + 1,
        index % 2 === 0 ? 'user' : 'assistant',
        `第 ${index + 1} 条消息`,
      ),
    );

    const handoff = buildChatHandoff({
      session: fixtureSession(),
      messages,
      rotation: 2,
    });

    expect(handoff).toContain('第 2 次');
    expect(handoff).toContain(`第 ${messages.length} 条消息`);
    expect(handoff).not.toContain('第 1 条消息');
    expect(handoff).toContain('更早的内容已省略');
    expect(handoff.length).toBeLessThanOrEqual(CHAT_HANDOFF_MAX_CHARS + 200);
  });

  it('truncates a single huge turn instead of dropping the dialogue', () => {
    const handoff = buildChatHandoff({
      session: fixtureSession(),
      messages: [fixtureMessage(1, 'assistant', 'x'.repeat(20_000))],
      rotation: 1,
    });
    expect(handoff.length).toBeLessThanOrEqual(CHAT_HANDOFF_MAX_CHARS + 200);
  });

  it('explains an empty history instead of emitting nothing', () => {
    const handoff = buildChatHandoff({
      session: fixtureSession(),
      messages: [],
      rotation: 1,
    });
    expect(handoff).toContain('没有可引用的对话内容');
  });

  it('puts the model summary before the recent turns', () => {
    const handoff = buildChatHandoff({
      session: fixtureSession(),
      messages: [fixtureMessage(1, 'user', '最近一句')],
      rotation: 1,
      summary: '目标：改登录页。决策：用行内文案。待办：补测试。',
    });
    const summaryAt = handoff.indexOf('此前摘要');
    const turnsAt = handoff.indexOf('- 用户：最近一句');
    expect(summaryAt).toBeGreaterThan(-1);
    expect(turnsAt).toBeGreaterThan(summaryAt);
  });
});

describe('shouldSummarizeChatContext', () => {
  const now = 1_000_000;

  it('waits for 60% of the budget', () => {
    expect(
      shouldSummarizeChatContext({
        tokens: 47_999,
        budgetTokens: 80_000,
        now,
      }),
    ).toBe(false);
    expect(
      shouldSummarizeChatContext({
        tokens: 48_000,
        budgetTokens: 80_000,
        now,
      }),
    ).toBe(true);
  });

  it('skips a summary that is still fresh, and rewrites a stale one', () => {
    expect(
      shouldSummarizeChatContext({
        tokens: 60_000,
        budgetTokens: 80_000,
        summaryAt: now - 60_000,
        now,
      }),
    ).toBe(false);
    expect(
      shouldSummarizeChatContext({
        tokens: 60_000,
        budgetTokens: 80_000,
        summaryAt: now - 11 * 60_000,
        now,
      }),
    ).toBe(true);
  });

  it('summarises on demand regardless of usage', () => {
    expect(
      shouldSummarizeChatContext({
        tokens: 10,
        budgetTokens: 80_000,
        summaryAt: now,
        now,
        force: true,
      }),
    ).toBe(true);
  });
});

describe('summarizeChatContext', () => {
  const config = {
    provider: 'openai' as const,
    enabled: true,
    baseUrl: 'https://llm.example/v1',
    apiKey: 'sk-test',
    model: 'cheap-summary-model',
    secondModel: '',
    timeoutMs: 5_000,
    endpoint: '',
    headers: {},
  };

  const messages = [
    fixtureMessage(1, 'user', '把登录页的错误提示改成行内文案'),
    fixtureMessage(2, 'assistant', '已改完，补了校验'),
  ];

  it('returns the model summary', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? '') });
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '目标：改登录页。待办：补测试。' } }],
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const summary = await summarizeChatContext({
      config,
      session: fixtureSession(),
      messages,
      fetchImpl: fakeFetch,
    });

    expect(summary).toContain('待办');
    expect(calls[0]?.url).toBe('https://llm.example/v1/chat/completions');
    expect(calls[0]?.body).toContain('行内文案');
    expect(calls[0]?.body).toContain('cheap-summary-model');
  });

  it('returns null when the provider is not an OpenAI-compatible one', async () => {
    const summary = await summarizeChatContext({
      config: { ...config, provider: 'http' },
      session: fixtureSession(),
      messages,
    });
    expect(summary).toBeNull();
  });

  it('degrades to null on a failed call instead of throwing', async () => {
    const failing = (async () => ({ ok: false })) as unknown as typeof fetch;
    expect(
      await summarizeChatContext({
        config,
        session: fixtureSession(),
        messages,
        fetchImpl: failing,
      }),
    ).toBeNull();

    expect(
      await summarizeChatContext({
        config: { ...config, apiKey: '' },
        session: fixtureSession(),
        messages,
      }),
    ).toBeNull();
  });
});

describe('context rotation over the API', () => {
  async function createSession(): Promise<ChatSession> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: ctx.auth,
      payload: { env: 'company-cursor', title: '上下文轮换' },
    });
    expect(response.statusCode).toBe(201);
    return response.json().session as ChatSession;
  }

  async function send(sessionId: string, content: string): Promise<ChatMessage> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      headers: ctx.auth,
      payload: { content },
    });
    expect(response.statusCode).toBe(201);
    return response.json().message as ChatMessage;
  }

  async function claim(): Promise<{
    session: ChatSession | null;
    message: ChatMessage | null;
    context?: { rotate: boolean; handoff?: string };
  }> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/sessions/next?env=company-cursor&timeout=0',
      headers: ctx.auth,
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function complete(
    sessionId: string,
    messageId: string,
    payload: Record<string, unknown>,
  ): Promise<ChatSession> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages/${messageId}/complete`,
      headers: ctx.auth,
      payload,
    });
    expect(response.statusCode).toBe(200);
    return response.json().session as ChatSession;
  }

  it('charges each turn and rotates once the budget is spent', async () => {
    const created = await createSession();
    const first = await send(created.id, '第一轮：把登录页的错误提示改成行内文案');
    expect((await claim()).message?.id).toBe(first.id);

    const charged = await complete(created.id, first.id, {
      status: 'DONE',
      content: '第一轮答案：已改为行内文案',
      contextUsage: BUDGET + 1_000,
    });
    expect(charged.contextTokens).toBe(BUDGET + 1_000);

    const second = await send(created.id, '第二轮：再补上密码强度校验');
    const rotated = await claim();
    expect(rotated.message?.id).toBe(second.id);
    expect(rotated.context?.rotate).toBe(true);
    expect(rotated.context?.handoff).toContain('第一轮：把登录页的错误提示改成行内文案');
    expect(rotated.context?.handoff).toContain('第 1 次');
    // The next native session starts from zero with one rotation on record.
    expect(rotated.session?.contextTokens).toBe(0);
    expect(rotated.session?.contextRotations).toBe(1);
  });

  it('keeps the same native session while the budget still has room', async () => {
    const created = await createSession();
    const message = await send(created.id, '轻量一问');
    await claim();
    const charged = await complete(created.id, message.id, {
      status: 'DONE',
      content: '轻量一答',
      contextUsage: 100,
    });
    expect(charged.contextTokens).toBe(100);

    await send(created.id, '再问一句');
    const claimed = await claim();
    expect(claimed.context).toBeUndefined();
    expect(claimed.session?.contextRotations).toBe(0);
  });

  it('rotates after a provider rejects the prompt as too long', async () => {
    const created = await createSession();
    const message = await send(created.id, '超长的一问');
    await claim();
    const failed = await complete(created.id, message.id, {
      status: 'FAILED',
      error: 'prompt is too long: 210000 tokens > 200000 maximum',
    });
    expect(failed.contextRotateRequested).toBe(true);

    await send(created.id, '换一条路继续');
    const claimed = await claim();
    expect(claimed.context?.rotate).toBe(true);
    expect(claimed.session?.contextRotations).toBe(1);
    expect(claimed.session?.contextTokens).toBe(0);
    expect(claimed.session?.contextRotateRequested).toBe(false);
  });

  it('rotates on the next turn when a human asks for it', async () => {
    const created = await createSession();
    const first = await send(created.id, '先聊两句');
    await claim();
    await complete(created.id, first.id, {
      status: 'DONE',
      content: '好的',
      contextUsage: 120,
    });

    const requested = await ctx.app.inject({
      method: 'POST',
      url: `/api/sessions/${created.id}/context/rotate`,
      headers: ctx.auth,
    });
    expect(requested.statusCode).toBe(200);
    expect(requested.json().session.contextRotateRequested).toBe(true);
    // Asking twice is harmless: the flag is idempotent.
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/sessions/${created.id}/context/rotate`,
      headers: ctx.auth,
    });
    expect(again.statusCode).toBe(200);

    await send(created.id, '继续');
    const claimed = await claim();
    expect(claimed.context?.rotate).toBe(true);
    expect(claimed.context?.handoff).toContain('先聊两句');
    expect(claimed.session?.contextRotateRequested).toBe(false);
    expect(claimed.session?.contextRotations).toBe(1);
  });

  it('refuses to rotate a closed session', async () => {
    const created = await createSession();
    const closed = await ctx.app.inject({
      method: 'POST',
      url: `/api/sessions/${created.id}/close`,
      headers: ctx.auth,
    });
    expect(closed.statusCode).toBe(200);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/sessions/${created.id}/context/rotate`,
      headers: ctx.auth,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('SESSION_CLOSED');
  });
});

describe('model summary lifecycle', () => {
  let dir = '';
  let handle: ReturnType<typeof createDatabase>;
  let repo: TicketRepository;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhunzou-chat-summary-'));
    handle = createDatabase(join(dir, 'hub.db'));
    repo = new TicketRepository(handle.db);
  });

  afterAll(() => {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses the stored digest once and forgets it after rotating', () => {
    const created = repo.createChatSession(
      { env: 'company-cursor', title: '摘要会话' },
      1_000,
    );
    const id = Number(created.id);
    repo.sendChatMessage(id, { content: '把登录页改成行内文案' }, 1_100);
    repo.saveChatContextSummary(
      id,
      '目标：改登录页。决策：用行内文案。待办：补测试。',
      2_000,
    );
    expect(repo.getChatSession(id)?.contextSummaryAt).toBe(2_000);

    // A human asked to rotate below the budget; the digest still applies.
    repo.requestChatContextRotation(id, 2_100);
    const rotation = repo.rotateChatContext(id, 80_000, 2_200);
    expect(rotation?.handoff).toContain('此前摘要');
    expect(rotation?.handoff).toContain('目标：改登录页');
    expect(rotation?.session.contextSummaryAt).toBeUndefined();
    expect(repo.getChatSession(id)?.contextSummaryAt).toBeUndefined();

    // Without a summary the next rotation still produces a usable excerpt.
    repo.requestChatContextRotation(id, 2_300);
    const next = repo.rotateChatContext(id, 80_000, 2_400);
    expect(next?.handoff).not.toContain('此前摘要');
    expect(next?.handoff).toContain('把登录页改成行内文案');
  });

  it('drops a digest that a rotation invalidated mid-flight', async () => {
    const created = repo.createChatSession(
      { env: 'company-cursor', title: '竞态会话' },
      3_000,
    );
    const id = Number(created.id);
    repo.sendChatMessage(id, { content: '先聊一句' }, 3_100);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fakeFetch = (async () => {
      await gate;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '这份摘要属于旧会话' } }],
        }),
      } as Response;
    }) as unknown as typeof fetch;

    scheduleChatContextSummary({
      repo,
      config: {
        provider: 'openai',
        enabled: true,
        baseUrl: 'https://llm.example/v1',
        apiKey: 'sk-test',
        model: 'cheap-summary-model',
        secondModel: '',
        timeoutMs: 5_000,
        endpoint: '',
        headers: {},
      },
      budgetTokens: 80_000,
      sessionId: id,
      force: true,
      fetchImpl: fakeFetch,
    });

    // The runner rotates while the model is still writing.
    repo.requestChatContextRotation(id, 3_150);
    repo.rotateChatContext(id, 80_000, 3_200);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const after = repo.getChatSession(id);
    expect(after?.contextSummaryAt).toBeUndefined();
    expect(after?.contextRotations).toBe(1);
  });
});
