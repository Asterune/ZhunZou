import { homedir, hostname } from 'node:os';

import type { NodeRole } from '@zhunzou/shared';
import { NODE_HEARTBEAT_REPORT_MS, NODE_ROLES } from '@zhunzou/shared';

/** What this machine tells the hub so the scheduler can place work on it. */
export interface DeviceNodeOptions {
  role: NodeRole;
  tags: string[];
  maxConcurrency: number;
  /** Roots scanned for git checkouts; empty means "route me by env only". */
  scanDirs: string[];
}

export interface DeviceConfig {
  /** Hub base URL, http(s) or ws(s), without a trailing slash. */
  hubUrl: string;
  /** Scoped agent token (zz_...) or the admin token for a single-user setup. */
  token: string;
  /** Stable identity shown on the dashboard. */
  env: string;
  projectName?: string;
  /** How often to send a heartbeat over the socket. */
  heartbeatMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  node?: DeviceNodeOptions;
}

const DEFAULT_HUB_URL = 'http://127.0.0.1:8787';
// Two beats must fit inside the hub's node routing window, or a node flaps.
const DEFAULT_HEARTBEAT_MS = NODE_HEARTBEAT_REPORT_MS;
const DEFAULT_RECONNECT_MIN_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

function readInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** `~/code` means the same thing here as in the operator's shell. */
function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path;
}

function readRole(raw: string | undefined): NodeRole {
  const value = (raw ?? '').trim().toLowerCase();
  return (NODE_ROLES as readonly string[]).includes(value)
    ? (value as NodeRole)
    : 'worker';
}

function readNodeOptions(env: NodeJS.ProcessEnv): DeviceNodeOptions {
  return {
    role: readRole(env.ZHUNZOU_NODE_ROLE),
    tags: readList(env.ZHUNZOU_NODE_TAGS).slice(0, 10),
    maxConcurrency: clamp(readInt(env.ZHUNZOU_MAX_CONCURRENCY, 1), 1, 16),
    scanDirs: readList(env.ZHUNZOU_SCAN_DIRS).map(expandHome),
  };
}

function normalizeHubUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function loadDeviceConfig(
  env: NodeJS.ProcessEnv = process.env,
): DeviceConfig {
  const token = (
    env.ZHUNZOU_DEVICE_TOKEN ??
    env.HUB_TOKEN ??
    env.HUB_SECRET_TOKEN ??
    ''
  ).trim();
  if (!token) {
    throw new Error(
      'HUB_TOKEN is required. Use a scoped agent token (zz_...) or the server HUB_SECRET_TOKEN.',
    );
  }

  const hubUrl = normalizeHubUrl(
    env.ZHUNZOU_HUB_URL ?? env.HUB_URL ?? DEFAULT_HUB_URL,
  );
  let parsed: URL;
  try {
    parsed = new URL(hubUrl);
  } catch {
    throw new Error(`HUB_URL is not a valid URL: ${hubUrl}`);
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error(`HUB_URL must use http(s) or ws(s): ${hubUrl}`);
  }

  return {
    hubUrl,
    token,
    env: (env.ZHUNZOU_DEVICE_ENV ?? env.AGENT_ENV ?? '').trim() || `device-${hostname()}`,
    ...(env.ZHUNZOU_PROJECT?.trim()
      ? { projectName: env.ZHUNZOU_PROJECT.trim() }
      : {}),
    heartbeatMs: clamp(
      readInt(env.ZHUNZOU_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_MS),
      5_000,
      300_000,
    ),
    reconnectMinMs: clamp(
      readInt(env.ZHUNZOU_RECONNECT_MIN_MS, DEFAULT_RECONNECT_MIN_MS),
      250,
      60_000,
    ),
    reconnectMaxMs: clamp(
      readInt(env.ZHUNZOU_RECONNECT_MAX_MS, DEFAULT_RECONNECT_MAX_MS),
      1_000,
      5 * 60_000,
    ),
    node: readNodeOptions(env),
  };
}

/** Convert http(s) to ws(s), append `/ws/device`, and carry the env hint. */
export function deviceSocketUrl(config: DeviceConfig): string {
  const url = new URL(config.hubUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/ws/device';
  } else if (!url.pathname.endsWith('/ws/device')) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws/device`;
  }
  url.searchParams.set('env', config.env);
  return url.toString();
}
