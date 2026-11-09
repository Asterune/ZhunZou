/**
 * Batched log shipping shared by task execution and interactive sessions.
 *
 * Network failures must never fail the work item: transient errors requeue
 * the chunk for the next flush, permanent ones drop it, and everything is
 * downgraded to a single warning. Chunks are split to fit the API's 16 KB
 * limit, and the buffer is capped so a long outage cannot grow unbounded.
 */

import { HubApiError } from '../hub-client.js';

export type LogStream = 'stdout' | 'stderr' | 'system';

export interface LogSink {
  push: (stream: LogStream, chunk: string) => void;
  close: () => Promise<void>;
}

const FLUSH_INTERVAL_MS = 600;
const CHUNK_BYTES = 12_000;
const BUFFER_BYTES = 24_000;
const MAX_BUFFER_BYTES = 1_000_000;

export function createLogSink(
  send: (stream: LogStream, chunk: string) => Promise<unknown>,
  onError: (message: string) => void,
): LogSink {
  const buffers: Record<LogStream, string> = {
    stdout: '',
    stderr: '',
    system: '',
  };
  let flushing = false;
  let closed = false;
  let warned = false;

  const warnOnce = (message: string): void => {
    if (warned) return;
    warned = true;
    onError(message);
  };

  const trim = (stream: LogStream): void => {
    if (buffers[stream].length <= MAX_BUFFER_BYTES) return;
    buffers[stream] = buffers[stream].slice(-MAX_BUFFER_BYTES);
    warnOnce('日志缓冲超过上限，已丢弃最旧内容');
  };

  const take = (): Array<{ stream: LogStream; chunk: string }> => {
    const chunks: Array<{ stream: LogStream; chunk: string }> = [];
    for (const stream of ['stdout', 'stderr', 'system'] as const) {
      const text = buffers[stream];
      if (!text) continue;
      buffers[stream] = '';
      for (let index = 0; index < text.length; index += CHUNK_BYTES) {
        chunks.push({
          stream,
          chunk: text.slice(index, index + CHUNK_BYTES),
        });
      }
    }
    return chunks;
  };

  const flush = async (): Promise<void> => {
    if (flushing) return;
    flushing = true;
    try {
      for (;;) {
        const chunks = take();
        if (chunks.length === 0) return;
        for (let index = 0; index < chunks.length; index += 1) {
          const item = chunks[index]!;
          try {
            await send(item.stream, item.chunk);
          } catch (error) {
            const permanent =
              error instanceof HubApiError && !error.retryable;
            warnOnce(
              permanent
                ? `日志上报被拒绝，已丢弃：${(error as Error).message}`
                : `日志上报失败，稍后重试：${(error as Error).message}`,
            );
            if (permanent) continue;
            // Transient failure: put the failed chunk and everything taken
            // after it back in front of any newer pushes, preserving order.
            const requeue: Record<LogStream, string> = {
              stdout: '',
              stderr: '',
              system: '',
            };
            for (let rest = index; rest < chunks.length; rest += 1) {
              const pending = chunks[rest]!;
              requeue[pending.stream] += pending.chunk;
            }
            for (const stream of ['stdout', 'stderr', 'system'] as const) {
              if (!requeue[stream]) continue;
              buffers[stream] = requeue[stream] + buffers[stream];
              trim(stream);
            }
            return;
          }
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
    push(stream, chunk) {
      if (closed || !chunk) return;
      buffers[stream] += chunk;
      trim(stream);
      if (buffers[stream].length >= BUFFER_BYTES) {
        void flush();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await flush();
    },
  };
}