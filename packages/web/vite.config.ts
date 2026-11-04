import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';

/**
 * Emit the hand-written service worker with a per-build id.
 *
 * Files in `public/` are copied verbatim, which would keep `sw.js` byte-for-byte
 * identical between deploys — browsers then never notice a new version. The
 * source lives in `src/sw.js` and this plugin stamps it, so every build is a
 * detectable service-worker update (polled by the open app).
 */
function serviceWorker(buildId: string): Plugin {
  return {
    name: 'zhunzou-service-worker',
    apply: 'build',
    generateBundle() {
      const source = readFileSync(
        fileURLToPath(new URL('./src/sw.js', import.meta.url)),
        'utf8',
      ).replaceAll('__BUILD_ID__', buildId);

      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

const buildId = new Date().toISOString();

export default defineConfig({
  plugins: [vue(), tailwindcss(), serviceWorker(buildId)],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.HUB_URL ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/healthz': {
        target: process.env.HUB_URL ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
