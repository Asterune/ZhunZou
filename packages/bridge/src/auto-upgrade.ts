import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertUpgradableInstall,
  defaultInstallRoot,
  runUpgrade,
  type UpgradeResult,
} from './upgrade.js';

/**
 * Hands-off self-update for standalone bridge installs.
 *
 * Every launch of the MCP server / wake daemon checks the hub for a newer
 * release, but at most once per interval. Installing never touches the running
 * process: `runUpgrade` writes `versions/<v>/` and flips `current.json`, so the
 * new code applies on the next launch (same contract as the manual command).
 */

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const STAMP_FILE = '.auto-upgrade.json';
const DEFAULT_HUB_URL = 'http://127.0.0.1:8787';

export interface AutoUpgradeOptions {
  /** Defaults to HUB_URL or the local hub. */
  hubUrl?: string;
  /** Defaults to the folder holding the running cli.mjs / mcp.mjs. */
  installRoot?: string;
  intervalMs?: number;
  now?: number;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

interface Stamp {
  checkedAt: number;
}

function autoUpgradeDisabled(): boolean {
  const raw = (process.env.ZHUNZOU_AUTO_UPGRADE ?? '').trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'off' || raw === 'no';
}

function readInterval(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, parsed);
}

function readStamp(file: string): Stamp | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as { checkedAt?: unknown }).checkedAt === 'number'
    ) {
      return { checkedAt: (raw as Stamp).checkedAt };
    }
  } catch {
    // Missing or corrupt stamp: treat it as "never checked".
  }
  return null;
}

/**
 * Check once per interval and install a newer release when one exists.
 *
 * Returns the upgrade result, or null when the check was skipped or failed.
 * Never throws: a broken hub must not stop the agent from working.
 */
export async function maybeAutoUpgrade(
  options: AutoUpgradeOptions = {},
): Promise<UpgradeResult | null> {
  if (autoUpgradeDisabled()) return null;

  const log = options.log ?? (() => undefined);
  const installRoot = options.installRoot ?? defaultInstallRoot();

  try {
    assertUpgradableInstall(installRoot);
  } catch {
    // npm installs and source checkouts are updated with npm / git instead.
    return null;
  }

  const now = options.now ?? Date.now();
  const intervalMs = options.intervalMs ?? readInterval(process.env.ZHUNZOU_AUTO_UPGRADE_INTERVAL_MS);
  const stampFile = join(installRoot, STAMP_FILE);
  const stamp = readStamp(stampFile);
  if (stamp && now - stamp.checkedAt < intervalMs) return null;

  // Record the attempt before the network call so a down hub is not retried on
  // every launch. A failed check is not worth spamming the client log either.
  try {
    writeFileSync(stampFile, `${JSON.stringify({ checkedAt: now })}\n`, 'utf8');
  } catch {
    return null;
  }

  const hubUrl = (
    options.hubUrl ??
    process.env.HUB_URL ??
    DEFAULT_HUB_URL
  )
    .trim()
    .replace(/\/+$/, '');

  try {
    const result = await runUpgrade({
      hubUrl,
      installRoot,
      log,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (result.status === 'updated') {
      log(`自动更新 ${result.from} → ${result.to}；重启客户端后生效`);
    }
    return result;
  } catch (error) {
    log(`自动更新检查失败：${(error as Error).message}`);
    return null;
  }
}
