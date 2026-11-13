/**
 * Terminal escape handling, with no dependency and no opinions.
 *
 * A CLI writes for a terminal: colours, cursor moves, window titles. Those are
 * instructions, not content, so they come off here — while tab, newline and
 * carriage return stay, because the folding step reads them as structure.
 */

const ESC = String.fromCodePoint(0x1b);
const CSI8 = String.fromCodePoint(0x9b);

const SEQUENCE_SOURCE = [
  `${ESC}\\[[0-9;:?]*[ -/]*[@-~]`,
  `${CSI8}[0-9;:?]*[ -/]*[@-~]`,
  // OSC, closed by BEL or by ST; the ST itself is the two-character escape.
  `${ESC}\\][^${ESC}\\u0007]*(?:\\u0007|${ESC}\\\\)`,
  `${ESC}[()]\\w?`,
  `${ESC}#[0-9A-Za-z]?`,
  `${ESC}[@-Zc]`,
  // C0 controls, minus tab, newline and carriage return (and minus ESC).
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001A\\u001C-\\u001F\\u007F]',
].join('|');

const SEQUENCE = new RegExp(SEQUENCE_SOURCE, 'g');

function strip(text: string): string {
  return text.replace(SEQUENCE, '');
}

/** Removes every escape sequence and control character a terminal acts on. */
export function stripAnsi(text: string): string {
  return strip(text);
}

/**
 * Same, but a sequence that was cut in half by a chunk boundary is handed back
 * instead of being mistaken for text: `pending` is what the caller prepends to
 * the next piece.
 */
export function sanitizeAnsi(text: string): { text: string; pending: string } {
  const clean = strip(text);
  const starts = [clean.indexOf(ESC), clean.indexOf(CSI8)].filter((at) => at >= 0);
  if (starts.length === 0) return { text: clean, pending: '' };
  const at = Math.min(...starts);
  return { text: clean.slice(0, at), pending: clean.slice(at) };
}
