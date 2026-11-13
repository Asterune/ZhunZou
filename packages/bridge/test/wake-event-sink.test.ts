import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineEventInput } from '@zhunzou/shared';

import { HubApiError } from '../src/hub-client.js';
import { createEventSink } from '../src/wake/event-sink.js';

function event(index: number): EngineEventInput {
  return { kind: 'tool_call', tool: `tool-${index}` };
}

describe('createEventSink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ships the queue in order on close', async () => {
    const sent: EngineEventInput[][] = [];
    const sink = createEventSink(async (events) => {
      sent.push(events);
    }, () => {});

    for (let index = 0; index < 20; index += 1) sink.push(event(index));
    await sink.close();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(20);
    expect(sent[0]![0]).toEqual(event(0));
    expect(sent[0]![19]).toEqual(event(19));
  });

  it('flushes a partial queue on the timer', async () => {
    const sent: EngineEventInput[][] = [];
    const sink = createEventSink(async (events) => {
      sent.push(events);
    }, () => {});

    sink.push(event(1));
    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toEqual([[event(1)]]);

    await sink.close();
    expect(sent).toHaveLength(1);
  });

  it('never ships a batch larger than one request allows', async () => {
    const sent: EngineEventInput[] = [];
    const sizes: number[] = [];
    const sink = createEventSink(async (events) => {
      sizes.push(events.length);
      sent.push(...events);
    }, () => {});

    for (let index = 0; index < 60; index += 1) sink.push(event(index));
    await sink.close();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(Math.max(...sizes)).toBeLessThanOrEqual(50);
    expect(sent).toHaveLength(60);
    expect(new Set(sent.map((entry) => entry.tool)).size).toBe(60);
  });

  it('requeues after a transient failure and retries in order', async () => {
    const sent: EngineEventInput[] = [];
    const errors: string[] = [];
    let fail = true;
    const sink = createEventSink(async (events) => {
      if (fail) {
        fail = false;
        throw new HubApiError(0, 'NETWORK', 'connection reset');
      }
      sent.push(...events);
    }, (message) => errors.push(message));

    sink.push(event(1));
    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('重试');

    sink.push(event(2));
    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toEqual([event(1), event(2)]);
    await sink.close();
  });

  it('drops a batch the hub refused instead of retrying forever', async () => {
    const calls: EngineEventInput[][] = [];
    const errors: string[] = [];
    const sink = createEventSink(async (events) => {
      calls.push(events);
      throw new HubApiError(409, 'INVALID_TASK_STATUS', 'task is DONE');
    }, (message) => errors.push(message));

    sink.push(event(1));
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toHaveLength(1);
    expect(errors[0]).toContain('已丢弃');

    await vi.advanceTimersByTimeAsync(6_000);
    expect(calls).toHaveLength(1);
    await sink.close();
  });

  it('caps the queue, keeps the newest events, and warns once', async () => {
    const sent: EngineEventInput[] = [];
    const errors: string[] = [];
    const sink = createEventSink(async (events) => {
      sent.push(...events);
    }, (message) => errors.push(message));

    for (let index = 0; index < 260; index += 1) sink.push(event(index));
    await sink.close();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(sent.length).toBeLessThan(260);
    expect(sent).toContainEqual(event(259));
    expect(errors.filter((line) => line.includes('超过上限'))).toHaveLength(1);
  });

  it('never lets a reporting failure reach the caller', async () => {
    const sink = createEventSink(async () => {
      throw new Error('boom');
    }, () => {});

    expect(() => sink.push(event(1))).not.toThrow();
    await vi.advanceTimersByTimeAsync(600);
    await expect(sink.close()).resolves.toBeUndefined();
  });

  it('ignores events after close', async () => {
    const sent: EngineEventInput[][] = [];
    const sink = createEventSink(async (events) => {
      sent.push(events);
    }, () => {});

    sink.push(event(1));
    await sink.close();
    sink.push(event(2));
    await vi.advanceTimersByTimeAsync(6_000);

    expect(sent.flat()).toEqual([event(1)]);
  });
});
