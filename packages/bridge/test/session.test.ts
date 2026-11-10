import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChatEvent,
  ChatMessage,
  ChatMessageResponse,
  ChatSession,
  CompleteChatMessageInput,
  NextChatMessageResponse,
} from '@zhunzou/shared';

import { HubApiError, type HubApi } from '../src/hub-client.js';
import { RunnerState } from '../src/runner-state.js';
import { openCodeSessionId, parseChatOutput, runSessionDaemon, supportsChat } from '../src/session.js';
import { loadWakeConfig } from '../src/wake/config.js';
import { testConfig } from './helpers.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-session-'));
  dirs.push(dir);
  return dir;
}

/** Keeps the loops under test out of the real ~/.zhunzou. */
function runnerState(dir: string, env = 'company-cursor'): RunnerState {
  return new RunnerState(env, { dir });
}

afterEach(() => {
  vi.unstubAllEnvs();
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
  runnerIds?: string[];
}

function makeClient(calls: Calls): HubApi {
  let polls = 0;
  return {
    async nextChatMessage(
      _timeoutMs?: number,
      runnerId?: string,
    ): Promise<NextChatMessageResponse> {
      (calls.runnerIds ??= []).push(runnerId ?? '');
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

describe('openCodeSessionId', () => {
  it('produces ids OpenCode accepts', () => {
    const id = openCodeSessionId();
    expect(id).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(openCodeSessionId()).not.toBe(id);
  });
});

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

describe('supportsChat', () => {
  it('treats qoder as resumable', () => {
    const wake = loadWakeConfig({ ZHUNZOU_WAKE_ADAPTER: 'qoder' }, '/tmp');
    expect(supportsChat(wake)).toBe(true);
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
      state: runnerState(dir),
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
    // The hub uses this id to detect that the previous runner died.
    expect(calls.runnerIds).toHaveLength(1);
    expect(calls.runnerIds?.[0]).toBeTruthy();
  });

  // A real executable is spawned without a shell; .cmd needs a shell on
  // Windows, so this end-to-end check runs on POSIX only.
  it.skipIf(process.platform === 'win32')(
    'runs a qoder turn and keeps the CLI session id for resume',
    async () => {
      const dir = tempDir();
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const fake = join(bin, 'qoder');
      writeFileSync(
        fake,
        '#!/bin/sh\necho \'{"result":"qoder 回复","session_id":"q-session-1"}\'\n',
        'utf8',
      );
      chmodSync(fake, 0o755);
      vi.stubEnv('PATH', bin);

      const calls: Calls = { events: [], completions: [] };
      const wake = loadWakeConfig({ ZHUNZOU_WAKE_ADAPTER: 'qoder' }, dir);

      const code = await runSessionDaemon({
        client: makeClient(calls),
        hub: testConfig({ agentEnv: 'company-qoder', projectName: 'demo' }),
        wake,
        state: runnerState(dir, 'company-qoder'),
        once: true,
        stdout: () => undefined,
        stderr: () => undefined,
      });

      expect(code).toBe(0);
      expect(calls.completions).toHaveLength(1);
      expect(calls.completions[0]).toMatchObject({
        status: 'DONE',
        content: 'qoder 回复',
        externalId: 'q-session-1',
      });
    },
  );

  it('retries completion while the hub is restarting', async () => {
    const dir = tempDir();
    const calls: Calls = { events: [], completions: [] };
    const base = makeClient(calls);
    const wake = loadWakeConfig(
      {
        ZHUNZOU_WAKE_ADAPTER: 'command',
        ZHUNZOU_WAKE_COMMAND: 'echo {message}',
      },
      dir,
    );

    let attempts = 0;
    const client = {
      ...base,
      async completeChatMessage(
        sessionId: string,
        messageId: string,
        input: CompleteChatMessageInput,
      ): Promise<ChatMessageResponse> {
        attempts += 1;
        if (attempts < 3) {
          throw new HubApiError(502, 'HTTP_502', 'Bad Gateway');
        }
        return base.completeChatMessage(sessionId, messageId, input);
      },
    } as HubApi;

    const sleeps: number[] = [];
    const code = await runSessionDaemon({
      client,
      hub: testConfig({ agentEnv: 'company-cursor', projectName: 'demo' }),
      wake,
      state: runnerState(dir),
      once: true,
      stdout: () => undefined,
      stderr: () => undefined,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(code).toBe(0);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(calls.completions).toHaveLength(1);
    expect(calls.completions[0]).toMatchObject({ status: 'DONE' });
  });

  it('replays a journaled result after the hub came back', async () => {
    const dir = tempDir();
    const calls: Calls = { events: [], completions: [] };
    const wake = loadWakeConfig(
      {
        ZHUNZOU_WAKE_ADAPTER: 'command',
        ZHUNZOU_WAKE_COMMAND: 'echo {message}',
      },
      dir,
    );

    // Turn 1: the hub is down for the whole retry window, so the finished
    // answer stays in the journal instead of being thrown away.
    const down = {
      ...makeClient(calls),
      completeChatMessage: async () => {
        throw new HubApiError(502, 'HTTP_502', 'Bad Gateway');
      },
    } as unknown as HubApi;
    const first = runnerState(dir);

    await runSessionDaemon({
      client: down,
      hub: testConfig({ agentEnv: 'company-cursor', projectName: 'demo' }),
      wake,
      state: first,
      once: true,
      stdout: () => undefined,
      stderr: () => undefined,
      sleep: async () => undefined,
    });
    expect(calls.completions).toHaveLength(0);
    first.close();

    // Turn 2: the hub lost patience and marked the turn interrupted (a loop
    // that restarts holding unfinished work rotates its runner id, which is
    // what reaps it). The journaled answer still has to land.
    let hubStatus = 'RUNNING';
    const second = runnerState(dir);
    expect(second.runnerId).not.toBe(first.runnerId);

    const http = makeClient(calls);
    // The hub reaped the turn as soon as the new loop re-registered, so by the
    // time the journal is replayed the message is no longer RUNNING.
    hubStatus = 'FAILED';

    const recovered = {
      ...http,
      async completeChatMessage(
        sessionId: string,
        messageId: string,
        input: CompleteChatMessageInput,
      ): Promise<ChatMessageResponse> {
        if (input.force !== true) {
          throw new HubApiError(409, 'INVALID_MESSAGE_STATUS', 'interrupted');
        }
        hubStatus = input.status;
        return http.completeChatMessage(sessionId, messageId, input);
      },
      async nextChatMessage(): Promise<NextChatMessageResponse> {
        return { session: null, message: null, timedOut: true };
      },
    } as unknown as HubApi;

    await runSessionDaemon({
      client: recovered,
      hub: testConfig({ agentEnv: 'company-cursor', projectName: 'demo' }),
      wake,
      state: second,
      once: true,
      stdout: () => undefined,
      stderr: () => undefined,
    });

    expect(hubStatus).toBe('DONE');
    expect(calls.completions).toHaveLength(1);
    expect(calls.completions[0]).toMatchObject({ status: 'DONE', force: true });
    expect(second.pendingCompletions()).toEqual([]);
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
      state: runnerState(dir),
      once: true,
      stdout: () => undefined,
      stderr: (line) => errors.push(line),
    });

    expect(code).toBe(0);
    expect(calls.completions).toHaveLength(0);
    expect(errors.join('')).toContain('不支持交互式会话');
  });
});
