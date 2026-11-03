import { resolve } from 'node:path';

/** Local clients the wake daemon can hand a task to. */
export const WAKE_ADAPTERS = [
  'auto',
  'opencode',
  'opencode-run',
  'claude',
  'codex',
  'gemini',
  'cursor-agent',
  'aider',
  'goose',
  'amp',
  'command',
  'notify',
] as const;

export type WakeAdapterName = (typeof WAKE_ADAPTERS)[number];

/** Adapters that never claim a task; they only raise a reminder. */
export const NOTIFY_ADAPTERS: readonly WakeAdapterName[] = ['notify'];

export interface WakeConfig {
  /** Which local client should receive dispatched tasks. */
  adapter: WakeAdapterName;
  /** Shell command template used by the `command` adapter. */
  command?: string;
  /** Extra arguments appended to preset CLI adapters. */
  extraArgs: string[];
  /** Working directory handed to run adapters. */
  cwd: string;
  /** How long a `run` adapter may execute before it is killed. */
  runTimeoutMs: number;
  /** Long-poll window per task claim. */
  pollTimeoutMs: number;
  /** How often the `notify` adapter re-scans for pending tasks. */
  notifyIntervalMs: number;
}

const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_NOTIFY_INTERVAL_MS = 15_000;
const MIN_POLL_TIMEOUT_MS = 1_000;
const MAX_POLL_TIMEOUT_MS = 55_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readAdapter(raw: string | undefined): WakeAdapterName {
  const value = (raw ?? '').trim().toLowerCase();
  return (WAKE_ADAPTERS as readonly string[]).includes(value)
    ? (value as WakeAdapterName)
    : 'auto';
}

/**
 * Parse wake-daemon settings from the environment.
 *
 * Kept separate from `BridgeConfig` so the MCP server does not pay for options
 * that only the daemon understands.
 */
export function loadWakeConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): WakeConfig {
  const command = (env.ZHUNZOU_WAKE_COMMAND ?? '').trim();
  const extraArgs = (env.ZHUNZOU_WAKE_ARGS ?? '')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return {
    adapter: readAdapter(env.ZHUNZOU_WAKE_ADAPTER),
    ...(command ? { command } : {}),
    extraArgs,
    cwd: resolve((env.ZHUNZOU_WAKE_CWD ?? '').trim() || cwd),
    runTimeoutMs: clamp(
      readInt(env.ZHUNZOU_WAKE_RUN_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS),
      5_000,
      24 * 60 * 60 * 1000,
    ),
    pollTimeoutMs: clamp(
      readInt(env.ZHUNZOU_WAKE_POLL_TIMEOUT_MS, 40_000),
      MIN_POLL_TIMEOUT_MS,
      MAX_POLL_TIMEOUT_MS,
    ),
    notifyIntervalMs: clamp(
      readInt(env.ZHUNZOU_WAKE_NOTIFY_INTERVAL_MS, DEFAULT_NOTIFY_INTERVAL_MS),
      2_000,
      10 * 60 * 1000,
    ),
  };
}
