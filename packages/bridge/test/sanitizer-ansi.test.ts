import { describe, expect, it } from 'vitest';

import { sanitizeAnsi, stripAnsi } from '../src/sanitizer/ansi.js';

/**
 * Built from code points so this file never carries a raw escape byte, which
 * editors and diffs render as nothing at all.
 */
const ESC = String.fromCodePoint(0x1b);
const CR = String.fromCodePoint(0x0d);
const BEL = String.fromCodePoint(0x07);
const CSI = ESC + '[';

describe('stripAnsi', () => {
  it('drops colours and the reset that ends them (A1)', () => {
    expect(stripAnsi(CSI + '38;5;196m' + 'boom' + CSI + '0m')).toBe('boom');
    expect(stripAnsi(CSI + '1;32m' + CSI + 'mok' + CSI + '0m')).toBe('ok');
  });

  it('drops cursor movement and line clearing (A2)', () => {
    expect(stripAnsi(CSI + '2K' + CSI + '1Gprompt')).toBe('prompt');
    expect(stripAnsi(CSI + '?25lhidden' + CSI + '?25h')).toBe('hidden');
  });

  it('drops OSC sequences closed by BEL or ST (A3)', () => {
    expect(stripAnsi(ESC + ']0;title' + BEL + 'rest')).toBe('rest');
    expect(stripAnsi(ESC + ']0;title' + ESC + '\\' + 'rest')).toBe('rest');
  });

  it('keeps the line structure the folding step reads (A4)', () => {
    expect(stripAnsi(CSI + '1mbold' + CSI + '0m')).toBe('bold');
    expect(stripAnsi('a' + CR + 'b')).toBe('a' + CR + 'b');
    expect(stripAnsi('a\tb')).toBe('a\tb');
  });

  it('drops the control characters that have no text meaning (A5)', () => {
    const nul = String.fromCodePoint(0x00);
    const bs = String.fromCodePoint(0x08);
    const del = String.fromCodePoint(0x7f);
    expect(stripAnsi('a' + nul + 'b' + bs + 'c' + del + 'd')).toBe('abcd');
  });
});

describe('sanitizeAnsi', () => {
  it('returns clean text and nothing held for complete sequences (A6)', () => {
    expect(sanitizeAnsi(CSI + '31mred' + CSI + '0m')).toEqual({
      text: 'red',
      pending: '',
    });
    expect(sanitizeAnsi('plain')).toEqual({ text: 'plain', pending: '' });
  });

  it('holds back a parameter list that has not met its final byte (A7)', () => {
    expect(sanitizeAnsi('a' + CSI + '3')).toEqual({ text: 'a', pending: CSI + '3' });
    expect(sanitizeAnsi('a' + CSI + '38;5')).toEqual({ text: 'a', pending: CSI + '38;5' });
    expect(sanitizeAnsi('a' + ESC)).toEqual({ text: 'a', pending: ESC });
    expect(sanitizeAnsi(ESC + ']0;untitled')).toEqual({
      text: '',
      pending: ESC + ']0;untitled',
    });
  });

  it('keeps the text that follows an incomplete escape where it belongs (A8)', () => {
    const held = sanitizeAnsi('red' + CSI + '3');
    const rest = sanitizeAnsi(held.pending + '1mword' + CSI + '0m');
    expect(held.text + rest.text).toBe('redword');
    expect(rest.pending).toBe('');
  });
});
