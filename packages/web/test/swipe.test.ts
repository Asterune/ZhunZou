import { describe, expect, it } from 'vitest';

import {
  pageParallaxOffset,
  shouldCompleteSwipe,
  SWIPE_CLOSE_RATIO,
} from '../src/lib/swipe';

describe('shouldCompleteSwipe', () => {
  it('closes once the page is dragged past the release threshold', () => {
    const width = 390;
    expect(shouldCompleteSwipe(width * SWIPE_CLOSE_RATIO - 1, width, 0)).toBe(
      false,
    );
    expect(shouldCompleteSwipe(width * SWIPE_CLOSE_RATIO, width, 0)).toBe(true);
  });

  it('closes on a rightward fling even from a short drag', () => {
    expect(shouldCompleteSwipe(40, 390, 0.6)).toBe(true);
    expect(shouldCompleteSwipe(40, 390, 0.1)).toBe(false);
  });

  it('stays open when the width is unknown', () => {
    expect(shouldCompleteSwipe(400, 0, 2)).toBe(false);
  });
});

describe('pageParallaxOffset', () => {
  it('runs from 0 (closed) to -28% of the width (open)', () => {
    expect(pageParallaxOffset(390, 390)).toBe(0);
    expect(pageParallaxOffset(390, 195)).toBe(-55);
    expect(pageParallaxOffset(390, 0)).toBe(-109);
  });

  it('clamps a rubber-banded offset', () => {
    expect(pageParallaxOffset(390, -40)).toBe(-109);
    expect(pageParallaxOffset(390, 500)).toBe(0);
    expect(pageParallaxOffset(0, 0)).toBe(0);
  });
});
