import { describe, expect, it } from 'vitest';

import { visibleViewportTop } from '../src/lib/viewport';

describe('visibleViewportTop', () => {
  it('stays at the layout top while the keyboard is closed', () => {
    expect(visibleViewportTop(0, 800, 800)).toBe(0);
  });

  it('follows the pan Safari applies to reveal a focused input', () => {
    expect(visibleViewportTop(120, 500, 800)).toBe(120);
  });

  it('never scrolls past the area the keyboard covers', () => {
    // 300px is hidden by the keyboard, so a larger offset cannot be real.
    expect(visibleViewportTop(420, 500, 800)).toBe(300);
  });

  it('ignores a stale offset after the keyboard closes (iOS 26)', () => {
    expect(visibleViewportTop(120, 800, 800)).toBe(0);
  });

  it('tolerates a layout viewport that has not been measured yet', () => {
    expect(visibleViewportTop(0, 0, 0)).toBe(0);
    expect(visibleViewportTop(50, 0, 0)).toBe(0);
  });
});
