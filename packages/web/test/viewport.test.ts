import { describe, expect, it } from 'vitest';

import { viewportTopOffset } from '../src/lib/viewport';

describe('viewportTopOffset', () => {
  it('stays at zero while no editable control is focused', () => {
    expect(viewportTopOffset(0, false)).toBe(0);
    // iOS 26 can leave a stale offset after the keyboard closes.
    expect(viewportTopOffset(120, false)).toBe(0);
  });

  it('follows the pan Safari applies to reveal a focused composer', () => {
    expect(viewportTopOffset(120, true)).toBe(120);
    expect(viewportTopOffset(0, true)).toBe(0);
  });

  it('never produces a negative translation', () => {
    expect(viewportTopOffset(-12, true)).toBe(0);
  });
});
