import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HubApiError } from '../src/hub-client.js';
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
});