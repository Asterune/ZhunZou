import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import type { AgentKind } from '@zhunzou/shared';
import { AGENT_KINDS } from '@zhunzou/shared';

export type FallbackStrategy = 'cli' | 'mcp';
export type TransportMode = 'auto' | 'ws' | 'http';

export interface BridgeConfig {
  /** Base URL of the Zhunzou server, without a trailing slash. */
  hubUrl: string;
  /** Bearer token shared with the server. */
  token: string;
  /** Logical env name shown on the dashboard, e.g. company-cursor. */
  agentEnv: string;
  /**
   * Project this workspace is working on; reported in heartbeats.
   * Defaults to the git root / cwd basename when ZHUNZOU_PROJECT is unset.
   */
  projectName?: string;
  /** What to tell the model after a 40s wait times out. */
  fallback: FallbackStrategy;
  /** Single long-poll window (ms). */
  waitTimeoutMs: number;
  /** Command shown to the model when the CLI fallback is used. */
  cliCommand: string;
  /** How often the bridge refreshes its online heartbeat. */
  heartbeatIntervalMs: number;
  /** Local client type shown in the dashboard's agent registry. */
  agentKind: AgentKind;
  /**
   * Realtime transport for claims/waits. `auto` tries `/ws/bridge` and falls
   * back to the existing HTTP long polls; `http` disables WS entirely.
   */
  transport: TransportMode;
}

const DEFAULT_HUB_URL = 'http://127.0.0.1:8787';
const DEFAULT_WAIT_TIMEOUT_MS = 40_000;
const MIN_WAIT_TIMEOUT_MS = 1_000;
const MAX_WAIT_TIMEOUT_MS = 55_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readTransport(raw: string | undefined): TransportMode {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'ws' || value === 'http' ? value : 'auto';
}

function readAgentKind(raw: string | undefined): AgentKind {
  const value = (raw ?? '').trim().toLowerCase();
  return (AGENT_KINDS as readonly string[]).includes(value)
    ? (value as AgentKind)
    : 'other';
}

/** Walk up from `start` until a directory containing `.git` is found. */
function findGitRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Derive the project name from the editor workspace.
 *
 * MCP servers are spawned with the workspace as cwd, so the git root (or the
 * cwd itself for non-git folders) is exactly the project OpenCode/Cursor has
 * open. This removes the need to type the project name in the dashboard.
 */
export function detectWorkspaceProject(cwd: string = process.cwd()): string | undefined {
  const workspace = findGitRoot(cwd) ?? resolve(cwd);
  if (workspace === resolve(homedir())) return undefined;

  const name = basename(workspace).trim();
  return name && name !== '.' && name !== '/' ? name : undefined;
}

export function loadBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): BridgeConfig {
  const token = (env.HUB_TOKEN ?? env.HUB_SECRET_TOKEN ?? '').trim();
  if (!token) {
    throw new Error(
      'HUB_TOKEN is required. Set it to the same value as the server HUB_SECRET_TOKEN.',
    );
  }

  const rawUrl = (env.HUB_URL ?? DEFAULT_HUB_URL).trim().replace(/\/+$/, '');
  const projectName =
    (env.ZHUNZOU_PROJECT ?? '').trim() || detectWorkspaceProject(cwd) || '';
  const fallbackRaw = env.ZHUNZOU_FALLBACK ?? env.AGENT_HUB_FALLBACK;
  const waitRaw = env.ZHUNZOU_WAIT_TIMEOUT_MS ?? env.AGENT_HUB_WAIT_TIMEOUT_MS;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(`HUB_URL is not a valid URL: ${rawUrl}`);
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(`HUB_URL must use http or https: ${rawUrl}`);
  }

  return {
    hubUrl: rawUrl,
    token,
    agentEnv: (env.AGENT_ENV ?? '').trim() || `unknown-${hostname()}`,
    ...(projectName ? { projectName } : {}),
    fallback: fallbackRaw === 'mcp' ? 'mcp' : 'cli',
    waitTimeoutMs: clamp(
      readInt(waitRaw, DEFAULT_WAIT_TIMEOUT_MS),
      MIN_WAIT_TIMEOUT_MS,
      MAX_WAIT_TIMEOUT_MS,
    ),
    cliCommand: (env.ZHUNZOU_CLI_COMMAND ?? 'npx zhunzou-bridge').trim(),
    heartbeatIntervalMs: clamp(
      readInt(env.ZHUNZOU_HEARTBEAT_INTERVAL_MS, 30_000),
      5_000,
      300_000,
    ),
    agentKind: readAgentKind(env.ZHUNZOU_AGENT_KIND),
    transport: readTransport(env.ZHUNZOU_TRANSPORT),
  };
}
