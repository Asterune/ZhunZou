#!/usr/bin/env node
/**
 * Build the standalone bridge and publish it into `release/bridge/`, which the
 * hub serves at `/releases/bridge/…` and `/api/bridge/latest`.
 *
 * Usage:
 *   node scripts/publish-bridge.mjs                 # publish package.json version
 *   node scripts/publish-bridge.mjs --version 0.2.0 --notes "修复心跳重连"
 *   node scripts/publish-bridge.mjs --skip-build --no-zip
 *
 * The repo tarball that deploy/deploy.sh uploads already contains
 * `release/bridge/`, so publishing locally + deploying is all it takes for
 * clients to see the new version.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptDir);
const repoRoot = dirname(dirname(packageDir));
const sourceDir = join(packageDir, 'dist-standalone');
const outRoot = join(repoRoot, 'release', 'bridge');

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const has = (name) => args.includes(name);

const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const version = (flag('--version') ?? pkg.version ?? '').trim();
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`[publish] 非法版本号：${JSON.stringify(version)}`);
  process.exit(1);
}

if (!has('--skip-build')) {
  console.log('[publish] 构建 standalone 包 ...');
  execFileSync(process.execPath, [join(scriptDir, 'build-standalone.mjs')], {
    cwd: packageDir,
    stdio: 'inherit',
  });
}
if (!existsSync(join(sourceDir, 'mcp.mjs'))) {
  console.error('[publish] 缺少 dist-standalone/mcp.mjs，请先执行构建');
  process.exit(1);
}

const targetDir = join(outRoot, version);
rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });

const files = {};
const skipped = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(absolute);
      continue;
    }
    const name = relative(sourceDir, absolute).split('\\').join('/');
    // The self-updater installs each release into a flat versions/<v>/ folder
    // and older clients reject nested manifest entries. Keep the manifest flat,
    // but publish nested files too: the one-click installer fetches
    // `templates/AGENTS.md` and never walks the manifest.
    if (name.includes('/')) {
      const destination = join(targetDir, name);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(absolute, destination);
      skipped.push(name);
      continue;
    }
    const contents = readFileSync(absolute);
    const destination = join(targetDir, name);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(absolute, destination);
    files[name] = {
      sha256: createHash('sha256').update(contents).digest('hex'),
      size: contents.byteLength,
    };
  }
};
walk(sourceDir);
if (skipped.length > 0) {
  console.log(
    `[publish] 已发布嵌套文件 ${skipped.length} 个（不进清单，供一键安装脚本使用）`,
  );
}

const manifest = {
  version,
  releasedAt: Date.now(),
  ...(flag('--notes') ? { notes: flag('--notes') } : {}),
  files,
};
writeFileSync(
  join(outRoot, 'latest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

if (!has('--no-zip')) {
  try {
    execFileSync(process.execPath, [join(scriptDir, 'package-windows.mjs')], {
      cwd: packageDir,
      stdio: 'inherit',
    });
  } catch {
    console.warn('[publish] Windows zip 打包失败，已跳过（不影响自更新）');
  }
}

const totalKb = Object.values(files).reduce((sum, file) => sum + file.size, 0) / 1024;
console.log(`[publish] 版本 ${version} → ${relative(repoRoot, targetDir)}`);
console.log(`[publish] 文件 ${Object.keys(files).length} 个，共 ${totalKb.toFixed(0)} KB`);
console.log(`[publish] 清单 → ${relative(repoRoot, join(outRoot, 'latest.json'))}`);
console.log('[publish] 下一步：bash deploy/deploy.sh 上传到 hub');
