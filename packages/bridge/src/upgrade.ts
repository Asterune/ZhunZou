import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bridgeReleaseManifestSchema,
  type BridgeReleaseFile,
  type BridgeReleaseManifest,
} from '@zhunzou/shared';

import {
  readCurrentRelease,
  resolveInstallRoot,
  versionDir,
  versionsRoot,
  writeCurrentRelease,
} from './install-layout.js';
import { BRIDGE_VERSION } from './version.js';

/** How many downloaded versions to keep on disk for rollback. */
const KEEP_VERSIONS = 3;

export type UpgradeStatus =
  | 'up-to-date'
  | 'available'
  | 'updated'
  | 'rolled-back';

export interface UpgradeResult {
  status: UpgradeStatus;
  /** Version the install was running before this call. */
  from: string;
  /** Version the install points at afterwards (or the published one). */
  to: string;
  manifest?: BridgeReleaseManifest;
}

export interface UpgradeOptions {
  hubUrl: string;
  installRoot: string;
  token?: string;
  currentVersion?: string;
  checkOnly?: boolean;
  force?: boolean;
  rollback?: boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/** Install root of the code that is running right now. */
export function defaultInstallRoot(): string {
  return resolveInstallRoot(dirname(fileURLToPath(import.meta.url)));
}

/**
 * Compare two dotted versions. A release (`1.2.0`) outranks its prereleases
 * (`1.2.0-beta.2`); numeric segments are compared as numbers, including the
 * numeric identifiers inside a prerelease (`beta.2` < `beta.10`).
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { nums: number[]; pre: string } => {
    const cleaned = value.trim().replace(/^v/i, '').split('+')[0] ?? '';
    const [core = '', ...rest] = cleaned.split('-');
    const nums = core
      .split('.')
      .map((part) => {
        const parsed = Number.parseInt(part, 10);
        return Number.isFinite(parsed) ? parsed : 0;
      });
    return { nums, pre: rest.join('-') };
  };

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.nums.length, right.nums.length);
  for (let index = 0; index < length; index += 1) {
    const x = left.nums[index] ?? 0;
    const y = right.nums[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }

  return comparePrerelease(left.pre, right.pre);
}

function comparePrerelease(a: string, b: string): number {
  if (a === b) return 0;
  // A version without a prerelease suffix is the final release.
  if (a === '') return 1;
  if (b === '') return -1;

  const left = a.split('.');
  const right = b.split('.');
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;

    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const nx = Number.parseInt(x, 10);
      const ny = Number.parseInt(y, 10);
      if (nx !== ny) return nx < ny ? -1 : 1;
      continue;
    }
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Reject `../` and absolute paths coming from a manifest. */
function assertSafeFileName(name: string): void {
  if (
    name === '' ||
    name.includes('/') ||
    name.includes('\\') ||
    name === '.' ||
    name === '..'
  ) {
    throw new Error(`发布清单包含非法文件名：${JSON.stringify(name)}`);
  }
}

function verifyFile(
  buffer: Buffer,
  meta: BridgeReleaseFile,
  name: string,
): void {
  if (buffer.byteLength !== meta.size) {
    throw new Error(
      `下载 ${name} 的大小不符（期望 ${meta.size} 字节，实际 ${buffer.byteLength} 字节）`,
    );
  }
  const digest = sha256(buffer);
  if (digest !== meta.sha256) {
    throw new Error(`下载 ${name} 的 sha256 校验失败（期望 ${meta.sha256}，实际 ${digest}）`);
  }
}

async function fetchManifest(options: {
  hubUrl: string;
  token?: string;
  fetchImpl: typeof fetch;
  log: (line: string) => void;
}): Promise<BridgeReleaseManifest> {
  const base = trimSlash(options.hubUrl);
  const url = `${base}/api/bridge/latest`;
  options.log(`检查更新：${url}`);

  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await options.fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? `服务器上还没有发布桥接包（${url} 返回 404）`
        : `获取发布清单失败：HTTP ${response.status}`,
    );
  }

  const parsed = bridgeReleaseManifestSchema.safeParse(await response.json());
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`发布清单格式不正确：${detail}`);
  }

  const manifest = parsed.data;
  return {
    ...manifest,
    baseUrl: trimSlash(
      manifest.baseUrl ?? `${base}/releases/bridge/${manifest.version}`,
    ),
  };
}

function listInstalledVersions(installRoot: string): string[] {
  const root = versionsRoot(installRoot);
  if (!existsSync(root)) return [];

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort(compareVersions)
    .reverse();
}

/** Keep the active release plus the newest few older ones. */
function pruneVersions(
  installRoot: string,
  activeVersion: string,
  log: (line: string) => void,
): void {
  const installed = listInstalledVersions(installRoot).filter(
    (version) => version !== activeVersion,
  );
  for (const version of installed.slice(KEEP_VERSIONS - 1)) {
    rmSync(versionDir(installRoot, version), { recursive: true, force: true });
    log(`清理旧版本 ${version}`);
  }
}

async function installRelease(options: {
  manifest: BridgeReleaseManifest;
  installRoot: string;
  fetchImpl: typeof fetch;
  log: (line: string) => void;
}): Promise<void> {
  const { manifest, installRoot, fetchImpl, log } = options;
  const files = Object.entries(manifest.files);
  if (files.length === 0) {
    throw new Error('发布清单里没有任何文件');
  }

  const root = versionsRoot(installRoot);
  mkdirSync(root, { recursive: true });

  const staging = join(root, `.${manifest.version}.${process.pid}.tmp`);
  const target = versionDir(installRoot, manifest.version);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    for (const [name, meta] of files) {
      assertSafeFileName(name);
      const url = `${manifest.baseUrl}/${name}`;
      log(`下载 ${name} ...`);

      const response = await fetchImpl(url);
      if (!response.ok) {
        throw new Error(`下载 ${url} 失败：HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      verifyFile(buffer, meta, name);

      const destination = join(staging, name);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, buffer);
    }

    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function rollback(options: {
  installRoot: string;
  currentVersion: string;
  log: (line: string) => void;
}): UpgradeResult {
  const { installRoot, currentVersion, log } = options;
  const installed = listInstalledVersions(installRoot);
  const older = installed.filter(
    (version) => compareVersions(version, currentVersion) < 0,
  );
  const target = older[0] ?? installed.find((version) => version !== currentVersion);

  if (!target) {
    throw new Error(
      `没有可回滚的版本（当前 ${currentVersion}，已安装：${installed.join(', ') || '无'}）`,
    );
  }

  writeCurrentRelease(installRoot, { version: target });
  log(`已回滚到 ${target}，下次启动生效`);
  return { status: 'rolled-back', from: currentVersion, to: target };
}

/**
 * `upgrade` only makes sense for the standalone (zip) install. Refuse to litter
 * npm-installed packages or the source `dist/` with a `versions/` folder.
 */
export function assertUpgradableInstall(installRoot: string): void {
  const normalized = installRoot.split('\\').join('/');
  if (normalized.includes('node_modules')) {
    throw new Error(
      '这是 npm 安装的包，请用 npm/pnpm 更新；`upgrade` 只用于免安装的独立包',
    );
  }
  if (normalized.endsWith('/dist')) {
    throw new Error(
      '当前目录是构建产物，不是免安装包；请在解压后的 zhunzou-bridge 目录里执行',
    );
  }
}

/**
 * Check the hub for a newer standalone bridge and switch this install to it.
 *
 * `upgrade` only writes `versions/<v>/` and `current.json`; the caller's own
 * file is never touched, so it is safe to run while Cursor keeps an MCP server
 * running (the new version applies on the next launch).
 */
export async function runUpgrade(
  options: UpgradeOptions,
): Promise<UpgradeResult> {
  const log = options.log ?? (() => undefined);
  const fetchImpl = options.fetchImpl ?? fetch;
  const installRoot = options.installRoot;
  assertUpgradableInstall(installRoot);

  const currentVersion =
    options.currentVersion ??
    readCurrentRelease(installRoot)?.version ??
    BRIDGE_VERSION;

  if (options.rollback) {
    return rollback({ installRoot, currentVersion, log });
  }

  const manifest = await fetchManifest({
    hubUrl: options.hubUrl,
    fetchImpl,
    log,
    ...(options.token ? { token: options.token } : {}),
  });

  const comparison = compareVersions(manifest.version, currentVersion);
  if (comparison <= 0 && !options.force) {
    return {
      status: 'up-to-date',
      from: currentVersion,
      to: manifest.version,
      manifest,
    };
  }

  if (options.checkOnly) {
    return {
      status: 'available',
      from: currentVersion,
      to: manifest.version,
      manifest,
    };
  }

  await installRelease({ manifest, installRoot, fetchImpl, log });
  writeCurrentRelease(installRoot, { version: manifest.version });
  pruneVersions(installRoot, manifest.version, log);
  log(`已安装 ${manifest.version}，下次启动生效`);

  return {
    status: 'updated',
    from: currentVersion,
    to: manifest.version,
    manifest,
  };
}
