import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, homedir, hostname, platform } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

import type { BridgeConfig } from './config.js';
import { HubClient } from './hub-client.js';
import { createHubApi } from './hub.js';
import { createPresenceReporter } from './presence.js';
import { runSessionDaemon, supportsChat } from './session.js';
import { agentKindForAdapter } from './wake/adapters.js';
import type { WakeAdapterName } from './wake/config.js';
import { WAKE_ADAPTERS, loadWakeConfig } from './wake/config.js';
import { runWakeDaemon } from './wake/daemon.js';

export { agentKindForAdapter } from './wake/adapters.js';

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
const LAUNCHD_LABEL = 'com.zhunzou.fleet';

export function defaultFleetConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface LaunchdOptions {
  nodePath: string;
  cliPath: string;
  configPath: string;
  logDir?: string;
  label?: string;
}

/**
 * Render a launchd plist for `fleet` without touching the filesystem.
 *
 * launchd starts jobs with a minimal PATH, so the plist adds the common
 * locations of cursor-agent / opencode; otherwise the adapter cannot spawn.
 */
export function buildLaunchdPlist(options: LaunchdOptions): string {
  const label = options.label ?? LAUNCHD_LABEL;
  const logDir = options.logDir ?? join(homedir(), 'Library', 'Logs');
  const path = [
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.opencode', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].join(':');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(options.nodePath)}</string>
    <string>${xmlEscape(options.cliPath)}</string>
    <string>fleet</string>
    <string>--config</string>
    <string>${xmlEscape(options.configPath)}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(path)}</string>
    <key>HOME</key>
    <string>${xmlEscape(homedir())}</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>${xmlEscape(homedir())}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logDir, 'zhunzou-fleet.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logDir, 'zhunzou-fleet.error.log'))}</string>
</dict>
</plist>
`;
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

/* ------------------------------------------------------------------ */
/* Editing fleet.json without an editor                                */
/* ------------------------------------------------------------------ */

/** One project entry as stored on disk (token is optional). */
export interface FleetProjectEntry {
  env: string;
  path: string;
  project?: string;
  adapter?: string;
  token?: string;
}

export interface FleetFile {
  hubUrl?: string;
  adminToken?: string;
  adapter?: string;
  tokenCache?: string;
  projects: FleetProjectEntry[];
  /** Untouched top-level keys, so hand-written files keep their extras. */
  extra: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Permissive read (missing file is an empty config, bad JSON is an error). */
export function readFleetFile(path = DEFAULT_CONFIG_PATH): FleetFile {
  const absolute = resolve(expandHome(path));
  if (!existsSync(absolute)) return { projects: [], extra: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(
      `fleet 配置不是合法 JSON：${absolute}\n${(error as Error).message}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`fleet 配置必须是 JSON 对象：${absolute}`);
  }

  const projects: FleetProjectEntry[] = Array.isArray(parsed.projects)
    ? parsed.projects.filter(isRecord).map((project) => ({
        env: String(project.env ?? ''),
        path: String(project.path ?? ''),
        ...(typeof project.project === 'string'
          ? { project: project.project }
          : {}),
        ...(typeof project.adapter === 'string'
          ? { adapter: project.adapter }
          : {}),
        ...(typeof project.token === 'string'
          ? { token: project.token }
          : {}),
      }))
    : [];

  const extra = { ...parsed };
  delete extra.projects;
  delete extra.hubUrl;
  delete extra.adminToken;
  delete extra.adapter;
  delete extra.tokenCache;

  return {
    ...(typeof parsed.hubUrl === 'string' ? { hubUrl: parsed.hubUrl } : {}),
    ...(typeof parsed.adminToken === 'string'
      ? { adminToken: parsed.adminToken }
      : {}),
    ...(typeof parsed.adapter === 'string' ? { adapter: parsed.adapter } : {}),
    ...(typeof parsed.tokenCache === 'string'
      ? { tokenCache: parsed.tokenCache }
      : {}),
    projects,
    extra,
  };
}

export function writeFleetFile(file: FleetFile, path = DEFAULT_CONFIG_PATH): void {
  const absolute = resolve(expandHome(path));
  mkdirSync(dirname(absolute), { recursive: true });
  const payload = {
    ...file.extra,
    ...(file.hubUrl ? { hubUrl: file.hubUrl } : {}),
    ...(file.adminToken ? { adminToken: file.adminToken } : {}),
    ...(file.adapter ? { adapter: file.adapter } : {}),
    ...(file.tokenCache ? { tokenCache: file.tokenCache } : {}),
    projects: file.projects,
  };
  // Tokens live in this file (mode 0600): do not let other users read them.
  writeFileSync(absolute, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export interface FleetAddResult {
  added: FleetProjectEntry[];
  updated: FleetProjectEntry[];
  file: FleetFile;
  configPath: string;
}

/**
 * Upsert projects by env. Re-adding the same env updates its path/token
 * instead of duplicating it, so the command is safe to re-run.
 */
export function addFleetProjects(input: {
  projects: FleetProjectEntry[];
  hubUrl?: string;
  configPath?: string;
}): FleetAddResult {
  const configPath = resolve(expandHome(input.configPath ?? DEFAULT_CONFIG_PATH));
  const file = readFleetFile(configPath);
  const added: FleetProjectEntry[] = [];
  const updated: FleetProjectEntry[] = [];
  const byEnv = new Map(file.projects.map((project) => [project.env, project]));

  for (const project of input.projects) {
    const existing = byEnv.get(project.env);
    const merged: FleetProjectEntry = {
      ...existing,
      ...project,
      // Keep a previously issued token when the caller did not supply one.
      ...(project.token ?? existing?.token
        ? { token: project.token ?? existing!.token! }
        : {}),
    };
    byEnv.set(project.env, merged);
    if (existing) updated.push(merged);
    else added.push(merged);
  }

  const next: FleetFile = {
    ...file,
    ...(input.hubUrl ? { hubUrl: input.hubUrl } : {}),
    projects: [...byEnv.values()],
  };
  writeFleetFile(next, configPath);
  return { added, updated, file: next, configPath };
}

export function removeFleetProject(
  env: string,
  configPath = DEFAULT_CONFIG_PATH,
): boolean {
  const absolute = resolve(expandHome(configPath));
  const file = readFleetFile(absolute);
  const projects = file.projects.filter((project) => project.env !== env);
  if (projects.length === file.projects.length) return false;
  writeFleetFile({ ...file, projects }, absolute);
  return true;
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
    // The fleet runs on this machine, so register the node up-front. Otherwise
    // projects that never wake would sit under "未上报主机" forever.
    host: hostname(),
    os: `${platform()}-${arch()}`,
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
      transport:
        process.env.ZHUNZOU_TRANSPORT === 'http'
          ? 'http'
          : process.env.ZHUNZOU_TRANSPORT === 'ws'
            ? 'ws'
            : 'auto',
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

  const presences = new Map<string, ReturnType<typeof createPresenceReporter>>();
  for (const runtime of runtimes) {
    const reporter = createPresenceReporter(new HubClient(runtime.hub), {
      intervalMs: runtime.hub.heartbeatIntervalMs,
      ...(runtime.hub.projectName
        ? { projectName: runtime.hub.projectName }
        : {}),
      onError: (error) =>
        err(
          `[${runtime.project.env}] heartbeat failed: ${(error as Error).message}`,
        ),
    });
    reporter.start();
    void reporter.beat({ currentTask: 'Runner 已连接' }).catch(() => undefined);
    presences.set(runtime.project.env, reporter);
  }

  const supervise = async (
    runtime: FleetRuntime,
    label: string,
    run: () => Promise<number>,
  ): Promise<void> => {
    const prefix = `[${runtime.project.env}]${label ? ` ${label}` : ''}`;
    for (;;) {
      if (options.signal?.aborted) return;
      try {
        await run();
        if (options.once) return;
        // A clean return only happens on abort; avoid a hot loop otherwise.
        await sleep(DEFAULT_RESTART_DELAY_MS);
      } catch (error) {
        err(`${prefix} loop crashed: ${(error as Error).message}`);
        if (options.once) return;
        await sleep(DEFAULT_RESTART_DELAY_MS);
      }
    }
  };

  const clients: Array<ReturnType<typeof createHubApi>> = [];
  const tasks = runtimes.flatMap((runtime) => {
    const client = createHubApi(runtime.hub);
    clients.push(client);
    const presence = presences.get(runtime.project.env);
    const taskLoop = supervise(runtime, '', () =>
      runWakeDaemon({
        client,
        hub: runtime.hub,
        wake: runtime.wake,
        ...(presence ? { presence } : {}),
        ...(options.once ? { once: true } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        stdout: (line) => out(`[${runtime.project.env}] ${line}`),
        stderr: (line) => err(`[${runtime.project.env}] ${line}`),
      }),
    );

    if (!supportsChat(runtime.wake)) return [taskLoop];

    return [
      taskLoop,
      supervise(runtime, '[chat]', () =>
        runSessionDaemon({
          client,
          hub: runtime.hub,
          wake: runtime.wake,
          ...(presence ? { presence } : {}),
          ...(options.once ? { once: true } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          stdout: (line) => out(`[${runtime.project.env}] [chat] ${line}`),
          stderr: (line) => err(`[${runtime.project.env}] [chat] ${line}`),
        }),
      ),
    ];
  });

  await Promise.allSettled(tasks);
  for (const client of clients) client.close?.();
  for (const presence of presences.values()) presence.stop();
  return 0;
}
