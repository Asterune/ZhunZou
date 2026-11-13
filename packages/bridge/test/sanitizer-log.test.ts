import { describe, expect, it } from 'vitest';

import {
  MAX_ESCAPE_BYTES,
  MAX_HELD_BYTES,
  createLogSanitizer,
} from '../src/sanitizer/log-sanitizer.js';

const ESC = String.fromCodePoint(0x1b);
const CR = String.fromCodePoint(0x0d);
const CSI = ESC + '[';
const RESET = CSI + '0m';
const TS_LINE =
  'src/pages/list.ts(24,7): error TS2322: Type "string" is not assignable to type "number".';

function progress(n: number): string {
  return `Progress: resolved ${n}, reused ${n}`;
}

/**
 * The folding rule needs the line after a run to know the run ended, so a
 * foldable line is only settled by the next one or by `settle` — which the log
 * sink calls every 600ms. These tests read `feed` plus `settle` together.
 */
describe('createLogSanitizer', () => {
  it('assembles a line that arrived in pieces (L1)', () => {
    const sanitizer = createLogSanitizer();
    expect(sanitizer.feed('stdout', 'hello ')).toBe('');
    expect(sanitizer.feed('stdout', 'world\n')).toBe('');
    expect(sanitizer.feed('stdout', 'next\n')).toBe('hello world\n');
    expect(sanitizer.settle('stdout')).toBe('next\n');
  });

  it('carries an escape sequence that straddles the chunk boundary (L2)', () => {
    const sanitizer = createLogSanitizer();
    expect(sanitizer.feed('stderr', CSI + '3')).toBe('');
    expect(sanitizer.feed('stderr', '1mred' + RESET + '\n')).toBe('');
    expect(sanitizer.settle('stderr')).toBe('red\n');
  });

  it('keeps only the last frame of a carriage-return run (L3)', () => {
    const sanitizer = createLogSanitizer();
    expect(sanitizer.feed('stdout', 'Resolving: 10%' + CR + 'Resolving: 100%\n')).toBe('');
    expect(sanitizer.settle('stdout')).toBe('Resolving: 100%\n');
  });

  it('still folds a carriage-return run split across chunks (L4)', () => {
    const sanitizer = createLogSanitizer();
    expect(sanitizer.feed('stdout', 'Resolving: 10%' + CR)).toBe('');
    expect(sanitizer.feed('stdout', 'Resolving: 50%' + CR)).toBe('');
    expect(sanitizer.feed('stdout', 'Resolving: 100%\n')).toBe('');
    expect(sanitizer.settle('stdout')).toBe('Resolving: 100%\n');
  });

  it('folds a repeated build line across separate feeds (L5)', () => {
    const sanitizer = createLogSanitizer();
    expect(sanitizer.feed('stdout', progress(1) + '\n')).toBe('');
    expect(sanitizer.feed('stdout', progress(2) + '\n')).toBe('');
    expect(sanitizer.feed('stdout', progress(3) + '\n')).toBe('');
    expect(sanitizer.settle('stdout')).toBe(`${progress(3)}（重复 3 次）\n`);
  });

  it('settles a run as soon as a different line shows up (L6)', () => {
    const sanitizer = createLogSanitizer();
    sanitizer.feed('stdout', progress(1) + '\n');
    sanitizer.feed('stdout', progress(2) + '\n');
    expect(sanitizer.feed('stdout', 'notice: 2 packages added\n')).toBe(
      `${progress(2)}（重复 2 次）\n`,
    );
    expect(sanitizer.settle('stdout')).toBe('notice: 2 packages added\n');
  });

  it('never holds a line longer than the guard (L7)', () => {
    const sanitizer = createLogSanitizer({ heldBytes: 64 });
    const noise = 'x'.repeat(200);
    const early = sanitizer.feed('stdout', noise);
    expect(early.length).toBeGreaterThan(0);
    const shipped = early + sanitizer.feed('stdout', '\n') + sanitizer.settle('stdout');
    expect(shipped.replace(/\n/g, '')).toBe(noise);

    expect(sanitizer.feed('stdout', 'ok\n')).toBe('');
    expect(sanitizer.settle('stdout')).toBe('ok\n');
  });

  it('gives each stream its own state (L8)', () => {
    const sanitizer = createLogSanitizer();
    expect(sanitizer.feed('stdout', 'partial')).toBe('');
    expect(sanitizer.feed('stderr', progress(1) + '\n')).toBe('');
    expect(sanitizer.feed('stderr', progress(2) + '\n')).toBe('');
    expect(sanitizer.settle('stderr')).toBe(`${progress(2)}（重复 2 次）\n`);
    expect(sanitizer.settle('stdout')).toBe('partial');
    expect(sanitizer.settle('stdout')).toBe('');
  });

  it('keeps blank lines out of the shipped text (L9)', () => {
    const sanitizer = createLogSanitizer();
    expect(sanitizer.feed('system', '\n' + RESET + '[zhunzou] done\n')).toBe('');
    expect(sanitizer.settle('system')).toBe('[zhunzou] done\n');
  });

  it('emits an error line at once and never folds it with its neighbours (L10)', () => {
    const sanitizer = createLogSanitizer();
    expect(sanitizer.feed('stderr', 'src/a.ts(1,1): error TS2322: one\n')).toBe(
      'src/a.ts(1,1): error TS2322: one\n',
    );
    const out = sanitizer.feed('stderr', 'src/b.ts(2,2): error TS2345: two\n');
    expect(out).toBe('src/b.ts(2,2): error TS2345: two\n');
    expect(out).not.toContain('重复');
    expect(sanitizer.settle('stderr')).toBe('');
  });

  it('loses nothing on a stream that never repeats (L11)', () => {
    const sanitizer = createLogSanitizer();
    const shipped = [
      sanitizer.feed('stdout', 'a\n'),
      sanitizer.feed('stdout', 'b\n'),
      sanitizer.feed('stdout', 'c\n'),
      sanitizer.settle('stdout'),
    ].join('');
    expect(shipped).toBe('a\nb\nc\n');
  });

  it('drops an escape fragment that never completes (L12)', () => {
    const sanitizer = createLogSanitizer();
    expect(sanitizer.feed('stderr', CSI + '3'.repeat(MAX_ESCAPE_BYTES * 2))).toBe('');
    expect(sanitizer.feed('stderr', 'ok\n')).toBe('');
    expect(sanitizer.settle('stderr')).toBe('ok\n');
  });

  it('publishes the guards it uses (L13)', () => {
    expect(MAX_HELD_BYTES).toBeGreaterThan(0);
    expect(MAX_ESCAPE_BYTES).toBeLessThan(MAX_HELD_BYTES);
  });
});

describe('LogSanitizer.describe', () => {
  it('signs an error block and says nothing about a clean one (L14)', () => {
    const sanitizer = createLogSanitizer();
    expect(sanitizer.describe(TS_LINE)).toEqual({
      errorSignature: 'TS2322 src/pages/list.ts',
    });
    expect(sanitizer.describe('pnpm test: 603 passed')).toEqual({});
    expect(sanitizer.describe('')).toEqual({});
  });

  it('lists a few signatures, never more, and never past the cap (L15)', () => {
    const sanitizer = createLogSanitizer();
    const chunk = Array.from({ length: 5 }, (_unused, index) =>
      `src/m${'y'.repeat(120)}${index}.ts(1,1): error TS2322: boom`,
    ).join('\n');
    const meta = sanitizer.describe(chunk);
    expect(meta.errorSignature).toBeDefined();
    expect(meta.errorSignature?.split(' | ')).toHaveLength(3);
    expect(meta.errorSignature?.length).toBeLessThanOrEqual(500);
  });
});

describe('LogSanitizer.summarize', () => {
  const mixed = [
    CSI + '38;5;208mwarn' + RESET + ': unused variable',
    progress(10),
    progress(60),
    progress(100),
    TS_LINE,
    '    at node:internal/modules/cjs/loader:123:4',
    '    at loadPage (/Users/me/pte-dojo/src/pages/list.ts:24:7)',
    'FAIL packages/web/test/list.test.ts > renders rows',
    'AssertionError: expected 1 to be 2',
  ].join('\n');

  it('turns a noisy run into a short diagnosis (L16)', () => {
    const sanitizer = createLogSanitizer();
    sanitizer.feed('stderr', mixed + '\n');
    sanitizer.settle('stderr');
    const diagnosis = sanitizer.summarize();
    expect(diagnosis.length).toBeLessThanOrEqual(2000);
    expect(diagnosis).toContain('TS2322');
    expect(diagnosis).toContain('src/pages/list.ts:24');
    expect(diagnosis).toContain('AssertionError: expected 1 to be 2');
    expect(diagnosis).toContain('/Users/me/pte-dojo/src/pages/list.ts:24:7');
    expect(diagnosis).not.toContain(ESC);
    expect(diagnosis).not.toContain(progress(10));
  });

  it('falls back to the tail when it cannot name the fault (L17)', () => {
    const sanitizer = createLogSanitizer();
    sanitizer.feed('stderr', 'boom: model overloaded\n');
    sanitizer.settle('stderr');
    expect(sanitizer.summarize()).toContain('boom: model overloaded');
    expect(createLogSanitizer().summarize()).toBe('');
  });

  it('counts every repeat instead of listing every one (L18)', () => {
    const sanitizer = createLogSanitizer();
    for (let index = 0; index < 200; index += 1) {
      sanitizer.feed('stderr', `Error: fault number ${index} ` + 'z'.repeat(40) + '\n');
    }
    sanitizer.settle('stderr');
    const diagnosis = sanitizer.summarize();
    expect(diagnosis.length).toBeLessThanOrEqual(2000);
    expect(diagnosis).toContain('未列出');
    expect(diagnosis).toContain('200');
  });

  it('does not treat our own narration as evidence of a fault (L19)', () => {
    const sanitizer = createLogSanitizer();
    sanitizer.feed('system', '[zhunzou] 执行失败：Error: adapter threw up\n');
    sanitizer.settle('system');
    expect(sanitizer.summarize()).toBe('');

    sanitizer.feed('stderr', 'boom: model overloaded\n');
    sanitizer.settle('stderr');
    expect(sanitizer.summarize()).toBe('boom: model overloaded');
  });
});
