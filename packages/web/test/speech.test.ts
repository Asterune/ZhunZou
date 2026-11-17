import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendTranscript,
  speechLocale,
  speechSupported,
  startVoiceRecognition,
  type VoiceErrorEventLike,
  type VoiceResultEventLike,
  type VoiceResultListLike,
} from '../src/lib/speech';

function resultList(
  rows: Array<{ text: string; final: boolean }>,
): VoiceResultListLike {
  const list: Array<Record<number, { transcript: string }> & { isFinal: boolean }> = [];
  for (const row of rows) {
    list.push(Object.assign({ 0: { transcript: row.text }, isFinal: row.final }));
  }
  return Object.assign(list, { length: list.length }) as unknown as VoiceResultListLike;
}

function event(rows: Array<{ text: string; final: boolean }>): VoiceResultEventLike {
  return { resultIndex: 0, results: resultList(rows) };
}

class FakeRecognition {
  static last: FakeRecognition | null = null;

  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onresult: ((value: VoiceResultEventLike) => void) | null = null;
  onerror: ((value: VoiceErrorEventLike) => void) | null = null;
  onend: (() => void) | null = null;
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;

  constructor() {
    FakeRecognition.last = this;
  }

  start(): void {
    this.startCalls += 1;
    this.onstart?.();
  }

  stop(): void {
    this.stopCalls += 1;
    this.onend?.();
  }

  abort(): void {
    this.abortCalls += 1;
    this.onend?.();
  }

  emit(value: VoiceResultEventLike): void {
    this.onresult?.(value);
  }

  fail(code: string): void {
    this.onerror?.({ error: code });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeRecognition.last = null;
  vi.useRealTimers();
});

describe('appendTranscript', () => {
  it('keeps an empty box honest', () => {
    expect(appendTranscript('', '  ')).toBe('');
  });

  it('joins Chinese without inserting a space', () => {
    expect(appendTranscript('帮我看看', '登录页')).toBe('帮我看看登录页');
  });

  it('separates Latin words', () => {
    expect(appendTranscript('check the', 'login page')).toBe(
      'check the login page',
    );
  });

  it('respects an explicit newline', () => {
    expect(appendTranscript('第一步\n', '第二步')).toBe('第一步\n第二步');
  });
});

describe('speechLocale', () => {
  it('maps the dashboard locale to a recognizer tag', () => {
    expect(speechLocale('zh')).toBe('zh-CN');
    expect(speechLocale('en')).toBe('en-US');
  });
});

describe('speechSupported', () => {
  it('accepts the standard and the Safari-prefixed constructor', () => {
    expect(speechSupported({})).toBe(false);
    expect(speechSupported({ SpeechRecognition: class {} })).toBe(true);
    expect(speechSupported({ webkitSpeechRecognition: class {} })).toBe(true);
  });
});

describe('startVoiceRecognition', () => {
  it('streams interim text and hands back the final transcript on stop', () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    const seen: string[] = [];
    const ends: string[] = [];

    const session = startVoiceRecognition('zh', {
      onTranscript: (text) => seen.push(text),
      onError: () => undefined,
      onEnd: (text) => ends.push(text),
    });

    const recognizer = FakeRecognition.last;
    expect(recognizer).not.toBeNull();
    expect(recognizer?.lang).toBe('zh-CN');
    expect(recognizer?.continuous).toBe(true);
    expect(session).not.toBeNull();

    recognizer?.emit(event([{ text: '帮我看看', final: false }]));
    recognizer?.emit(event([{ text: '帮我看看登录页', final: true }]));
    session?.stop();

    expect(seen).toEqual(['帮我看看', '帮我看看登录页']);
    expect(ends).toEqual(['帮我看看登录页']);
  });

  it('reports permission failures without treating abort as an error', () => {
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    const errors: string[] = [];

    const session = startVoiceRecognition('en', {
      onTranscript: () => undefined,
      onError: (code) => errors.push(code),
      onEnd: () => undefined,
    });

    FakeRecognition.last?.fail('not-allowed');
    FakeRecognition.last?.fail('aborted');
    session?.abort();

    expect(errors).toEqual(['not-allowed']);
  });

  it('returns null when the browser has no recognizer', () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', undefined);
    expect(
      startVoiceRecognition('zh', {
        onTranscript: () => undefined,
        onError: () => undefined,
        onEnd: () => undefined,
      }),
    ).toBeNull();
  });
});
