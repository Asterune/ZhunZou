import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup-home.ts'],
    // This package spawns real processes (fake CLIs on PATH, real `git
    // worktree`). A quiet run needs ~2s, a fully parallel run needs over 5s,
    // so the default per-test budget was a coin flip rather than a signal.
    testTimeout: 20_000,
  },
});
