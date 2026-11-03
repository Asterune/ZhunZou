import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  ChatEvent,
  ChatMessage,
  ChatMessageResponse,
  ChatSession,
  CompleteChatMessageInput,
  NextChatMessageResponse,
} from '@zhunzou/shared';

import type { HubApi } from '../src/hub-client.js';
import { parseChatOutput, runSessionDaemon } from '../src/session.js';
import { loadWakeConfig } from '../src/wake/config.js';
import { testConfig } from './helpers.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-session-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const session: ChatSession = {
  id: '1',
  env: 'company-cursor',
  title: '测试会话',
  status: 'ACTIVE',
  createdAt: 1,
  updatedAt: 1,
};

const message: ChatMessage = {
  id: '2',
  sessionId: '1',
  role: 'user',
  content: 'hello',
  status: 'RUNNING',
  createdAt: 1,
  updatedAt: 1,
};

interface Calls {
  events: Array<{ stream: string; chunk: string }>;
  completions: Array<CompleteChatMessageInput>;
}

function makeClient(calls: Calls): HubApi {
  let polls = 0;
  return {
    async nextChatMessage(): Promise<NextChatMessageResponse> {
      polls += 1;
      return polls === 1
        ? { session, message, timedOut: false }
        : { session: null, message: null, timedOut: true };
    },
    async appendChatEvent(_sessionId, _messageId, input): Promise<ChatEvent> {
      calls.events.push(input);
      return {
        id: calls.events.length,
        sessionId: '1',
        messageId: '2',
        stream: input.stream,
        chunk: input.chunk,
        createdAt: 1,
      };
    },
    async completeChatMessage(
      _sessionId,
      _messageId,
      input,
    ): Promise<ChatMessageResponse> {
      calls.completions.push(input);
      return {
        session: { ...session, externalId: input.externalId },
        message: { ...message, status: input.status },
      };
    },
  } as unknown as HubApi;
}

describe('parseChatOutput', () => {
  it('reads Cursor/Claude JSON output and session ids', () => {
    const parsed = parseChatOutput(
      JSON.stringify({ result: '答案是 42', session_id: 'chat-1' }),
    );
    expect(parsed).toEqual({ content: '答案是 42', externalId: 'chat-1' });
  });

  it('falls back to raw text', () => {
    expect(parseChatOutput('plain output\n').content).toBe('plain output');
  });
});

describe('runSessionDaemon', () => {
  it('runs one message, streams output and completes it', async () => {
    const dir = tempDir();
    const calls: Calls = { events: [], completions: [] };
    const wake = loadWakeConfig(
      {
        ZHUNZOU_WAKE_ADAPTER: 'command',
        ZHUNZOU_WAKE_COMMAND: 'echo {message}',
      },
      dir,
    );

    const code = await runSessionDaemon({
      client: makeClient(calls),
      hub: testConfig({ agentEnv: 'company-cursor', projectName: 'demo' }),
      wake,
      once: true,
      stdout: () => undefined,
      stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(calls.completions).toHaveLength(1);
    expect(calls.completions[0]).toMatchObject({ status: 'DONE' });
    expect(calls.completions[0]?.content).toContain('hello');
    expect(calls.completions[0]?.externalId).toBeTruthy();
    expect(calls.events.map((event) => event.stream)).toContain('system');
  });

  it('skips adapters that cannot resume a session', async () => {
    const dir = tempDir();
    const calls: Calls = { events: [], completions: [] };
    const wake = loadWakeConfig({ ZHUNZOU_WAKE_ADAPTER: 'gemini' }, dir);
    const errors: string[] = [];

    const code = await runSessionDaemon({
      client: makeClient(calls),
      hub: testConfig(),
      wake,
      once: true,
      stdout: () => undefined,
      stderr: (line) => errors.push(line),
    });

    expect(code).toBe(0);
    expect(calls.completions).toHaveLength(0);
    expect(errors.join('')).toContain('不支持交互式会话');
  });
});
