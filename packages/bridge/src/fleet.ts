import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { AgentKind } from '@zhunzou/shared';
import { z } from 'zod';

import type { BridgeConfig } from './config.js';
import { HubClient } from './hub-client.js';
import type { WakeAdapterName } from './wake/config.js';
import { WAKE_ADAPTERS, loadWakeConfig } from './wake/config.js';
import { runWakeDaemon } from './wake/daemon.js';

/**
 * A machine-level supervisor for many projects.
 *
 * `wake` handles one env (one project directory). `fleet` keeps one wake loop
 * per project in a single process, so the hub can dispatch tasks to any
 * workspace without an editor being open and without one terminal per repo.
 */

const fleetProjectSchema = z.object({
  /** Agent identity shown on the dashboard; must be unique per project. */
  env: z.string().trim().min(1).max(64),
  /** Project directory the agent runs in. Supports ~ and relative paths. */
  path: z.string().trim().min(1),
  /** Project name reported to the hub; defaults to the directory name. */
  project: z.string().trim().min(1).max(128).optional(),
  /** Per-project adapter override. */
  adapter: z.enum(WAKE_ADAPTERS).optional(),
  /** Per-project token; otherwise fleet issues and caches one. */
  token: z.string().trim().min(1).optional(),
  /** Extra args for preset adapters (e.g. ["--model","gpt-5"]). */
  args: z.array(z.string()).optional(),
  /** Shell template for the command adapter. */
  command: z.string().min(1).optional(),
});

const fleetConfigSchema = z.object({
  hubUrl: z.string().trim().url(),
  /** Admin token used to register agents and issue scoped tokens. */
  adminToken: z.string().trim().min(1).optional(),
  /** Default adapter for projects that do not override it. */
  adapter: z.enum(WAKE_ADAPTERS).default('auto'),
  /** Where issued tokens are cached. Defaults to ~/.zhunzou/fleet-tokens.json. */
  tokenCache: z.string().trim().min(1).optional(),
  projects: z.array(fleetProjectSchema).min(1),
});

export type FleetProject = z.infer<typeof fleetProjectSchema> & {
  absolutePath: string;
};
export type FleetConfig = Omit<z.infer<typeof fleetConfigSchema>, 'projects'> & {
  projects: FleetProject[];
};

export interface FleetRuntime {
  project: FleetProject;
  hub: BridgeConfig;
  wake: ReturnType<typeof loadWakeConfig>;
}

export interface FleetOptions {
  once?: boolean;
  signal?: AbortSignal;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Override the token cache path (tests / custom installs). */
  tokenCachePath?: string;
  /** Rotate tokens even when a cached one exists. */
  refreshTokens?: boolean;
}

const DEFAULT_CONFIG_PATH = join(homedir(), '.zhunzou', 'fleet.json');
const DEFAULT_CACHE_PATH = join(homedir(), '.zhunzou', 'fleet-tokens.json');
const DEFAULT_RESTART_DELAY_MS = 2_000;

export function defaultFleetConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}

export function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/** Load and validate fleet.json, resolving paths relative to the config file. */
export function loadFleetConfig(path = DEFAULT_CONFIG_PATH): FleetConfig {
  const absolute = resolve(expandHome(path));
  if (!existsSync(absolute)) {
    throw new Error(
      `fleet config not found: ${absolute}\n` +
        'Create it from packages/bridge/templates/fleet.example.json, or pass --config <path>.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`fleet config is not valid JSON: ${(error as Error).message}`);
  }

  const result = fleetConfigSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid fleet config: ${detail}`);
  }

  const baseDir = dirname(absolute);
  const seen = new Set<string>();
  const projects = result.data.projects.map((project) => {
    if (seen.has(project.env)) {
      throw new Error(`duplicate env in fleet config: ${project.env}`);
    }
    seen.add(project.env);

    const rawPath = expandHome(project.path);
    return {
      ...project,
      absolutePath: isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath),
    };
  });

  return {
    ...result.data,
    ...(result.data.tokenCache
      ? { tokenCache: resolve(expandHome(result.data.tokenCache)) }
      : {}),
    projects,
  };
}

export function agentKindForAdapter(adapter: WakeAdapterName): AgentKind {
  switch (adapter) {
    case 'opencode':
    case 'opencode-run':
      return 'opencode';
    case 'cursor-agent':
      return 'cursor';
    case 'claude':
      return 'claude-code';
    case 'codex':
      return 'codex';
    case 'gemini':
      return 'gemini';
    default:
      return 'other';
  }
}

/* ------------------------------------------------------------------ */
/* Token provisioning                                                  */
/* ------------------------------------------------------------------ */

type TokenCache = Record<string, string>;

function cachePathFor(config: FleetConfig, options: FleetOptions): string {
  return (
    options.tokenCachePath ??
    config.tokenCache ??
    DEFAULT_CACHE_PATH
  );
}

function readTokenCache(path: string): TokenCache {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function writeTokenCache(path: string, cache: TokenCache): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function postJson(
  url: string,
  token: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep null; the error below includes the raw body
  }

  if (!response.ok) {
    const message =
      typeof parsed === 'object' && parsed !== null
        ? ((parsed as { error?: { message?: string } }).error?.message ??
          text.slice(0, 300))
        : text.slice(0, 300);
    throw new Error(`hub returned ${response.status}: ${message}`);
  }

  return parsed;
}

/** Register the agent (idempotent) and issue a scoped token. */
async function issueToken(
  config: FleetConfig,
  project: FleetProject,
  adminToken: string,
): Promise<string> {
  await postJson(`${config.hubUrl.replace(/\/+$/, '')}/api/agents`, adminToken, {
    env: project.env,
    name: project.project ?? basename(project.absolutePath),
    kind: agentKindForAdapter(project.adapter ?? config.adapter),
  });

  const body = (await postJson(
    `${config.hubUrl.replace(/\/+$/, '')}/api/agents/${encodeURIComponent(project.env)}/token`,
    adminToken,
  )) as { token?: unknown } | null;

  if (typeof body?.token !== 'string' || !body.token) {
    throw new Error(`hub did not return a token for ${project.env}`);
  }
  return body.token;
}

/**
 * Resolve a working token for every project.
 *
 * Priority: explicit config token → cached token → issue a new one with the
 * admin token. Tokens are scoped, so leaking the config does not expose the
 * whole hub.
 */
export async function resolveFleetTokens(
  config: FleetConfig,
  options: FleetOptions = {},
): Promise<Map<string, string>> {
  const cachePath = cachePathFor(config, options);
  const cache = readTokenCache(cachePath);
  const adminToken = (
    config.adminToken ??
    process.env.HUB_SECRET_TOKEN ??
    ''
  ).trim();

  const tokens = new Map<string, string>();
  let cacheDirty = false;

  for (const project of config.projects) {
    if (project.token) {
      tokens.set(project.env, project.token);
      continue;
    }

    if (!options.refreshTokens && cache[project.env]) {
      tokens.set(project.env, cache[project.env]!);
      continue;
    }

    if (!adminToken) {
      throw new Error(
        `no token for ${project.env}: set projects[].token, add adminToken, ` +
          'or export HUB_SECRET_TOKEN once.',
      );
    }

    const issued = await issueToken(config, project, adminToken);
    tokens.set(project.env, issued);
    cache[project.env] = issued;
    cacheDirty = true;
  }

  if (cacheDirty) writeTokenCache(cachePath, cache);
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Runtime construction & supervision                                  */
/* ------------------------------------------------------------------ */

export function buildFleetRuntimes(
  config: FleetConfig,
  tokens: Map<string, string>,
): FleetRuntime[] {
  const hubUrl = config.hubUrl.replace(/\/+$/, '');

  return config.projects.map((project) => {
    const adapter = project.adapter ?? config.adapter;
    const token = tokens.get(project.env);
    if (!token) throw new Error(`missing token for ${project.env}`);

    const hub: BridgeConfig = {
      hubUrl,
      token,
      agentEnv: project.env,
      projectName: project.project ?? basename(project.absolutePath),
      fallback: 'cli',
      waitTimeoutMs: 40_000,
      cliCommand: 'npx zhunzou-bridge',
      heartbeatIntervalMs: 30_000,
      agentKind: agentKindForAdapter(adapter),
    };

    const wake = loadWakeConfig(
      {
        ...process.env,
        ZHUNZOU_WAKE_ADAPTER: adapter,
        ZHUNZOU_WAKE_CWD: project.absolutePath,
        ...(project.command ? { ZHUNZOU_WAKE_COMMAND: project.command } : {}),
      },
      project.absolutePath,
    );
    if (project.args?.length) {
      wake.extraArgs = project.args;
    }

    return { project, hub, wake };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Run every project's wake loop, restarting a crashed loop with a short
 * backoff. Returns when the signal aborts (or when --once finishes).
 */
export async function runFleet(
  config: FleetConfig,
  options: FleetOptions = {},
): Promise<number> {
  const tokens = await resolveFleetTokens(config, options);
  const runtimes = buildFleetRuntimes(config, tokens);
  const out = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  out(
    `[fleet] ${hostname()}: ${runtimes.length} project(s), hub ${config.hubUrl}`,
  );

  const tasks = runtimes.map(async (runtime) => {
    const prefix = `[${runtime.project.env}]`;
    for (;;) {
      if (options.signal?.aborted) return;
      try {
        await runWakeDaemon({
          client: new HubClient(runtime.hub),
          hub: runtime.hub,
          wake: runtime.wake,
          ...(options.once ? { once: true } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          stdout: (line) => out(`${prefix} ${line}`),
          stderr: (line) => err(`${prefix} ${line}`),
        });
        if (options.once) return;
        // A clean return only happens on abort; avoid a hot loop otherwise.
        await sleep(DEFAULT_RESTART_DELAY_MS);
      } catch (error) {
        err(`${prefix} loop crashed: ${(error as Error).message}`);
        if (options.once) return;
        await sleep(DEFAULT_RESTART_DELAY_MS);
      }
    }
  });

  await Promise.allSettled(tasks);
  return 0;
}
