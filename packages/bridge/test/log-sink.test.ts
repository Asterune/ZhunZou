import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HubApiError } from '../src/hub-client.js';
import type { LogChunkMeta, LogSanitizer } from '../src/sanitizer/log-sanitizer.js';
import { createLogSink, type LogStream } from '../src/wake/log-sink.js';

describe('createLogSink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ships buffered output in stream order on close', async () => {
    const sent: Array<{ stream: LogStream; chunk: string }> = [];
    const sink = createLogSink(async (stream, chunk) => {
      sent.push({ stream, chunk });
    }, () => {});

    sink.push('stdout', 'hello ');
    sink.push('stderr', 'warn');
    sink.push('stdout', 'world');
    await sink.close();

    expect(sent).toEqual([
      { stream: 'stdout', chunk: 'hello world' },
      { stream: 'stderr', chunk: 'warn' },
    ]);
  });

  it('splits large buffers into API-sized chunks', async () => {
    const sent: string[] = [];
    const sink = createLogSink(async (_stream, chunk) => {
      sent.push(chunk);
    }, () => {});

    sink.push('stdout', 'x'.repeat(25_000));
    await sink.close();
    await vi.advanceTimersByTimeAsync(600);

    expect(sent).toEqual([
      'x'.repeat(12_000),
      'x'.repeat(12_000),
      'x'.repeat(1_000),
    ]);
  });

  it('requeues after a transient failure and retries in order', async () => {
    const sent: string[] = [];
    const errors: string[] = [];
    let fail = true;
    const sink = createLogSink(async (_stream, chunk) => {
      if (fail) {
        fail = false;
        throw new HubApiError(0, 'NETWORK', 'connection reset');
      }
      sent.push(chunk);
    }, (message) => errors.push(message));

    sink.push('stdout', 'hello');
    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('重试');

    sink.push('stdout', ' world');
    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toEqual(['hello world']);
    await sink.close();
  });

  it('keeps per-stream order when a mid-flush failure requeues the rest', async () => {
    const sent: Array<[LogStream, string]> = [];
    let calls = 0;
    const sink = createLogSink(async (stream, chunk) => {
      calls += 1;
      if (calls === 2) throw new HubApiError(503, 'UNAVAILABLE', 'hub restarting');
      sent.push([stream, chunk]);
    }, () => {});

    sink.push('stdout', 'a'.repeat(12_000));
    sink.push('stdout', 'b');
    sink.push('stderr', 'e');
    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toEqual([['stdout', 'a'.repeat(12_000)]]);

    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toEqual([
      ['stdout', 'a'.repeat(12_000)],
      ['stdout', 'b'],
      ['stderr', 'e'],
    ]);
    await sink.close();
  });

  it('drops permanently rejected chunks and keeps shipping the rest', async () => {
    const sent: string[] = [];
    const errors: string[] = [];
    let calls = 0;
    const sink = createLogSink(async (_stream, chunk) => {
      calls += 1;
      if (calls === 1) {
        throw new HubApiError(409, 'INVALID_TASK_STATUS', 'task is not claimed');
      }
      sent.push(chunk);
    }, (message) => errors.push(message));

    sink.push('stdout', 'x'.repeat(12_000));
    sink.push('stdout', 'kept');
    await sink.close();

    expect(sent).toEqual(['kept']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('丢弃');
  });

  it('caps the buffer by dropping the oldest output', async () => {
    const sent: string[] = [];
    const errors: string[] = [];
    const sink = createLogSink(async (_stream, chunk) => {
      sent.push(chunk);
    }, (message) => errors.push(message));

    sink.push('stdout', 'a'.repeat(100_000) + 'b'.repeat(1_000_000));
    await sink.close();
    await vi.advanceTimersByTimeAsync(600);

    expect(sent.join('')).toBe('b'.repeat(1_000_000));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('上限');
  });

  /**
   * The sanitizer is the one place the hub stops receiving raw terminal
   * bytes, so these cases pin what it is handed and when. The stub is a stub
   * on purpose: the rules themselves are tested in `sanitizer-*.test.ts`.
   */
  describe('with a sanitizer', () => {
    interface Shipped {
      stream: LogStream;
      chunk: string;
      meta: LogChunkMeta;
    }

    function stubSanitizer(options: {
      feed?: (stream: LogStream, chunk: string) => string;
      settle?: (stream: LogStream) => string;
      describe?: (chunk: string) => LogChunkMeta;
    } = {}): LogSanitizer & { calls: string[] } {
      const calls: string[] = [];
      return {
        calls,
        feed: (stream, chunk) => {
          calls.push(`feed:${stream}`);
          return options.feed ? options.feed(stream, chunk) : chunk;
        },
        settle: (stream) => {
          calls.push(`settle:${stream}`);
          return options.settle ? options.settle(stream) : '';
        },
        describe: (chunk) => {
          calls.push('describe');
          return options.describe ? options.describe(chunk) : {};
        },
        summarize: () => '',
      };
    }

    it('ships what the sanitizer returns, not the raw bytes (S2)', async () => {
      const sent: Shipped[] = [];
      const sanitizer = stubSanitizer({ feed: (_stream, chunk) => chunk.toUpperCase() });
      const sink = createLogSink(
        async (stream, chunk, meta) => {
          sent.push({ stream, chunk, meta });
        },
        () => {},
        { sanitizer },
      );

      sink.push('stdout', 'hello world\n');
      await sink.close();

      expect(sent).toEqual([{ stream: 'stdout', chunk: 'HELLO WORLD\n', meta: {} }]);
    });

    it('signs only the blocks that hold an error (S3)', async () => {
      const sent: Shipped[] = [];
      const sanitizer = stubSanitizer({
        describe: (chunk) => (chunk.includes('boom') ? { errorSignature: 'Error: boom' } : {}),
      });
      const sink = createLogSink(
        async (stream, chunk, meta) => {
          sent.push({ stream, chunk, meta });
        },
        () => {},
        { sanitizer },
      );

      sink.push('stdout', 'building\n');
      sink.push('stderr', 'boom\n');
      await sink.close();

      expect(sent).toEqual([
        { stream: 'stdout', chunk: 'building\n', meta: {} },
        { stream: 'stderr', chunk: 'boom\n', meta: { errorSignature: 'Error: boom' } },
      ]);
    });

    it('releases what the sanitizer was still holding before shipping (S4)', async () => {
      const sent: string[] = [];
      /** A real sanitizer lets go of a held line once, not on every flush. */
      const held: Record<string, string> = {};
      const sanitizer = stubSanitizer({
        feed: (stream) => {
          held[stream] = `${stream}-tail`;
          return '';
        },
        settle: (stream) => {
          const text = held[stream] ?? '';
          held[stream] = '';
          return text;
        },
      });
      const sink = createLogSink(
        async (_stream, chunk) => {
          sent.push(chunk);
        },
        () => {},
        { sanitizer },
      );

      sink.push('stdout', 'nothing settled yet');
      await vi.advanceTimersByTimeAsync(600);
      expect(sent).toEqual(['stdout-tail']);

      sink.push('stderr', 'x');
      await sink.close();
      expect(sent).toEqual(['stdout-tail', 'stderr-tail']);
      expect(sanitizer.calls.filter((call) => call === 'settle:stdout').length).toBeGreaterThan(0);
    });

    it('signs each slice of a large buffer by its own content (S5)', async () => {
      const sent: Shipped[] = [];
      const sanitizer = stubSanitizer({
        describe: (chunk) => (chunk.includes('boom') ? { errorSignature: 'Error: boom' } : {}),
      });
      const sink = createLogSink(
        async (stream, chunk, meta) => {
          sent.push({ stream, chunk, meta });
        },
        () => {},
        { sanitizer },
      );

      sink.push('stdout', `${'x'.repeat(12_000)}boom`);
      await sink.close();

      expect(sent.map((item) => item.chunk.length)).toEqual([12_000, 4]);
      expect(sent.map((item) => item.meta)).toEqual([{}, { errorSignature: 'Error: boom' }]);
    });

    it('re-signs a chunk that had to be sent again (S6)', async () => {
      const sent: Shipped[] = [];
      let fail = true;
      const sanitizer = stubSanitizer({
        describe: (chunk) => (chunk.includes('boom') ? { errorSignature: 'Error: boom' } : {}),
      });
      const sink = createLogSink(
        async (stream, chunk, meta) => {
          if (fail) {
            fail = false;
            throw new HubApiError(0, 'NETWORK', 'connection reset');
          }
          sent.push({ stream, chunk, meta });
        },
        () => {},
        { sanitizer },
      );

      sink.push('stderr', 'boom\n');
      await vi.advanceTimersByTimeAsync(600);
      expect(sent).toEqual([]);

      await vi.advanceTimersByTimeAsync(600);
      expect(sent).toEqual([
        { stream: 'stderr', chunk: 'boom\n', meta: { errorSignature: 'Error: boom' } },
      ]);
      await sink.close();
    });
  });
});