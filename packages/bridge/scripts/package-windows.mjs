import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'dist-standalone');
const release = join(root, '..', '..', 'release');
const target = join(release, 'zhunzou-bridge-windows.zip');

mkdirSync(release, { recursive: true });

try {
  execFileSync('zip', ['-r', '-q', target, '.'], { cwd: source, stdio: 'inherit' });
  console.log(`windows bundle: ${target}`);
} catch (error) {
  console.error('打包失败：需要系统提供 zip 命令（macOS/Linux 自带）。');
  console.error(String(error));
  process.exit(1);
}
