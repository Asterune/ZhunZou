/**
 * Batched log shipping shared by task execution and interactive sessions.
 *
 * Network failures must never fail the work item: transient errors requeue
 * the chunk for the next flush, permanent ones drop it, and everything is
 * downgraded to a single warning. Chunks are split to fit the API's 16 KB
 * limit, and the buffer is capped so a long outage cannot grow unbounded.
 */

import { HubApiError } from '../hub-client.js';
import type { LogChunkMeta, LogSanitizer } from '../sanitizer/log-sanitizer.js';

export type LogStream = 'stdout' | 'stderr' | 'system';

export interface LogSink {
  /**
   * `meta` states a fact about this exact text that the sanitizer cannot know
   * — a worktree fingerprint, say — so the chunk ships with it verbatim.
   */
  push: (stream: LogStream, chunk: string, meta?: LogChunkMeta) => void;
  close: () => Promise<void>;
}

export interface LogSinkOptions {
  /** Rewrites the bytes before they ship; see `sanitizer/log-sanitizer.ts`. */
  sanitizer?: LogSanitizer;
}

interface Segment {
  text: string;
  /** Absent means "describe this block with the sanitizer" — the common case. */
  meta?: LogChunkMeta;
}

const FLUSH_INTERVAL_MS = 600;
const CHUNK_BYTES = 12_000;
const BUFFER_BYTES = 24_000;
const MAX_BUFFER_BYTES = 1_000_000;

const STREAMS = ['stdout', 'stderr', 'system'] as const;

export function createLogSink(
  send: (stream: LogStream, chunk: string, meta: LogChunkMeta) => Promise<unknown>,
  onError: (message: string) => void,
  options: LogSinkOptions = {},
): LogSink {
  const sanitizer = options.sanitizer;
  const segments: Record<LogStream, Segment[]> = {
    stdout: [],
    stderr: [],
    system: [],
  };
  let flushing = false;
  let closed = false;
  let warned = false;

  const warnOnce = (message: string): void => {
    if (warned) return;
    warned = true;
    onError(message);
  };

  const bytesOf = (stream: LogStream): number =>
    segments[stream].reduce((total, segment) => total + segment.text.length, 0);

  const append = (stream: LogStream, text: string, meta?: LogChunkMeta): void => {
    if (!text) return;
    const list = segments[stream];
    const last = list[list.length - 1];
    // Plain text keeps joining into one block; a block with its own metadata
    // stays separate, so the fact never lands on somebody else's output.
    if (!meta && last && !last.meta) last.text += text;
    else list.push(meta ? { text, meta } : { text });
  };

  const prepend = (stream: LogStream, text: string): void => {
    if (!text) return;
    const list = segments[stream];
    const first = list[0];
    if (first && !first.meta) first.text = text + first.text;
    else list.unshift({ text });
  };

  const trim = (stream: LogStream): void => {
    let drop = bytesOf(stream) - MAX_BUFFER_BYTES;
    if (drop <= 0) return;
    const list = segments[stream];
    while (drop > 0 && list.length > 0) {
      const first = list[0]!;
      if (first.text.length <= drop) {
        drop -= first.text.length;
        list.shift();
      } else {
        first.text = first.text.slice(drop);
        drop = 0;
      }
    }
    warnOnce('日志缓冲超过上限，已丢弃最旧内容');
  };

  const take = (): Array<{ stream: LogStream; chunk: string; meta: LogChunkMeta }> => {
    const chunks: Array<{ stream: LogStream; chunk: string; meta: LogChunkMeta }> = [];
    for (const stream of STREAMS) {
      // A sanitizer holds the last line of a run until the run ends; a flush
      // is the hub asking what happened, so ask the sanitizer instead.
      const held = sanitizer?.settle(stream);
      if (held) append(stream, held);
      const pending = segments[stream];
      segments[stream] = [];
      for (const segment of pending) {
        for (let index = 0; index < segment.text.length; index += CHUNK_BYTES) {
          const chunk = segment.text.slice(index, index + CHUNK_BYTES);
          chunks.push({
            stream,
            chunk,
            meta: segment.meta ?? sanitizer?.describe(chunk) ?? {},
          });
        }
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
            await send(item.stream, item.chunk, item.meta);
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
            for (const stream of STREAMS) {
              prepend(stream, requeue[stream]);
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
    push(stream, chunk, meta) {
      if (closed || !chunk) return;
      // Text the caller labelled is already final; the sanitizer's job is to
      // make unlabelled terminal noise safe to ship.
      const text = meta ? chunk : sanitizer ? sanitizer.feed(stream, chunk) : chunk;
      if (!text) return;
      append(stream, text, meta);
      trim(stream);
      if (bytesOf(stream) >= BUFFER_BYTES) {
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