import { describe, expect, it } from 'vitest';

import { collapseRuns, progressKey } from '../src/sanitizer/progress.js';

describe('progressKey', () => {
  it('reads the counters, not their values (P1)', () => {
    expect(progressKey('Resolving: 12%')).toBe(progressKey('Resolving: 87%'));
    expect(progressKey('foo 3/10')).toBe(progressKey('foo 9/10'));
    expect(progressKey('Progress: resolved 100, reused 50')).toBe(
      progressKey('Progress: resolved 999, reused 1'),
    );
  });

  it('separates lines that say different things (P2)', () => {
    expect(progressKey('test a')).not.toBe(progressKey('test b'));
    expect(progressKey('install 1/2')).not.toBe(progressKey('uninstall 1/2'));
  });

  it('folds the spinner glyphs that only animate (P3)', () => {
    expect(progressKey('⠋ Building project')).toBe(progressKey('⠙ Building project'));
    expect(progressKey('✔ Building project')).toBe(progressKey('⠹ Building project'));
  });

  it('has no key for a blank line, which is never a run (P4)', () => {
    expect(progressKey('')).toBe('');
    expect(progressKey('   ')).toBe('');
  });
});

describe('collapseRuns', () => {
  it('keeps the last frame of a run and counts it (P5)', () => {
    const lines = [10, 40, 70, 90, 100].map((n) => `Progress: resolved ${n}, reused ${n}`);
    expect(collapseRuns(lines)).toEqual(['Progress: resolved 100, reused 100（重复 5 次）']);
  });

  it('folds an animated spinner to its final glyph (P6)', () => {
    expect(collapseRuns(['⠋ Building…', '⠙ Building…', '✔ Building…'])).toEqual([
      '✔ Building…（重复 3 次）',
    ]);
  });

  it('does not merge runs that are not adjacent (P7)', () => {
    expect(collapseRuns(['downloading 1/2', 'notice warning', 'downloading 2/2'])).toEqual([
      'downloading 1/2',
      'notice warning',
      'downloading 2/2',
    ]);
  });

  it('leaves a single line of a shape unannotated (P8)', () => {
    expect(collapseRuns([])).toEqual([]);
    expect(collapseRuns(['only once'])).toEqual(['only once']);
  });

  it('passes blank lines through without grouping them (P9)', () => {
    expect(collapseRuns(['', 'x 1', '', 'x 2'])).toEqual(['', 'x 1', '', 'x 2']);
  });
});
