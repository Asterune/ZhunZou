/**
 * Auto-handover judgement for `zz run`.
 *
 * Two independent facts, and both must hold: the human stopped typing, and the
 * terminal is genuinely stuck. An idle console that keeps producing output is a
 * long build, not a run waiting for somebody who is not there — reporting that
 * would train people to ignore the tickets.
 *
 * Pure functions only: the caller owns the clock, the child process, and the
 * network, so every rule here can be tested without a terminal.
 */

/** The blueprint number: five minutes without a keystroke. */
export const WRAP_IDLE_MS = 5 * 60_000;
export const MIN_IDLE_MS = 30_000;
export const MAX_IDLE_MS = 2 * 60 * 60_000;
/** How quiet the output has to be before an error tail counts as stuck. */
export const DEFAULT_QUIET_MS = 15_000;
/** Handovers per run, so a run the hub cannot finish cannot flood the board. */
export const MAX_HANDOFFS = 3;
/** Output kept as evidence for the ticket. */
export const TAIL_BYTES = 4_096;
/** Only the very end of that can still be a live prompt. */
const FRONTIER_CHARS = 300;
/** How much of the tail the ticket quotes back. */
export const EVIDENCE_CHARS = 600;

const CONFIRMATION_PATTERNS: readonly RegExp[] = [
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /yes\s*\/\s*no/i,
  /do you want to\b/i,
  /press enter to continue/i,
  /allow (?:this|it|all)\b[^?\n]{0,40}\?/i,
  /是否(?:继续|允许|确认)/,
];

const ERROR_PATTERNS: readonly RegExp[] = [
  /\berror:/i,
  /\bfatal:/i,
  /\bexception\b/i,
  /traceback \(most recent call last\)/i,
  /\bfailed to\b/i,
  /\bpermission denied\b/i,
];

export type StuckKind = 'permission' | 'prompt' | 'error';

export interface StuckSignal {
  kind: StuckKind;
  /** One line for the ticket: what the run is waiting on. */
  summary: string;
  /** Verbatim tail, truncated, so the human can judge from the real text. */
  evidence: string;
}

export interface DetectStuckInput {
  tail: string;
  lastOutputAt: number;
  now: number;
  /** Engine asked for an approval nobody has answered yet. */
  pendingPermission?: string | null;
  quietMs?: number;
}

/** Keystrokes the human would have typed to answer this prompt. */
export const HANDOVER_OPTIONS = [
  { key: 'y', label: '批准：向终端回写 y', risk: 'caution' as const },
  { key: 'n', label: '拒绝：向终端回写 n', risk: 'safe' as const },
];
export const RELAY_KEYS: readonly string[] = HANDOVER_OPTIONS.map((o) => o.key);

function firstMatch(text: string, patterns: readonly RegExp[]): RegExp | undefined {
  return patterns.find((pattern) => pattern.test(text));
}

function quote(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function detectStuck(input: DetectStuckInput): StuckSignal | null {
  const tail = input.tail.slice(-TAIL_BYTES);
  const frontier = tail.slice(-FRONTIER_CHARS);
  const evidence = quote(tail.trim(), EVIDENCE_CHARS);

  if (input.pendingPermission) {
    return {
      kind: 'permission',
      summary: input.pendingPermission,
      evidence,
    };
  }

  const prompt = firstMatch(frontier, CONFIRMATION_PATTERNS);
  if (prompt) {
    const matched = frontier.match(prompt)?.[0] ?? '';
    return {
      kind: 'prompt',
      summary: `终端停在确认提示：${quote(matched.trim(), 80)}`,
      evidence,
    };
  }

  const quietMs = input.quietMs ?? DEFAULT_QUIET_MS;
  if (input.now - input.lastOutputAt >= quietMs) {
    const error = firstMatch(frontier, ERROR_PATTERNS);
    if (error) {
      const matched = frontier.match(error)?.[0] ?? '';
      return {
        kind: 'error',
        summary: `终端在报错后保持静默：${quote(matched.trim(), 80)}`,
        evidence,
      };
    }
  }

  return null;
}

export interface HandoverJudgeOptions {
  idleMs?: number;
  quietMs?: number;
  maxHandoffs?: number;
}

export interface HandoverJudge {
  /** The human typed something: the episode is over and a new one can start. */
  noteActivity: (now: number) => void;
  /** Output arrived. Never re-arms — a busy CLI is not a stuck one. */
  noteOutput: (now: number, tail: string) => void;
  /** An unanswered approval request from the engine. Re-arms the next episode. */
  notePermission: (summary: string, now: number) => void;
  evaluate: (now: number, running: boolean) => StuckSignal | null;
  /** Anything observed after the handover: the run moved on without us. */
  movedOnSince: (at: number) => boolean;
  readonly idleMs: number;
  readonly handoffs: number;
  /** When the current handover happened, or null while nothing is outstanding. */
  readonly handedOverAt: number | null;
  readonly exhausted: boolean;
}

export function createHandoverJudge(
  options: HandoverJudgeOptions & { startedAt: number },
): HandoverJudge {
  const idleMs = options.idleMs ?? WRAP_IDLE_MS;
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const maxHandoffs = options.maxHandoffs ?? MAX_HANDOFFS;

  let lastActivityAt = options.startedAt;
  let lastOutputAt = options.startedAt;
  let tail = '';
  let pendingPermission: string | null = null;
  /** Set while one handover is in flight; cleared when the situation changes. */
  let handedOverAt: number | null = null;
  let handoffs = 0;

  return {
    noteActivity(now) {
      lastActivityAt = now;
      handedOverAt = null;
    },
    noteOutput(now, chunkTail) {
      lastOutputAt = now;
      tail = chunkTail;
    },
    notePermission(summary, now) {
      pendingPermission = summary;
      lastActivityAt = now;
      handedOverAt = null;
    },
    evaluate(now, running) {
      if (!running || handedOverAt !== null || handoffs >= maxHandoffs) {
        return null;
      }
      if (now - lastActivityAt < idleMs) return null;

      const signal = detectStuck({
        tail,
        lastOutputAt,
        now,
        pendingPermission,
        quietMs,
      });
      if (!signal) return null;

      handoffs += 1;
      handedOverAt = now;
      pendingPermission = null;
      return signal;
    },
    movedOnSince(at) {
      return lastActivityAt > at || lastOutputAt > at;
    },
    get idleMs() {
      return idleMs;
    },
    get handoffs() {
      return handoffs;
    },
    get handedOverAt() {
      return handedOverAt;
    },
    get exhausted() {
      return handoffs >= maxHandoffs;
    },
  };
}

/** `--idle-timeout` / `ZHUNZOU_WRAP_IDLE_MS`, clamped to something sane. */
export function parseIdleMs(raw: string | undefined): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return WRAP_IDLE_MS;
  return Math.min(MAX_IDLE_MS, Math.max(MIN_IDLE_MS, parsed));
}
