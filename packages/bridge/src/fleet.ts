import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { arch, homedir, hostname, platform } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from 'node:path';

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
import {
  browseDirectory,
  scanProjectDirectories,
  scanRecentWorkspaces,
  type ScanWorkspaceOptions,
} from './workspaces.js';

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
  /** `hub` marks a directory associated from the dashboard. */
  source: z.string().trim().max(32).optional(),
});

/**
 * Optional filesystem discovery: on every `fleet` start, walk these roots and
 * add every git repository to the runtime project list. Discovered projects
 * are not written back to fleet.json, so adding a repository on disk is enough
 * to make it reachable after the next restart.
 */
const fleetScanSchema = z.object({
  /** Directories to search. `~` and paths relative to fleet.json are allowed. */
  roots: z.array(z.string().trim().min(1)).min(1),
  /** Levels below each root to search (1 = direct children). Defaults to 2. */
  depth: z.number().int().min(0).max(8).default(2),
  /** Adapter for discovered projects; defaults to the top-level adapter. */
  adapter: z.enum(WAKE_ADAPTERS).optional(),
});

const fleetConfigSchema = z.object({
  hubUrl: z.string().trim().url(),
  /** Admin token used to register agents and issue scoped tokens. */
  adminToken: z.string().trim().min(1).optional(),
  /** Default adapter for projects that do not override it. */
  adapter: z.enum(WAKE_ADAPTERS).default('auto'),
  /** Where issued tokens are cached. Defaults to ~/.zhunzou/fleet-tokens.json. */
  tokenCache: z.string().trim().min(1).optional(),
  /** Auto-discover git repositories under these roots on every start. */
  scan: fleetScanSchema.optional(),
  projects: z.array(fleetProjectSchema).default([]),
});

export type FleetProject = z.infer<typeof fleetProjectSchema> & {
  absolutePath: string;
  /** True when the project came from discovery, not fleet.json's projects. */
  discovered?: boolean;
  /**
   * True for projects adopted from recent editor workspaces at startup. They
   * are best-effort: without a token they are skipped instead of failing the
   * whole fleet.
   */
  implicit?: boolean;
};
export type FleetConfig = Omit<z.infer<typeof fleetConfigSchema>, 'projects'> & {
  projects: FleetProject[];
  /** Absolute roots resolved from `scan.roots`, ready for filesystem walks. */
  scanRoots?: string[];
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
  /** fleet.json path; required for dashboard-driven add/remove. */
  configPath?: string;
  /** How often to poll the dashboard for associations (defaults to 10s). */
  syncIntervalMs?: number;
  /** How long a directory scan is reused for candidate reports (defaults to 60s). */
  candidateTtlMs?: number;
}

export interface FleetConfigOptions {
  /**
   * When `scan` is absent, adopt git repositories that Cursor / VS Code
   * opened recently as projects. Off by default so tests and one-off config
   * reads (for example `fleet list`) stay deterministic.
   */
  autoDiscover?: boolean;
  /** Platform/home overrides for the workspace reader (tests). */
  workspaces?: ScanWorkspaceOptions;
}

/** Case-fold paths on Windows so the same directory is one project. */
function pathKey(value: string): string {
  const absolute = resolve(value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function isGitRepository(dir: string): boolean {
  try {
    // `.git` is a directory in normal clones and a file in worktrees.
    statSync(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
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
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

/** Env prefix that matches `init` (`opencode-…`, `claude-…`, `agent-…`). */
const ADAPTER_ENV_PREFIX: Record<string, string> = {
  opencode: 'opencode',
  'opencode-run': 'opencode',
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  'cursor-agent': 'cursor',
};

/** `My Project` → `my-project`; kept stable so re-scans reuse the same env. */
export function envSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function defaultEnvForProject(adapter: string, project: string): string {
  const prefix = ADAPTER_ENV_PREFIX[adapter] ?? 'agent';
  return `${prefix}-${envSlug(project) || 'project'}`;
}

/** Append `-2`, `-3`… until the env is free (envs are capped at 64 chars). */
function uniqueEnv(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Load and validate fleet.json, resolving paths relative to the config file. */
export function loadFleetConfig(
  path = DEFAULT_CONFIG_PATH,
  options: FleetConfigOptions = {},
): FleetConfig {
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
  const projects: FleetProject[] = result.data.projects.map((project) => {
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

  let scanRoots: string[] | undefined;
  if (result.data.scan) {
    const roots = result.data.scan.roots.map((root) => {
      const expanded = expandHome(root);
      return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
    });
    scanRoots = roots;

    const discovered = scanProjectDirectories({
      roots,
      depth: result.data.scan.depth,
    });
    const knownPaths = new Set(
      projects.map((project) => pathKey(project.absolutePath)),
    );

    for (const path of discovered) {
      const absolutePath = resolve(path);
      const key = pathKey(absolutePath);
      if (knownPaths.has(key)) continue;
      knownPaths.add(key);

      const project = basename(absolutePath) || 'project';
      const adapter = result.data.scan.adapter ?? result.data.adapter;
      const env = uniqueEnv(defaultEnvForProject(adapter, project), seen);
      seen.add(env);

      projects.push({
        env,
        path: absolutePath,
        project,
        adapter,
        absolutePath,
        discovered: true,
      });
    }
  } else if (options.autoDiscover) {
    // Zero-config mode: projects the human already opened in an editor are a
    // strong signal, so start them without editing fleet.json or clicking
    // "关联" on the dashboard. Only git repositories are adopted.
    const discovered = scanRecentWorkspaces({
      flavors: ['cursor', 'code'],
      ...options.workspaces,
    })
      .flatMap((result) => result.paths)
      .filter(isGitRepository);
    const knownPaths = new Set(
      projects.map((project) => pathKey(project.absolutePath)),
    );

    for (const path of discovered) {
      const absolutePath = resolve(path);
      const key = pathKey(absolutePath);
      if (knownPaths.has(key)) continue;
      knownPaths.add(key);

      const project = basename(absolutePath) || 'project';
      const adapter = result.data.adapter;
      const env = uniqueEnv(defaultEnvForProject(adapter, project), seen);
      seen.add(env);

      projects.push({
        env,
        path: absolutePath,
        project,
        adapter,
        absolutePath,
        discovered: true,
        implicit: true,
      });
    }
  }

  if (projects.length === 0) {
    throw new Error(
      'fleet config has no projects: add projects[], scan.roots to the config, ' +
        'or open a repository in Cursor / VS Code for auto-discovery',
    );
  }

  return {
    ...result.data,
    ...(result.data.tokenCache
      ? { tokenCache: resolve(expandHome(result.data.tokenCache)) }
      : {}),
    projects,
    ...(scanRoots ? { scanRoots } : {}),
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
  /** `hub` means the directory was associated from the dashboard. */
  source?: string;
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
        ...(typeof project.source === 'string'
          ? { source: project.source }
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
      // Implicitly discovered projects are best-effort: without a way to mint
      // a token, skip them instead of refusing to start every explicit project.
      if (project.implicit) continue;
      throw new Error(
        `no token for ${project.env}: set projects[].token, add adminToken, ` +
          'or export HUB_SECRET_TOKEN once.',
      );
    }

    try {
      const issued = await issueToken(config, project, adminToken);
      tokens.set(project.env, issued);
      cache[project.env] = issued;
      cacheDirty = true;
    } catch (error) {
      if (project.implicit) continue;
      throw error;
    }
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

interface RunningFleetProject {
  runtime: FleetRuntime;
  controller: AbortController;
  /** Removes the global-abort listener when the project is stopped. */
  abortChild: () => void;
  presence: ReturnType<typeof createPresenceReporter>;
  client: ReturnType<typeof createHubApi>;
  tasks: Promise<void>[];
}

interface FleetCandidateReport {
  path: string;
  projectName: string;
  env: string;
  adapter: string;
  associated: boolean;
}

/**
 * Run every project's wake loop, restarting a crashed loop with a short
 * backoff. When `configPath` is present, the process also polls the dashboard
 * for directory associations and adds/removes projects at runtime.
 * Returns when the signal aborts (or when --once finishes).
 */
export async function runFleet(
  config: FleetConfig,
  options: FleetOptions = {},
): Promise<number> {
  const out = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  const tokens = await resolveFleetTokens(config, options);
  for (const project of config.projects) {
    if (tokens.has(project.env)) continue;
    err(
      `[fleet] 跳过 ${project.env}（${project.absolutePath}）：需要 adminToken 才能为自动发现的项目签发 Token`,
    );
  }
  const runtimes = buildFleetRuntimes(
    {
      ...config,
      projects: config.projects.filter((project) => tokens.has(project.env)),
    },
    tokens,
  );

  out(
    `[fleet] ${hostname()}: ${runtimes.length} project(s), hub ${config.hubUrl}`,
  );

  const globalController = new AbortController();
  const forwardAbort = () => globalController.abort();
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });

  const running = new Map<string, RunningFleetProject>();

  const startProject = (runtime: FleetRuntime): RunningFleetProject => {
    const existing = running.get(runtime.project.env);
    if (existing) return existing;

    const controller = new AbortController();
    const abortChild = () => controller.abort();
    if (globalController.signal.aborted) controller.abort();
    else {
      globalController.signal.addEventListener('abort', abortChild, {
        once: true,
      });
    }

    const presence = createPresenceReporter(new HubClient(runtime.hub), {
      intervalMs: runtime.hub.heartbeatIntervalMs,
      ...(runtime.hub.projectName
        ? { projectName: runtime.hub.projectName }
        : {}),
      onError: (error) =>
        err(
          `[${runtime.project.env}] heartbeat failed: ${(error as Error).message}`,
        ),
    });
    presence.start();
    void presence.beat({ currentTask: 'Runner 已连接' }).catch(() => undefined);

    const client = createHubApi(runtime.hub);
    const supervise = async (
      label: string,
      run: () => Promise<number>,
    ): Promise<void> => {
      const prefix = `[${runtime.project.env}]${label ? ` ${label}` : ''}`;
      for (;;) {
        if (controller.signal.aborted) return;
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

    const taskLoop = supervise('', () =>
      runWakeDaemon({
        client,
        hub: runtime.hub,
        wake: runtime.wake,
        presence,
        ...(options.once ? { once: true } : {}),
        signal: controller.signal,
        stdout: (line) => out(`[${runtime.project.env}] ${line}`),
        stderr: (line) => err(`[${runtime.project.env}] ${line}`),
      }),
    );
    const tasks = [taskLoop];

    if (supportsChat(runtime.wake)) {
      tasks.push(
        supervise('[chat]', () =>
          runSessionDaemon({
            client,
            hub: runtime.hub,
            wake: runtime.wake,
            presence,
            ...(options.once ? { once: true } : {}),
            signal: controller.signal,
            stdout: (line) => out(`[${runtime.project.env}] [chat] ${line}`),
            stderr: (line) => err(`[${runtime.project.env}] [chat] ${line}`),
          }),
        ),
      );
    }

    const project: RunningFleetProject = {
      runtime,
      controller,
      abortChild,
      presence,
      client,
      tasks,
    };
    running.set(runtime.project.env, project);
    return project;
  };

  const stopProject = async (env: string): Promise<void> => {
    const project = running.get(env);
    if (!project) return;
    running.delete(env);
    globalController.signal.removeEventListener('abort', project.abortChild);
    project.controller.abort();
    project.presence.stop();
    await Promise.allSettled(project.tasks);
    project.client.close?.();
  };

  for (const runtime of runtimes) startProject(runtime);

  if (options.once) {
    await Promise.allSettled(
      [...running.values()].flatMap((project) => project.tasks),
    );
    for (const env of [...running.keys()]) await stopProject(env);
    options.signal?.removeEventListener('abort', forwardAbort);
    return 0;
  }

  const tokenMap = new Map(tokens);
  const known = new Map<string, FleetProject>();
  for (const project of config.projects) {
    known.set(pathKey(project.absolutePath), project);
  }
  const managedEnvs = new Set(
    config.projects
      .filter((project) => project.source === 'hub')
      .map((project) => project.env),
  );
  /** Paths we have advertised to the dashboard (used as an allowlist). */
  const reportedPaths = new Set<string>();
  const configPath = options.configPath;
  const candidateTtlMs = Math.max(10_000, options.candidateTtlMs ?? 60_000);
  let discoveryCache: { at: number; paths: string[] } | undefined;

  /**
   * Directory walks are reused for a minute: the dashboard only needs a fresh
   * candidate list occasionally, and walking `scan.roots` (or the editor
   * history) every 30 seconds is wasted I/O on large trees.
   */
  const discoveredPaths = (): string[] => {
    const now = Date.now();
    if (discoveryCache && now - discoveryCache.at < candidateTtlMs) {
      return discoveryCache.paths;
    }

    const roots = config.scanRoots ?? [];
    const paths =
      roots.length > 0
        ? scanProjectDirectories({
            roots,
            depth: config.scan?.depth ?? 2,
          })
        : [
            ...new Set(
              scanRecentWorkspaces({ flavors: ['cursor', 'code'] }).flatMap(
                (result) => result.paths,
              ),
            ),
          ];
    discoveryCache = { at: now, paths };
    return paths;
  };

  const candidateList = (): FleetCandidateReport[] => {
    const seen = new Set<string>();
    const candidates: FleetCandidateReport[] = [];
    for (const raw of discoveredPaths()) {
      const absolute = resolve(raw);
      const key = pathKey(absolute);
      if (seen.has(key)) continue;
      seen.add(key);

      const current = known.get(key);
      const adapter =
        current?.adapter ?? config.scan?.adapter ?? config.adapter;
      const projectName =
        (current?.project ?? basename(absolute)) || 'project';
      candidates.push({
        path: absolute,
        projectName,
        env: current?.env ?? defaultEnvForProject(adapter, projectName),
        adapter,
        associated: Boolean(current),
      });
    }
    return candidates;
  };

  const allowed = (path: string): boolean => {
    if (!isAbsolute(path)) return false;
    const key = pathKey(path);
    if (reportedPaths.has(key)) return true;
    return (config.scanRoots ?? []).some((root) => {
      const rootKey = pathKey(root);
      return key === rootKey || key.startsWith(`${rootKey}${sep}`);
    });
  };

  const runSync = async (): Promise<void> => {
    if (!configPath) return;

    /**
     * Use a hand-registered project when possible; a dashboard-managed one
     * can be unbound, which also deletes its token.
     */
    const controlClient = (): HubClient | null => {
      const projects = [...running.values()];
      const preferred =
        projects.find((project) => project.runtime.project.source !== 'hub') ??
        projects[0];
      return preferred ? new HubClient(preferred.runtime.hub) : null;
    };

    const interval = Math.max(2_000, options.syncIntervalMs ?? 3_000);
    let tick = 0;

    const reportCandidates = async (): Promise<void> => {
      const client = controlClient();
      if (!client) return;
      const candidates = candidateList();
      for (const candidate of candidates) {
        reportedPaths.add(pathKey(candidate.path));
      }
      await client.reportFleetCandidates({
        host: hostname(),
        roots: config.scanRoots ?? [],
        ...(config.scan?.depth !== undefined
          ? { depth: config.scan.depth }
          : {}),
        candidates,
      });
    };

    const syncDesired = async (): Promise<void> => {
      const client = controlClient();
      if (!client) return;
      const { workspaces, browse } = await client.listDesiredWorkspaces();

      // Answer filesystem picker requests before applying associations, so a
      // directory the human just browsed can be associated in the same cycle.
      for (const request of browse ?? []) {
        try {
          const result = browseDirectory({
            path: request.path,
            home: homedir(),
            roots: config.scanRoots ?? [],
          });
          reportedPaths.add(pathKey(result.path));
          for (const entry of result.entries) {
            reportedPaths.add(pathKey(entry.path));
          }

          await client.reportFleetBrowseResult(request.id, {
            current: {
              path: result.path,
              ...(result.parent ? { parent: result.parent } : {}),
              home: result.home,
              isRepo: result.isRepo,
              adapter: config.adapter,
            },
            entries: result.entries,
          });
        } catch (error) {
          await client
            .reportFleetBrowseResult(request.id, {
              entries: [],
              error: (error as Error).message,
            })
            .catch(() => undefined);
        }
      }

      const desiredPaths = new Set<string>();

      for (const workspace of workspaces) {
        const absolute = resolve(workspace.path);
        const key = pathKey(absolute);
        desiredPaths.add(key);
        const existing = known.get(key);

        if (existing) {
          if (existing.env !== workspace.env) {
            if (workspace.status !== 'FAILED') {
              await client.reportFleetWorkspaceStatus(workspace.id, {
                status: 'FAILED',
                error: `目录已由 ${existing.env} 托管`,
              });
            }
            continue;
          }

          if (!running.has(existing.env)) {
            const token = tokenMap.get(existing.env);
            if (!token) {
              if (workspace.status !== 'FAILED') {
                await client.reportFleetWorkspaceStatus(workspace.id, {
                  status: 'FAILED',
                  error: '本地缺少 Token，请重试',
                });
              }
              continue;
            }
            startProject(
              buildFleetRuntimes(
                { ...config, projects: [existing] },
                new Map([[existing.env, token]]),
              )[0]!,
            );
          }

          if (workspace.status !== 'APPLIED') {
            await client.reportFleetWorkspaceStatus(workspace.id, {
              status: 'APPLIED',
            });
          }
          continue;
        }

        let directoryOk = false;
        try {
          directoryOk =
            allowed(absolute) &&
            statSync(absolute).isDirectory() &&
            existsSync(join(absolute, '.git'));
        } catch {
          directoryOk = false;
        }
        if (!directoryOk) {
          if (workspace.status !== 'FAILED') {
            await client.reportFleetWorkspaceStatus(workspace.id, {
              status: 'FAILED',
              error: '目录不在可关联范围内，或不是 Git 仓库',
            });
          }
          continue;
        }

        if (!workspace.token) {
          if (workspace.status !== 'FAILED') {
            await client.reportFleetWorkspaceStatus(workspace.id, {
              status: 'FAILED',
              error: '尚未下发 Token，请重试',
            });
          }
          continue;
        }

        try {
          addFleetProjects({
            configPath,
            projects: [
              {
                env: workspace.env,
                path: absolute,
                project: workspace.projectName,
                ...(workspace.adapter ? { adapter: workspace.adapter } : {}),
                token: workspace.token,
                source: 'hub',
              },
            ],
          });

          const project: FleetProject = {
            env: workspace.env,
            path: absolute,
            absolutePath: absolute,
            project: workspace.projectName,
            ...(workspace.adapter
              ? { adapter: workspace.adapter as WakeAdapterName }
              : {}),
            source: 'hub',
          };
          known.set(pathKey(absolute), project);
          tokenMap.set(workspace.env, workspace.token);
          managedEnvs.add(workspace.env);
          startProject(
            buildFleetRuntimes(
              { ...config, projects: [project] },
              new Map([[workspace.env, workspace.token]]),
            )[0]!,
          );
          await client.reportFleetWorkspaceStatus(workspace.id, {
            status: 'APPLIED',
          });
          out(`[fleet] 已关联 ${workspace.env} → ${absolute}`);
        } catch (error) {
          const message = (error as Error).message;
          err(`[fleet] ${workspace.env} 关联失败: ${message}`);
          await client
            .reportFleetWorkspaceStatus(workspace.id, {
              status: 'FAILED',
              error: message,
            })
            .catch(() => undefined);
        }
      }

      // Dashboard-managed projects disappear as soon as the human unbinds them.
      for (const env of [...managedEnvs]) {
        const project = [...known.values()].find((item) => item.env === env);
        if (!project) {
          managedEnvs.delete(env);
          continue;
        }
        const absolute = resolve(project.absolutePath);
        if (desiredPaths.has(pathKey(absolute))) continue;

        try {
          removeFleetProject(env, configPath);
          await stopProject(env);
          known.delete(pathKey(absolute));
          managedEnvs.delete(env);
          tokenMap.delete(env);
          out(`[fleet] 已解除 ${env} → ${absolute}`);
        } catch (error) {
          err(
            `[fleet] ${env} 解除失败: ${(error as Error).message}`,
          );
        }
      }
    };

    const runOnce = async (): Promise<void> => {
      if (tick % 10 === 0) {
        try {
          await reportCandidates();
        } catch (error) {
          err(`[fleet] 上报可关联目录失败: ${(error as Error).message}`);
        }
      }
      tick += 1;
      try {
        await syncDesired();
      } catch (error) {
        err(`[fleet] 同步看板目录失败: ${(error as Error).message}`);
      }
    };

    try {
      await runOnce();
    } catch (error) {
      err(`[fleet] 首次同步失败: ${(error as Error).message}`);
    }
    const timer = setInterval(() => {
      void runOnce().catch((error) => {
        err(`[fleet] 同步失败: ${(error as Error).message}`);
      });
    }, interval);
    timer.unref?.();

    await new Promise<void>((resolve) => {
      if (globalController.signal.aborted) {
        clearInterval(timer);
        resolve();
        return;
      }
      globalController.signal.addEventListener(
        'abort',
        () => {
          clearInterval(timer);
          resolve();
        },
        { once: true },
      );
    });
  };

  const syncLoop = configPath ? runSync() : Promise.resolve();

  await new Promise<void>((resolve) => {
    if (globalController.signal.aborted) {
      resolve();
      return;
    }
    globalController.signal.addEventListener('abort', () => resolve(), {
      once: true,
    });
  });

  await Promise.allSettled([...running.keys()].map(stopProject));
  await syncLoop;
  options.signal?.removeEventListener('abort', forwardAbort);
  return 0;
}
