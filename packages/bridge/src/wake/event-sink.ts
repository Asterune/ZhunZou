import type { EngineEventInput } from '@zhunzou/shared';

import { HubApiError } from '../hub-client.js';

/**
 * Batched event shipping.
 *
 * Same contract as the log sink: reporting structure to the dashboard must
 * never fail the work that produced it. Transient errors keep the batch for
 * the next flush, permanent ones (including a task that already left CLAIMED)
 * are dropped, and everything surfaces as one warning.
 */

export interface EventSink {
  push: (event: EngineEventInput) => void;
  close: () => Promise<void>;
}

const FLUSH_INTERVAL_MS = 600;
const FLUSH_COUNT = 20;
/** Matches `reportTaskEventsSchema.events.max(50)`. */
const MAX_BATCH = 50;
const MAX_QUEUE = 200;

export function createEventSink(
  send: (events: EngineEventInput[]) => Promise<unknown>,
  onError: (message: string) => void,
): EventSink {
  let queue: EngineEventInput[] = [];
  let flushing = false;
  let closed = false;
  let warned = false;

  const warnOnce = (message: string): void => {
    if (warned) return;
    warned = true;
    onError(message);
  };

  const flush = async (): Promise<void> => {
    if (flushing || queue.length === 0) return;
    flushing = true;
    try {
      while (queue.length > 0) {
        const batch = queue.slice(0, MAX_BATCH);
        queue = queue.slice(batch.length);
        try {
          await send(batch);
        } catch (error) {
          const permanent = error instanceof HubApiError && !error.retryable;
          warnOnce(
            permanent
              ? `事件上报被拒绝，已丢弃：${(error as Error).message}`
              : `事件上报失败，稍后重试：${(error as Error).message}`,
          );
          if (permanent) continue;
          // Transient: restore this batch and anything taken after it, oldest
          // first, and try again on the next tick.
          queue = [...batch, ...queue];
          return;
        }
      }
    } finally {
      flushing = false;
    }
  };

  const timer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);
  timer.unref?.();

  return {
    push(event) {
      if (closed) return;
      queue.push(event);
      if (queue.length > MAX_QUEUE) {
        warnOnce('事件缓冲超过上限，已丢弃最旧内容');
        queue = queue.slice(-MAX_QUEUE);
      }
      if (queue.length >= FLUSH_COUNT) void flush();
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await flush();
    },
  };
}
