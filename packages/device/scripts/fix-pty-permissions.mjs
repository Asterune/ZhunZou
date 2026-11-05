import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);

function findNodePtyRoot() {
  try {
    return dirname(require.resolve('node-pty'));
  } catch {
    try {
      return dirname(require.resolve('node-pty/package.json'));
    } catch {
      return null;
    }
  }
}

function fixSpawnHelpers(root) {
  const prebuilds = join(root, 'prebuilds');
  if (!existsSync(prebuilds)) return 0;
  let fixed = 0;

  for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const helper = join(prebuilds, entry.name, 'spawn-helper');
    if (!existsSync(helper)) continue;
    try {
      const mode = statSync(helper).mode & 0o777;
      if ((mode & 0o111) === 0) {
        chmodSync(helper, 0o755);
        fixed += 1;
      }
    } catch {
      // Best effort: a read-only install still reports a clear PTY error at runtime.
    }
  }

  return fixed;
}

if (process.platform === 'win32') {
  process.exit(0);
}

const root = findNodePtyRoot();
if (!root) process.exit(0);

const fixed = fixSpawnHelpers(resolve(root));
if (fixed > 0) {
  process.stdout.write(
    `[zhunzou-device] made ${fixed} node-pty spawn-helper binary executable\n`,
  );
}
