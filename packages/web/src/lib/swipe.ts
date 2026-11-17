/**
 * Geometry for the phone's iOS-style back swipe.
 *
 * The pushed page sits at `offset` pixels to the right of the viewport: 0 is
 * fully open, `width` is fully off-screen. The list underneath moves a little
 * in the same direction, which is what makes the push feel layered instead of
 * like a plain page swap.
 */

/** Release this far across the screen and the pop completes. */
export const SWIPE_CLOSE_RATIO = 0.32;

/** ...or fling right at least this fast (pixels per millisecond). */
export const SWIPE_CLOSE_VELOCITY = 0.45;

/** How far the page underneath travels at full open, as a fraction of width. */
export const SWIPE_PARALLAX = 0.28;

export function shouldCompleteSwipe(
  offset: number,
  width: number,
  velocity: number,
): boolean {
  if (!Number.isFinite(width) || width <= 0) return false;
  if (offset >= width * SWIPE_CLOSE_RATIO) return true;
  return velocity > SWIPE_CLOSE_VELOCITY;
}

/** Horizontal offset of the list page while the conversation sits on top. */
export function pageParallaxOffset(width: number, offset: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  const progress = Math.min(1, Math.max(0, 1 - offset / width));
  const shift = Math.round(-SWIPE_PARALLAX * width * progress);
  // `Math.round(-0)` is -0; callers compare against 0.
  return shift === 0 ? 0 : shift;
}
