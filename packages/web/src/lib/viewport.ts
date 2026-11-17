import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * Reactive `matchMedia`. The initial value is resolved synchronously so the
 * first paint already knows whether it is a desktop layout (no mobile→desktop
 * flash on a wide screen).
 */
export function useMediaQuery(query: string) {
  const supported =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const matches = ref(supported ? window.matchMedia(query).matches : false);
  let list: MediaQueryList | null = null;

  function update(event?: MediaQueryListEvent): void {
    matches.value = event ? event.matches : Boolean(list?.matches);
  }

  onMounted(() => {
    if (!supported) return;
    list = window.matchMedia(query);
    update();
    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', update);
    } else {
      // Safari < 14 only has the deprecated pair.
      list.addListener(update);
    }
  });

  onBeforeUnmount(() => {
    if (!list) return;
    if (typeof list.removeEventListener === 'function') {
      list.removeEventListener('change', update);
    } else {
      list.removeListener(update);
    }
    list = null;
  });

  return matches;
}

/**
 * How far a fixed layer must move down to follow the visual viewport.
 *
 * iOS pans the visual viewport to reveal a focused input (`offsetTop > 0`).
 * Only trust the offset while an editable control is focused: iOS 26 can leave
 * a stale offset after the keyboard closes, and the page is scroll-locked, so
 * a nonzero offset with nothing focused is never a real keyboard pan.
 */
export function viewportTopOffset(
  offsetTop: number,
  editableFocused: boolean,
): number {
  if (!editableFocused) return 0;
  return Math.max(0, Math.round(offsetTop));
}

/**
 * Metrics of the part of the page the phone is actually showing.
 *
 * On iOS the soft keyboard shrinks `visualViewport` but not `100dvh`, so a
 * chat pinned to dvh would leave its composer buried under the keyboard. A
 * conversation listens to this and sizes itself from the visible height.
 */
export function useVisualViewport() {
  const height = ref(0);
  const offsetTop = ref(0);
  const layoutHeight = ref(0);

  function sync(): void {
    if (typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    height.value = Math.round(viewport?.height ?? window.innerHeight);
    offsetTop.value = Math.round(viewport?.offsetTop ?? 0);
    layoutHeight.value = Math.round(window.innerHeight);
  }

  if (typeof window !== 'undefined') {
    sync();
  }

  onMounted(() => {
    if (typeof window === 'undefined') return;
    sync();
    window.addEventListener('resize', sync);
    window.visualViewport?.addEventListener('resize', sync);
    window.visualViewport?.addEventListener('scroll', sync);
  });

  onBeforeUnmount(() => {
    if (typeof window === 'undefined') return;
    window.removeEventListener('resize', sync);
    window.visualViewport?.removeEventListener('resize', sync);
    window.visualViewport?.removeEventListener('scroll', sync);
  });

  return { height, offsetTop, layoutHeight };
}
