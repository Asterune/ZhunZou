/**
 * Batched log shipping shared by task execution and interactive sessions.
 *
 * Network failures must never fail the work item, so errors are downgraded to
 * a single warning. Chunks are split to fit the API's 16 KB limit.
 */

export type LogStream = 'stdout' | 'stderr' | 'system';

export interface LogSink {
  push: (stream: LogStream, chunk: string) => void;
  close: () => Promise<void>;
}

const FLUSH_INTERVAL_MS = 600;
const CHUNK_BYTES = 12_000;
const BUFFER_BYTES = 24_000;

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
        for (const item of chunks) {
          try {
            await send(item.stream, item.chunk);
          } catch (error) {
            if (!warned) {
              warned = true;
              onError(`日志上报失败：${(error as Error).message}`);
            }
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
