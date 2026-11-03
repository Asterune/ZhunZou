import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, regardless of whether we run from src/ or dist/. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export type MetaAgentProvider = 'openai' | 'http' | 'none';

export interface MetaAgentConfig {
  provider: MetaAgentProvider;
  /** Derived: provider !== 'none'. Kept for logs/backward compatibility. */
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Generic HTTP provider: receives { ticket, rules }, returns a MetaReview. */
  endpoint: string;
  /** Extra headers for the generic HTTP provider. */
  headers: Record<string, string>;
}

/**
 * Notification transport configuration. Each channel is independent; the
 * server fans out to every configured channel when a ticket needs a human.
 */
export type NotificationChannelConfig =
  | { type: 'webhook'; url: string; secret?: string }
  | { type: 'bark'; url: string }
  | { type: 'feishu'; url: string }
  | { type: 'slack'; url: string }
  | { type: 'discord'; url: string }
  | { type: 'ntfy'; url: string; token?: string }
  | { type: 'telegram'; token: string; chatId: string }
  | { type: 'console' };

export interface ServerConfig {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  host: string;
  token: string;
  dbPath: string;
  rulesPath: string;
  waitTimeoutMs: number;
  logLevel: string;
  serveWeb: boolean;
  webDistPath: string;
  /**
   * Published standalone bridge bundles. Served publicly at /releases/bridge/
   * with the latest.json manifest behind /api/bridge/latest.
   */
  bridgeReleasesPath: string;
  metaAgent: MetaAgentConfig;
  notifications: NotificationChannelConfig[];
  /** Optional JS modules loaded at boot; see docs/PLUGINS.md. */
  plugins: string[];

  /** Auto-resolve pending tickets after this many ms; 0 disables the SLA. */
  autoResolveTimeoutMs: number;
  /** Empty means every project is eligible when the SLA is enabled. */
  autoResolveProjects: string[];
  /** Background sweeper interval for SLA + stale task cleanup. */
  sweepIntervalMs: number;
  /** Requeue a CLAIMED task if its env is offline for longer than this. */
  taskClaimTimeoutMs: number;
  /** Hard timeout after which a CLAIMED task is failed even if env is online. */
  taskHardTimeoutMs: number;
  /** How many claims before a repeatedly-lost task is marked FAILED. */
  taskMaxAttempts: number;
  /**
   * Fail a RUNNING chat message when its env has been offline for this long.
   * 0 disables chat-message recovery.
   */
  chatMessageTimeoutMs: number;

  /** Public origin used in notification links, e.g. https://hub.example.com. */
  publicBaseUrl: string;
  /** HMAC key for one-click approval links. Falls back to the API token. */
  approvalLinkSecret: string;
  /** How long a one-click approval link stays valid. */
  approvalLinkTtlMs: number;
}

function readInt(
  raw: string | undefined,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function readBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase());
}

function readList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolvePath(value: string): string {
  return isAbsolute(value) ? value : resolve(REPO_ROOT, value);
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('META_AGENT_HEADERS must be a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('META_AGENT_HEADERS must be a JSON object');
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, value as string]),
  );
}

function parseMetaAgent(env: NodeJS.ProcessEnv): MetaAgentConfig {
  const allowed: MetaAgentProvider[] = ['openai', 'http', 'none'];
  const configured = env.META_AGENT_PROVIDER?.trim().toLowerCase();
  if (configured && !allowed.includes(configured as MetaAgentProvider)) {
    throw new Error(
      `META_AGENT_PROVIDER must be one of ${allowed.join(', ')}; got "${configured}"`,
    );
  }

  const enabledFlag = readBool(env.META_AGENT_ENABLED, true);
  const provider: MetaAgentProvider = !enabledFlag
    ? 'none'
    : ((configured as MetaAgentProvider | undefined) ?? 'openai');

  return {
    provider,
    enabled: provider !== 'none',
    baseUrl: (env.OPENAI_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey: env.OPENAI_API_KEY ?? '',
    model: env.META_AGENT_MODEL ?? 'deepseek-chat',
    timeoutMs: readInt(env.META_AGENT_TIMEOUT_MS, 15_000, { min: 1_000, max: 120_000 }),
    endpoint: (env.META_AGENT_ENDPOINT ?? '').trim(),
    headers: parseHeaders(env.META_AGENT_HEADERS),
  };
}

function requireValue(
  env: NodeJS.ProcessEnv,
  keys: string[],
  channel: string,
): string[] {
  const values = keys.map((key) => env[key]?.trim() ?? '');
  if (values.some((value) => value === '')) {
    throw new Error(
      `NOTIFY_CHANNELS includes "${channel}" but ${keys.join(' / ')} is not configured`,
    );
  }
  return values;
}

/**
 * Resolve notification channels from environment.
 *
 * Explicit `NOTIFY_CHANNELS` wins. Without it we keep the historical
 * behaviour: a single generic webhook when WEBHOOK_URL is present.
 */
export function parseNotificationChannels(
  env: NodeJS.ProcessEnv = process.env,
): NotificationChannelConfig[] {
  const requested = readList(env.NOTIFY_CHANNELS);
  const names = requested.length > 0 ? requested : env.WEBHOOK_URL ? ['webhook'] : [];
  const channels: NotificationChannelConfig[] = [];

  for (const name of names) {
    switch (name.toLowerCase()) {
      case 'webhook': {
        const url = requireValue(env, ['WEBHOOK_URL'], name)[0]!;
        channels.push({
          type: 'webhook',
          url,
          ...(env.WEBHOOK_SECRET ? { secret: env.WEBHOOK_SECRET } : {}),
        });
        break;
      }
      case 'bark': {
        const direct = env.BARK_URL?.trim();
        const key = env.BARK_KEY?.trim();
        if (!direct && !key) {
          throw new Error('NOTIFY_CHANNELS includes "bark" but BARK_URL / BARK_KEY is not configured');
        }
        channels.push({
          type: 'bark',
          url: direct || `https://api.day.app/${encodeURIComponent(key!)}`,
        });
        break;
      }
      case 'feishu':
      case 'lark': {
        const url = requireValue(env, ['FEISHU_WEBHOOK_URL'], name)[0]!;
        channels.push({ type: 'feishu', url });
        break;
      }
      case 'slack': {
        const url = requireValue(env, ['SLACK_WEBHOOK_URL'], name)[0]!;
        channels.push({ type: 'slack', url });
        break;
      }
      case 'discord': {
        const url = requireValue(env, ['DISCORD_WEBHOOK_URL'], name)[0]!;
        channels.push({ type: 'discord', url });
        break;
      }
      case 'ntfy': {
        const url = requireValue(env, ['NTFY_URL'], name)[0]!;
        channels.push({
          type: 'ntfy',
          url,
          ...(env.NTFY_TOKEN ? { token: env.NTFY_TOKEN } : {}),
        });
        break;
      }
      case 'telegram': {
        const values = requireValue(
          env,
          ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
          name,
        );
        const token = values[0]!;
        const chatId = values[1]!;
        channels.push({ type: 'telegram', token, chatId });
        break;
      }
      case 'console':
        channels.push({ type: 'console' });
        break;
      default:
        throw new Error(
          `unknown notification channel "${name}"; expected webhook|bark|feishu|slack|discord|ntfy|telegram|console`,
        );
    }
  }

  return channels;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const token = env.HUB_SECRET_TOKEN ?? '';

  if (token === '' && isProduction) {
    throw new Error('HUB_SECRET_TOKEN is required when NODE_ENV=production');
  }

  return {
    nodeEnv,
    isProduction,
    port: readInt(env.PORT, 8787, { min: 1, max: 65_535 }),
    host: env.HOST ?? '0.0.0.0',
    token: token || 'dev-token',
    dbPath:
      env.DATABASE_PATH === ':memory:'
        ? ':memory:'
        : resolvePath(env.DATABASE_PATH ?? './data/zhunzou.db'),
    rulesPath: resolvePath(env.GLOBAL_RULES_PATH ?? './GLOBAL_RULES.md'),
    waitTimeoutMs: readInt(env.WAIT_TIMEOUT_MS, 40_000, { min: 0, max: 55_000 }),
    logLevel: env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
    serveWeb: readBool(env.SERVE_WEB, true),
    webDistPath: resolvePath(env.WEB_DIST_PATH ?? './packages/web/dist'),
    bridgeReleasesPath: resolvePath(
      env.BRIDGE_RELEASES_PATH ?? './release/bridge',
    ),
    metaAgent: parseMetaAgent(env),
    notifications: parseNotificationChannels(env),
    plugins: readList(env.HUB_PLUGINS),
    autoResolveTimeoutMs: readInt(env.AUTO_RESOLVE_TIMEOUT_MS, 0, {
      min: 0,
      max: 7 * 24 * 60 * 60 * 1000,
    }),
    autoResolveProjects: readList(env.AUTO_RESOLVE_PROJECTS),
    sweepIntervalMs: readInt(env.SWEEP_INTERVAL_MS, 5_000, {
      min: 10,
      max: 60_000,
    }),
    taskClaimTimeoutMs: readInt(env.TASK_CLAIM_TIMEOUT_MS, 30 * 60 * 1000, {
      min: 0,
      max: 7 * 24 * 60 * 60 * 1000,
    }),
    taskHardTimeoutMs: readInt(env.TASK_HARD_TIMEOUT_MS, 6 * 60 * 60 * 1000, {
      min: 0,
      max: 7 * 24 * 60 * 60 * 1000,
    }),
    taskMaxAttempts: readInt(env.TASK_MAX_ATTEMPTS, 3, { min: 1, max: 10 }),
    chatMessageTimeoutMs: readInt(
      env.CHAT_MESSAGE_TIMEOUT_MS,
      5 * 60 * 1000,
      { min: 0, max: 7 * 24 * 60 * 60 * 1000 },
    ),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, ''),
    approvalLinkSecret:
      (env.APPROVAL_LINK_SECRET ?? '').trim() || token || 'dev-token',
    approvalLinkTtlMs: readInt(env.APPROVAL_LINK_TTL_MS, 30 * 60 * 1000, {
      min: 60_000,
      max: 7 * 24 * 60 * 60 * 1000,
    }),
  };
}
