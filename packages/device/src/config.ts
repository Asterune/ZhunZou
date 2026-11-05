import { hostname } from 'node:os';

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
}

const DEFAULT_HUB_URL = 'http://127.0.0.1:8787';
const DEFAULT_HEARTBEAT_MS = 30_000;
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
