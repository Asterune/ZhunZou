import { defineConfig, defineWorkspace } from 'vitest/config';

/**
 * One entry per workspace package. Projects without their own vitest config
 * need `root` here, otherwise only bridge/device would be discovered.
 */
export default defineWorkspace([
  './packages/bridge/vitest.config.ts',
  './packages/device/vitest.config.ts',
  defineConfig({ root: './packages/shared', test: { name: 'shared' } }),
  defineConfig({ root: './packages/server', test: { name: 'server' } }),
  defineConfig({ root: './packages/web', test: { name: 'web' } }),
]);
