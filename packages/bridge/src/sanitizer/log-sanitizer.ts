/**
 * Streaming noise reduction for the bytes a task ships to the hub.
 *
 * Three rules, and one reason each. An escape sequence is an instruction, so
 * it is dropped — but it may be split across chunks, so a fragment is carried.
 * A line the CLI rewrote with a carriage return was never meant to be read
 * twice, so only its last frame ships. A line repeated in a run is one event,
 * so it ships once with its count — except an error line, which is never
 * folded, because two faults that look alike are still two faults.
 *
 * What survives is what the hub stores; the person at the terminal keeps the
 * original bytes, and the live pty mirror keeps them too.
 */

import {
  DIAGNOSIS_CHARS,
  MAX_SIGNATURES,
  buildDiagnosis,
  combineSignatures,
  extractErrors,
  looksLikeError,
} from './errors.js';
import { progressKey } from './progress.js';
import { sanitizeAnsi } from './ansi.js';
import type { ErrorFinding } from './errors.js';
import type { LogStream } from '../wake/log-sink.js';

/** An endless line must not hold the log hostage: resynchronise past it. */
export const MAX_HELD_BYTES = 8 * 1024;
/** Neither may an escape sequence that never ends: it was never text. */
export const MAX_ESCAPE_BYTES = 64;
/** Distinct faults kept for the diagnosis; the count keeps going regardless. */
export const MAX_FINDINGS = 40;
const RECENT_LINES = 15;
const LINE_CHARS = 200;

export interface LogChunkMeta {
  errorSignature?: string;
  /**
   * Worktree fingerprint, reported by the node that owns the checkout. The
   * sanitizer never fills it in — only a caller that looked at git does.
   */
  diffHash?: string;
}

export interface LogSanitizer {
  /** Rewrites raw bytes; returns only the lines that can no longer change. */
  feed: (stream: LogStream, chunk: string) => string;
  /** Gives back what the streaming rules were still holding for this stream. */
  settle: (stream: LogStream) => string;
  /** Names the faults inside one block of text, for the row that carries it. */
  describe: (chunk: string) => LogChunkMeta;
  /** The whole run in one dense block, for a task's result. */
  summarize: () => string;
}

export interface LogSanitizerOptions {
  heldBytes?: number;
  diagnosisChars?: number;
}

interface Episode {
  key: string;
  line: string;
  count: number;
  terminated: boolean;
}

interface StreamState {
  /** A trailing escape sequence whose final byte has not arrived yet. */
  fragment: string;
  frame: string;
  lastFrame: string;
  episode: Episode;
}

const noEpisode = (): Episode => ({ key: '', line: '', count: 0, terminated: true });

function freshState(): StreamState {
  return { fragment: '', frame: '', lastFrame: '', episode: noEpisode() };
}

export function createLogSanitizer(options: LogSanitizerOptions = {}): LogSanitizer {
  const heldBytes = options.heldBytes ?? MAX_HELD_BYTES;
  const limit = options.diagnosisChars ?? DIAGNOSIS_CHARS;
  const states = new Map<LogStream, StreamState>();

  const findings: ErrorFinding[] = [];
  const signatures = new Set<string>();
  const recent: string[] = [];
  let observed = 0;

  /** The run-level memory of what went wrong, fed by settled text only. */
  const note = (text: string): void => {
    const found = extractErrors(text);
    observed += found.length;
    for (const finding of found) {
      if (signatures.has(finding.signature)) continue;
      signatures.add(finding.signature);
      if (findings.length < MAX_FINDINGS) findings.push(finding);
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      recent.push(trimmed.length > LINE_CHARS ? `${trimmed.slice(0, LINE_CHARS)}…` : trimmed);
      if (recent.length > RECENT_LINES) recent.shift();
    }
  };

  return {
    feed(stream, chunk) {
      if (!chunk) return '';
      const state = states.get(stream) ?? freshState();
      states.set(stream, state);

      const split = sanitizeAnsi(state.fragment + chunk);
      state.fragment = split.pending.length > MAX_ESCAPE_BYTES ? '' : split.pending;

      const out: string[] = [];
      for (const char of split.text) {
        if (char === '\n') {
          out.push(...closeLine(state, takeLine(state), true));
          continue;
        }
        if (char === '\r') {
          if (state.frame) {
            state.lastFrame = state.frame;
            state.frame = '';
          }
          continue;
        }
        state.frame += char;
        if (state.frame.length > heldBytes) {
          out.push(...closeLine(state, takeFrame(state), false));
        }
      }

      const text = out.join('');
      if (text && stream !== 'system') note(text);
      return text;
    },

    settle(stream) {
      const state = states.get(stream);
      if (!state) return '';
      const text = closeLine(state, takeLine(state), false).join('');
      if (text && stream !== 'system') note(text);
      return text;
    },

    describe(chunk) {
      const signature = combineSignatures(extractErrors(chunk), { max: MAX_SIGNATURES });
      return signature ? { errorSignature: signature } : {};
    },

    summarize() {
      const diagnosis = buildDiagnosis(findings, { limit, total: observed });
      if (diagnosis) return diagnosis;
      const tail = recent.join('\n');
      return tail.length > limit ? tail.slice(0, limit) : tail;
    },
  };

  /** A line that can no longer be rewritten: fold it in, or hand it out. */
  function closeLine(state: StreamState, line: string, terminated: boolean): string[] {
    if (!line.trim()) return finishEpisode(state);
    const foldable = terminated && !looksLikeError(line);
    const key = foldable ? progressKey(line) : '';
    const episode = state.episode;
    if (key && episode.key === key) {
      state.episode = { ...episode, line, count: episode.count + 1, terminated };
      return [];
    }
    const settled = finishEpisode(state);
    if (!key) return [...settled, `${line}${terminated ? '\n' : ''}`];
    state.episode = { key, line, count: 1, terminated };
    return settled;
  }

  function finishEpisode(state: StreamState): string[] {
    const { key, line, count, terminated } = state.episode;
    state.episode = noEpisode();
    if (!key || count === 0) return [];
    const text = count > 1 ? `${line}（重复 ${count} 次）` : line;
    return [terminated ? `${text}\n` : text];
  }

  /** The line a newline ended: whatever survived the last carriage return. */
  function takeLine(state: StreamState): string {
    const line = state.frame || state.lastFrame;
    state.frame = '';
    state.lastFrame = '';
    return line;
  }

  /** The half-line the length guard gave up waiting for, and its history. */
  function takeFrame(state: StreamState): string {
    const frame = state.frame;
    state.frame = '';
    state.lastFrame = '';
    return frame;
  }
}
