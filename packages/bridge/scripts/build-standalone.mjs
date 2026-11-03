import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, 'dist-standalone');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [join(root, 'src/mcp.ts'), join(root, 'src/cli.ts')],
  outdir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  // The running bundle must know its own release so the self-updater can
  // compare it with the manifest published on the hub.
  define: {
    __ZHUNZOU_BRIDGE_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
});

/**
 * Copy every template into `dist-standalone/templates/`.
 *
 * `init` resolves them relative to `import.meta.url`, so the bundles must ship
 * the same `../templates` layout as the source build. Without this, `npx
 * zhunzou-bridge init` silently skips AGENTS.md / .cursorrules.
 */
function copyTemplates(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyTemplates(source, target);
      continue;
    }
    copyFileSync(source, target);
  }
}

const templateSource = join(root, 'templates');
const templateTarget = join(outdir, 'templates');
if (readdirSync(templateSource).length > 0) {
  copyTemplates(templateSource, templateTarget);
}

// Flat copies for the Windows zip, whose README points at these names.
for (const [source, target] of [
  ['WINDOWS.md', 'README-WINDOWS.md'],
  ['windows-mcp.json.example', 'cursor-mcp.json.example'],
  ['.cursorrules', 'cursorrules.example'],
]) {
  copyFileSync(join(templateSource, source), join(outdir, target));
}

console.log(
  `standalone bridge written to ${outdir} (templates: ${readdirSync(templateTarget).length})`,
);
