/**
 * Reading a fault out of a build or test log.
 *
 * The hub compares these signatures between retries, so the job here is not to
 * explain the error but to name it the same way twice: the code and the file
 * for a TypeScript failure, the class and a number-free message for anything
 * else. Numbers, counts and elapsed time are what differs between two runs of
 * the same fault, so they are the first things removed.
 */

export const MAX_SIGNATURE_CHARS = 500;
export const MAX_SIGNATURES = 3;
export const MAX_SIGNATURE_MESSAGE = 160;
export const DIAGNOSIS_CHARS = 2000;
export const MAX_FRAMES = 2;

export type ErrorKind = 'ts' | 'assertion' | 'error';

export interface ErrorFinding {
  kind: ErrorKind;
  /** The line as written, for the human reading the ticket. */
  text: string;
  /** The same fault named twice: what the circuit breaker compares. */
  signature: string;
  file?: string;
  line?: number;
  code?: string;
  message?: string;
  frames: string[];
}

const SOURCE_FILE = '[\\w./@~+-]+\\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte)';
const TS_PAREN = new RegExp(`(${SOURCE_FILE})\\((\\d+),(\\d+)\\): error ([A-Z]+\\d+): (.+)`);
const TS_DASH = new RegExp(`(${SOURCE_FILE}):(\\d+):(\\d+) - error ([A-Z]+\\d+): (.+)`);
const TEST_FILE = /^\s*(?:FAIL|✕|×|●)\s+([^\s>]+\.(?:test|spec)\.\w+)(?:\s*>\s*(.+))?/;
const ASSERTION = /AssertionError:\s*(.+)/;
const GENERIC =
  /(?:^|[\s("'`])((?:[A-Za-z_$][\w$]*(?:Error|Exception))|[Ee]rror|[Ff]atal|[Pp]anic|Traceback):[ \t]*(.+)/;
/** The failure phrases the idle judge already treats as a stuck terminal. */
const PHRASE = /\b(failed to\s+\S.*|permission denied\b.*)/i;
const FRAME = /^\s*at\s+(?:.*?\(([^()]+:\d+:\d+)\)|([^\s()]+:\d+:\d+))\s*$/;
const RUNTIME_FRAME = /^node:/;

function flatten(value: string, limit = MAX_SIGNATURE_MESSAGE): string {
  const oneLine = value
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function isBusiness(frame: string): boolean {
  return !RUNTIME_FRAME.test(frame) && !frame.includes('node_modules');
}

/** One line, one judgement: the noise fold asks this before grouping anything. */
export function looksLikeError(line: string): boolean {
  return (
    TS_PAREN.test(line) ||
    TS_DASH.test(line) ||
    TEST_FILE.test(line) ||
    ASSERTION.test(line) ||
    GENERIC.test(line) ||
    PHRASE.test(line)
  );
}

/** A fault plus the stack lines that follow it. */
interface StackWatch {
  target: ErrorFinding;
  ours: string[];
  runtime: string[];
}

/** Every fault in the block, in the order a person would have read them. */
export function extractErrors(text: string): ErrorFinding[] {
  const findings: ErrorFinding[] = [];
  const stack: { watch: StackWatch | null } = { watch: null };
  /** A `FAIL file > case` line: its assertion message may be the next line. */
  let awaiting: ErrorFinding | null = null;

  const close = (): void => {
    const watch = stack.watch;
    if (!watch) return;
    watch.target.frames = watch.ours.length
      ? watch.ours.slice(0, MAX_FRAMES)
      : watch.runtime.slice(0, 1);
    stack.watch = null;
  };

  const open = (finding: ErrorFinding): void => {
    close();
    findings.push(finding);
    stack.watch = { target: finding, ours: [], runtime: [] };
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const frame = FRAME.exec(line);
    if (frame) {
      const location = frame[1] ?? frame[2] ?? '';
      const watch = stack.watch;
      if (watch) (isBusiness(location) ? watch.ours : watch.runtime).push(location);
      continue;
    }

    const typed = TS_PAREN.exec(line) ?? TS_DASH.exec(line);
    if (typed) {
      open({
        kind: 'ts',
        file: typed[1] ?? '',
        line: Number(typed[2]),
        code: typed[4] ?? '',
        message: typed[5] ?? '',
        text: clip(line, 300),
        signature: `${typed[4] ?? ''} ${typed[1] ?? ''}`,
        frames: [],
      });
      continue;
    }

    const failed = TEST_FILE.exec(line);
    if (failed) {
      const finding: ErrorFinding = {
        kind: 'assertion',
        file: failed[1] ?? '',
        text: clip(line, 300),
        signature: `AssertionError ${failed[1] ?? ''}`,
        frames: [],
      };
      open(finding);
      awaiting = finding;
      continue;
    }

    const asserted = ASSERTION.exec(line);
    if (asserted) {
      const message = asserted[1] ?? '';
      const last = findings[findings.length - 1];
      if (awaiting && last === awaiting) {
        awaiting.text = clip(line, 300);
        awaiting.message = message;
        awaiting = null;
        continue;
      }
      open({
        kind: 'assertion',
        text: clip(line, 300),
        message,
        signature: `AssertionError ${flatten(message)}`,
        frames: [],
      });
      continue;
    }

    const named = GENERIC.exec(line);
    if (named) {
      const message = named[2] ?? '';
      open({
        kind: 'error',
        text: clip(line, 300),
        message,
        signature: flatten(`${named[1] ?? ''}: ${message}`),
        frames: [],
      });
      continue;
    }

    const phrase = PHRASE.exec(line);
    if (phrase) {
      const message = phrase[1] ?? '';
      open({
        kind: 'error',
        text: clip(line, 300),
        message,
        signature: flatten(message),
        frames: [],
      });
    }
  }

  close();
  return findings;
}

export function signatureOf(finding: ErrorFinding): string {
  return finding.signature;
}

/** A few names for the block, so one row can say what broke without a page. */
export function combineSignatures(
  findings: ErrorFinding[],
  options: { max?: number; limit?: number } = {},
): string | undefined {
  const max = options.max ?? MAX_SIGNATURES;
  const limit = options.limit ?? MAX_SIGNATURE_CHARS;
  const unique: string[] = [];
  for (const finding of findings) {
    if (!unique.includes(finding.signature)) unique.push(finding.signature);
  }
  if (unique.length === 0) return undefined;
  return clip(unique.slice(0, max).join(' | '), limit);
}

function headline(finding: ErrorFinding): string {
  if (finding.kind === 'ts') {
    return `${finding.file}:${finding.line} ${finding.code}: ${clip(finding.message ?? '', 200)}`;
  }
  return clip(finding.text, 200);
}

/**
 * The numbered list that becomes a task's result: one line per fault, the
 * frames that point at our own code, and a count of what did not fit.
 */
export function buildDiagnosis(
  findings: ErrorFinding[],
  options: { limit?: number; total?: number } = {},
): string {
  const limit = options.limit ?? DIAGNOSIS_CHARS;
  const total = options.total ?? findings.length;
  const note = (shown: number): string =>
    total > shown ? `\n（共 ${total} 条错误，另有 ${total - shown} 条未列出）` : '';
  const reserve = note(0).length;

  const blocks: string[] = [];
  let used = 0;
  for (const finding of findings) {
    const block = [
      `${blocks.length + 1}. ${headline(finding)}`,
      ...finding.frames.slice(0, MAX_FRAMES).map((frame) => `     at ${frame}`),
    ].join('\n');
    if (used + block.length + 1 > limit - reserve) break;
    blocks.push(block);
    used += block.length + 1;
  }

  if (blocks.length === 0) return findings.length > 0 ? clip(note(0).trimStart(), limit) : '';
  return clip(`${blocks.join('\n')}${note(blocks.length)}`, limit);
}
