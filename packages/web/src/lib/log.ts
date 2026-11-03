/** One chunk of streamed output shown by the log viewer. */
export interface LogEntry {
  id: number;
  stream: 'stdout' | 'stderr' | 'system';
  chunk: string;
}
