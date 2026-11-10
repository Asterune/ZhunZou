import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import type { AgentKind } from '@zhunzou/shared';
import { AGENT_KINDS } from '@zhunzou/shared';

import { fileUriToPath } from './workspaces.js';

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
  /**
   * Where `projectName` came from. Only `cwd` is a guess — an editor that
   * starts the server outside the workspace can make it wrong — so the MCP
   * server may replace it with the workspace the client advertises.
   */
  projectSource?: 'explicit' | 'workspace' | 'cwd';
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
   * Chat session this process is answering, injected by the session daemon.
   * Lets `agent_hub_propose_reply` target the exact conversation instead of
   * guessing from the env.
   */
  chatSessionId?: string;
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

/**
 * Reject values that are not a real project name.
 *
 * A client that does not expand `${workspaceFolderBasename}` hands the literal
 * placeholder to the server process. Reporting it would bind every ticket on
 * that machine to a project called `${…}`, so an unexpanded placeholder counts
 * as "unknown" and lets the other detectors run.
 */
function cleanProjectName(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (!value || value.includes('${') || value.includes('$(')) return undefined;
  return value.slice(0, 128);
}

/**
 * Variables editors use to tell an MCP server which folder is open.
 *
 * Cursor starts stdio servers with a working directory it does not let us
 * control (on Windows it is often not the workspace), but it does hand the
 * process the open folder — `WORKSPACE_FOLDER_PATHS` is the undocumented
 * variable its servers read it from. Treat it as a hint: only an existing
 * directory counts, and cwd remains the fallback when it is absent.
 */
const WORKSPACE_PATH_KEYS = [
  'CURSOR_WORKSPACE_FOLDER',
  'VSCODE_WORKSPACE_FOLDER',
];

/** Paths the client advertises for the open workspace, in declaration order. */
export function workspacePathsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates: string[] = [];
  const raw = env.WORKSPACE_FOLDER_PATHS?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (Array.isArray(parsed)) {
      candidates.push(
        ...parsed.filter((item): item is string => typeof item === 'string'),
      );
    } else {
      // Windows lists use `;`; a single folder is the common case elsewhere.
      candidates.push(...raw.split(/[;\n]/));
    }
  }
  for (const key of WORKSPACE_PATH_KEYS) {
    const single = env[key]?.trim();
    if (single) candidates.push(single);
  }
  return candidates
    .map((candidate) => candidate.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

/** Project of the folder the client says it has open, when it can be read. */
export function detectProjectFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const candidate of workspacePathsFromEnv(env)) {
    if (candidate.includes('${')) continue;
    const path = candidate.startsWith('file://')
      ? fileUriToPath(candidate)
      : candidate;
    if (!path) continue;
    const absolute = resolve(path);
    if (!existsSync(absolute)) continue;
    const name = detectWorkspaceProject(absolute);
    if (name) return name;
  }
  return undefined;
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
  const chatSessionId = (env.ZHUNZOU_CHAT_SESSION_ID ?? '').trim();
  // The client's own idea of the open folder beats cwd: on Windows a global
  // Cursor install starts the server from a directory that is not the
  // workspace (home, System32), which used to leave the project unknown — or
  // worse, name the project after System32.
  const explicitProject = cleanProjectName(env.ZHUNZOU_PROJECT);
  const workspaceProject = explicitProject ? undefined : detectProjectFromEnv(env);
  const cwdProject = explicitProject || workspaceProject
    ? undefined
    : detectWorkspaceProject(cwd);
  const projectName = explicitProject || workspaceProject || cwdProject || '';
  const projectSource: BridgeConfig['projectSource'] = explicitProject
    ? 'explicit'
    : workspaceProject
      ? 'workspace'
      : cwdProject
        ? 'cwd'
        : undefined;
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
    ...(projectSource ? { projectSource } : {}),
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
    ...(chatSessionId && /^\d+$/.test(chatSessionId)
      ? { chatSessionId }
      : {}),
  };
}
