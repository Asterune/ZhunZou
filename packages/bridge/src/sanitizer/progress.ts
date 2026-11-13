/**
 * The shape of a line, with its numbers taken out.
 *
 * Progress bars and build chatter differ from one another only in a counter,
 * which is exactly what a human skims past and a log reader drowns in. Lines
 * that share a shape are therefore one event repeated, and the run that stores
 * them keeps its last frame plus a count.
 */

/** Braille spinners, block and geometric art, dingbat ticks, the bar characters. */
const GLYPH = '[\\u2800-\\u28FF▀-◿─-╿✀-➿•·|/\\\\—–…]*';

const DIGITS = /\d+/g;
const SPACE = /\s+/g;

function shape(line: string): string {
  return line.replace(DIGITS, '#');
}

/**
 * A key two frames of the same progress bar share, and a blank line never
 * gets: an empty line is a separator, not a repeat.
 */
export function progressKey(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return '';
  return shape(trimmed).replace(new RegExp(GLYPH, 'g'), '').replace(SPACE, '');
}

/**
 * Folds runs of the same shape into their last frame. Only adjacent lines
 * group: two identical lines with something else between them said something
 * twice, and that difference is the point.
 */
export function collapseRuns(lines: string[]): string[] {
  const out: string[] = [];
  let key = '';
  let last = '';
  let count = 0;

  const flush = (): void => {
    if (count === 0) return;
    out.push(count > 1 ? `${last}（重复 ${count} 次）` : last);
    key = '';
    last = '';
    count = 0;
  };

  for (const line of lines) {
    const current = progressKey(line);
    if (!current) {
      flush();
      out.push(line);
      continue;
    }
    if (current === key) {
      key = current;
      last = line;
      count += 1;
      continue;
    }
    flush();
    key = current;
    last = line;
    count = 1;
  }

  flush();
  return out;
}
