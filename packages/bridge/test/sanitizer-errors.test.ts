import { describe, expect, it } from 'vitest';

import {
  DIAGNOSIS_CHARS,
  MAX_SIGNATURES,
  buildDiagnosis,
  combineSignatures,
  extractErrors,
  looksLikeError,
  signatureOf,
} from '../src/sanitizer/errors.js';
import type { ErrorFinding } from '../src/sanitizer/errors.js';

function first(text: string): ErrorFinding {
  const [finding] = extractErrors(text);
  if (!finding) throw new Error('这段文本没有被识别成错误');
  return finding;
}

describe('extractErrors', () => {
  it('reads a TypeScript error the way the hub already stores it (E1)', () => {
    const line = 'src/pages/list.ts(24,7): error TS2322: Type "string" is not assignable to type "number".';
    expect(first(line).kind).toBe('ts');
    expect(signatureOf(first(line))).toBe('TS2322 src/pages/list.ts');
    expect(first(line).line).toBe(24);
  });

  it('reads the colon form tsc prints in pretty mode (E2)', () => {
    const line = 'src/pages/list.ts:24:7 - error TS2322: Type "string" is not assignable.';
    expect(signatureOf(first(line))).toBe('TS2322 src/pages/list.ts');
  });

  it('keeps several TypeScript errors as separate findings, in order (E3)', () => {
    const text = [
      'src/a.ts(1,2): error TS2322: first',
      'src/b.ts(3,4): error TS2345: second',
    ].join('\n');
    expect(extractErrors(text).map((finding) => finding.signature)).toEqual([
      'TS2322 src/a.ts',
      'TS2345 src/b.ts',
    ]);
  });

  it('attaches the test file to an assertion failure (E4)', () => {
    const text = [
      'FAIL packages/bridge/test/sanitizer-errors.test.ts > E4',
      'AssertionError: expected 1 to be 2',
    ].join('\n');
    const findings = extractErrors(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('assertion');
    expect(findings[0]?.signature).toBe(
      'AssertionError packages/bridge/test/sanitizer-errors.test.ts',
    );
    expect(findings[0]?.text).toContain('expected 1 to be 2');
  });

  it('names the class and flattens the message of a plain error line (E5)', () => {
    expect(first('TypeError: Cannot read properties of undefined').signature).toBe(
      'typeerror: cannot read properties of undefined',
    );
    expect(first('  Error: no such file or directory').signature).toBe(
      'error: no such file or directory',
    );
  });

  it('catches the failure phrases the idle judge already knows (E6)', () => {
    expect(first('failed to fetch the manifest').signature).toContain('failed to fetch');
    expect(first('Permission denied: /etc/hosts').signature).toContain('permission denied');
  });

  it('makes two retries of the same fault compare equal (E7)', () => {
    const a = first('Error: could not reach api after 3 retries in 1200ms');
    const b = first('Error: could not reach api after 7 retries in 3400ms');
    expect(a.signature).toBe(b.signature);
  });

  it('collects business stack frames and leaves the runtime ones out (E8)', () => {
    const text = [
      'TypeError: Cannot read properties of undefined',
      '    at node:internal/modules/cjs/loader:123:4',
      '    at run (/Users/me/app/src/index.ts:12:5)',
      '    at Object.<anonymous> (/Users/me/app/node_modules/pkg/index.js:1:1)',
      '    at main (/Users/me/app/src/main.ts:3:1)',
    ].join('\n');
    const finding = first(text);
    expect(finding.frames).toEqual([
      '/Users/me/app/src/index.ts:12:5',
      '/Users/me/app/src/main.ts:3:1',
    ]);
  });

  it('falls back to one runtime frame when nothing of ours is on the stack (E9)', () => {
    const finding = first(
      ['Error: write EPIPE', '    at node:internal/streams/writable:9:1'].join('\n'),
    );
    expect(finding.frames).toEqual(['node:internal/streams/writable:9:1']);
  });

  it('is silent about ordinary output (E10)', () => {
    expect(extractErrors('pnpm test: 603 passed')).toEqual([]);
    expect(extractErrors('hello world')).toEqual([]);
    expect(extractErrors('Progress: resolved 100, reused 50')).toEqual([]);
    expect(extractErrors('{"type":"error","message":"model overloaded"}')).toEqual([]);
  });

  it('answers the noise question with the same judgement (E11)', () => {
    expect(looksLikeError('src/a.ts(1,1): error TS2322: nope')).toBe(true);
    expect(looksLikeError('AssertionError: expected 1 to be 2')).toBe(true);
    expect(looksLikeError('failed to fetch the manifest')).toBe(true);
    expect(looksLikeError('Progress: resolved 100, reused 50')).toBe(false);
    expect(looksLikeError('downloading 3/4')).toBe(false);
  });
});

describe('signatures and diagnosis', () => {
  it('joins a few distinct signatures and never the same one twice (E12)', () => {
    const findings = extractErrors(
      [
        'src/a.ts(1,1): error TS2322: one',
        'src/b.ts(2,2): error TS2345: two',
        'src/c.ts(3,3): error TS2339: three',
        'src/d.ts(4,4): error TS2307: four',
        'src/a.ts(1,1): error TS2322: one again',
      ].join('\n'),
    );
    const joined = combineSignatures(findings);
    expect(joined).toBeDefined();
    expect(joined?.split(' | ')).toHaveLength(MAX_SIGNATURES);
    expect(joined).toContain('TS2322 src/a.ts');
    expect(joined).not.toContain('TS2307');
  });

  it('returns nothing when the block holds no error (E13)', () => {
    expect(combineSignatures(extractErrors('building project'))).toBeUndefined();
  });

  it('fits a wall of errors into the diagnosis budget (E14)', () => {
    const detail = 'x'.repeat(120);
    const findings = Array.from({ length: 40 }, (_unused, index) =>
      first(`src/mod${index}.ts(${index},1): error TS2322: ${detail} ${index}`),
    );
    const diagnosis = buildDiagnosis(findings, { limit: DIAGNOSIS_CHARS, total: 40 });
    expect(diagnosis.length).toBeLessThanOrEqual(DIAGNOSIS_CHARS);
    expect(diagnosis).toContain('未列出');
  });

  it('lists every error with its location when there is room (E15)', () => {
    const findings = extractErrors(
      [
        'src/a.ts(1,1): error TS2322: nope',
        'AssertionError: expected 1 to be 2',
      ].join('\n'),
    );
    const diagnosis = buildDiagnosis(findings, { limit: DIAGNOSIS_CHARS, total: 2 });
    expect(diagnosis).toContain('1. src/a.ts:1 TS2322: nope');
    expect(diagnosis).toContain('2. AssertionError: expected 1 to be 2');
    expect(diagnosis).not.toContain('未列出');
  });
});
