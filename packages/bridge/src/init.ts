import { arch, homedir, hostname, platform } from 'node:os';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import type { AgentKind } from '@zhunzou/shared';

import { installService } from './service.js';
import { BRIDGE_VERSION } from './version.js';

export type InitTarget = 'cursor' | 'opencode' | 'claude' | 'codex' | 'all';

/** Targets that own a config file; `all` expands to these. */
export type ClientTarget = Exclude<InitTarget, 'all'>;

const CLIENT_TARGETS: readonly ClientTarget[] = [
  'cursor',
  'opencode',
  'claude',
  'codex',
];

export interface InitSettings {
  hubUrl: string;
  token: string;
  agentEnv: string;
  projectName?: string;
  fallback: 'cli' | 'mcp';
  mcpCommand: string[];
  cliCommand: string;
  waitTimeoutMs: number;
  heartbeatIntervalMs: number;
  agentKind: AgentKind;
}

export interface InitOptions {
  hubUrl?: string;
  token?: string;
  env?: string;
  project?: string;
  target?: string;
  dir?: string;
  yes?: boolean;
  skipCheck?: boolean;
  dryRun?: boolean;
  /** Override the client type written to ZHUNZOU_AGENT_KIND. */
  agentKind?: string;
  /** Keep using the admin token instead of provisioning a scoped one. */
  noAgentToken?: boolean;
  /** One-time code from the dashboard; replaces HUB_TOKEN entirely. */
  code?: string;
  /** Write editor configs into the user's global config, not the workspace. */
  global?: boolean;
  /** Register a login-time daemon so the device stays online. */
  service?: boolean;
}

const DEFAULT_HUB_URL = 'http://127.0.0.1:8787';
const WAIT_TIMEOUT_MS = 40_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function localBin(name: 'mcp' | 'cli'): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // Layouts we may be running from:
  //   standalone one-click bundle → <dir>/mcp.mjs (flat)
  //   source / npm package        → <dir>/../bin/mcp.js
  const candidates = [
    join(here, `${name}.mjs`),
    join(here, '..', 'bin', `${name}.js`),
  ];
  for (const candidate of candidates) {
    // npx caches are temporary; prefer the stable npm package name there.
    if (existsSync(candidate) && !candidate.includes('_npx')) return candidate;
  }
  return null;
}

export function buildSettings(
  input: {
    hubUrl: string;
    token: string;
    agentEnv: string;
    projectName?: string;
    fallback?: 'cli' | 'mcp';
    agentKind?: AgentKind;
  },
): InitSettings {
  // The one-click bootstrap pins the stable root entry points so an upgrade
  // can flip `current.json` without rewriting editor configs.
  const mcpBin = process.env.ZHUNZOU_MCP_BIN || localBin('mcp');
  const cliBin = process.env.ZHUNZOU_CLI_BIN || localBin('cli');

  return {
    hubUrl: input.hubUrl.trim().replace(/\/+$/, ''),
    token: input.token.trim(),
    agentEnv: input.agentEnv.trim(),
    ...(input.projectName?.trim()
      ? { projectName: input.projectName.trim() }
      : {}),
    fallback: input.fallback ?? 'cli',
    // `npx zhunzou-mcp` would look for a *package* named zhunzou-mcp; the bin
    // lives in zhunzou-bridge, so point npx at the package explicitly.
    mcpCommand: mcpBin
      ? ['node', mcpBin]
      : ['npx', '-y', '--package', 'zhunzou-bridge', 'zhunzou-mcp'],
    // Quote both paths: Windows user directories commonly contain spaces.
    cliCommand: cliBin
      ? `"${process.execPath}" "${cliBin}"`
      : 'npx zhunzou-bridge',
    waitTimeoutMs: WAIT_TIMEOUT_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    agentKind: input.agentKind ?? 'other',
  };
}

export function buildMcpEnv(settings: InitSettings): Record<string, string> {
  return {
    HUB_URL: settings.hubUrl,
    HUB_TOKEN: settings.token,
    AGENT_ENV: settings.agentEnv,
    ZHUNZOU_FALLBACK: settings.fallback,
    ZHUNZOU_WAIT_TIMEOUT_MS: String(settings.waitTimeoutMs),
    ZHUNZOU_HEARTBEAT_INTERVAL_MS: String(settings.heartbeatIntervalMs),
    ZHUNZOU_AGENT_KIND: settings.agentKind,
    ZHUNZOU_CLI_COMMAND: settings.cliCommand,
    ...(settings.projectName
      ? { ZHUNZOU_PROJECT: settings.projectName }
      : {}),
  };
}

function stdioServer(settings: InitSettings): Record<string, unknown> {
  return {
    command: settings.mcpCommand[0],
    args: settings.mcpCommand.slice(1),
    env: buildMcpEnv(settings),
  };
}

export function mergeCursorConfig(
  existing: unknown,
  settings: InitSettings,
): Record<string, unknown> {
  const base = isRecord(existing) ? existing : {};
  const servers = isRecord(base.mcpServers) ? base.mcpServers : {};

  return {
    ...base,
    mcpServers: {
      ...servers,
      zhunzou: stdioServer(settings),
    },
  };
}

export function mergeClaudeConfig(
  existing: unknown,
  settings: InitSettings,
): Record<string, unknown> {
  return mergeCursorConfig(existing, settings);
}

export function mergeOpenCodeConfig(
  existing: unknown,
  settings: InitSettings,
): Record<string, unknown> {
  const base = isRecord(existing) ? existing : {};
  const mcp = isRecord(base.mcp) ? { ...base.mcp } : {};
  const servers = isRecord(mcp.servers) ? mcp.servers : {};

  // OpenCode V2 keeps MCP servers under `mcp.servers`. Drop the legacy
  // top-level `mcp.zhunzou` entry written by older bridge versions so the
  // config does not contain two competing definitions.
  delete mcp.zhunzou;
  delete mcp.servers;

  return {
    ...base,
    $schema: base.$schema ?? 'https://opencode.ai/config.json',
    mcp: {
      ...mcp,
      servers: {
        ...servers,
        zhunzou: {
          type: 'local',
          command: settings.mcpCommand,
          enabled: true,
          environment: buildMcpEnv(settings),
        },
      },
    },
  };
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error(
      `${path} 不是合法 JSON，已停止，避免覆盖你的现有配置。`,
    );
  }
}

function writeJson(path: string, data: unknown, dryRun: boolean): void {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (dryRun) {
    process.stdout.write(`\n--- ${path} ---\n${text}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  process.stdout.write(`✓ 已写入 ${path}\n`);
}

/* ------------------------------------------------------------------ */
/* Codex CLI (TOML)                                                    */
/* ------------------------------------------------------------------ */

/** TOML basic string; Windows paths need their backslashes escaped. */
function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')}"`;
}

export function codexServerBlock(settings: InitSettings): string {
  const env = Object.entries(buildMcpEnv(settings))
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(', ');
  const args = settings.mcpCommand.slice(1).map(tomlString).join(', ');
  return [
    '[mcp_servers.zhunzou]',
    `command = ${tomlString(settings.mcpCommand[0] ?? 'node')}`,
    `args = [${args}]`,
    `env = { ${env} }`,
    '',
  ].join('\n');
}

const CODEX_ZHUNZOU_SECTION =
  /^\[mcp_servers\.zhunzou(?:\.[^\]]*)?\]\s*(?:#.*)?$/;

/**
 * Codex has no JSON config: it reads `$CODEX_HOME/config.toml`.
 *
 * The bridge does not bundle a TOML parser, so replace only our own section
 * and keep every other line byte-for-byte. Dotted keys such as
 * `mcp_servers.zhunzou.env.X = "…"` are not recognised; the block written
 * here uses an inline table instead.
 */
export function mergeCodexConfig(
  existing: string,
  settings: InitSettings,
): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of existing.split(/\r?\n/)) {
    if (CODEX_ZHUNZOU_SECTION.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (/^\s*\[/.test(line)) skipping = false;
      else continue;
    }
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop();
  const head = kept.join('\n');
  return `${head}${head ? '\n\n' : ''}${codexServerBlock(settings)}`;
}

function readText(path: string): string {
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`${path} 读取失败：${(error as Error).message}`);
  }
}

function writeText(path: string, text: string, dryRun: boolean): void {
  if (dryRun) {
    process.stdout.write(`\n--- ${path} ---\n${text}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  process.stdout.write(`✓ 已写入 ${path}\n`);
}

interface InitIdentity {
  target: ClientTarget;
  kind: AgentKind;
  env: string;
  token: string;
}

/** Write exactly one client's MCP config (the per-client mode calls it N times). */
function writeClientConfig(
  target: ClientTarget,
  settings: InitSettings,
  options: InitOptions,
  dir: string,
): void {
  const dryRun = Boolean(options.dryRun);
  if (target === 'cursor') {
    const path = options.global
      ? globalConfigFile('cursor')
      : join(dir, '.cursor', 'mcp.json');
    writeJson(
      path,
      mergeCursorConfig(readJson(path), settings),
      dryRun,
    );
    // Cursor user rules live in the app settings, not a file; project
    // installs can still drop .cursorrules next to the workspace.
    if (!options.global) copyCursorRules(dir, dryRun);
    return;
  }

  if (target === 'opencode') {
    const path = options.global
      ? globalConfigFile('opencode')
      : join(dir, 'opencode.json');
    writeJson(
      path,
      mergeOpenCodeConfig(readJson(path), settings),
      dryRun,
    );
    if (options.global) {
      const instruction = globalInstructionFile('opencode')!;
      upsertInstructionFile(
        instruction.dir,
        instruction.file,
        instruction.template,
        dryRun,
      );
    } else {
      upsertInstructionFile(dir, 'AGENTS.md', 'AGENTS.md', dryRun);
    }
    return;
  }

  if (target === 'claude') {
    const path = options.global
      ? globalConfigFile('claude')
      : join(dir, '.mcp.json');
    writeJson(
      path,
      mergeClaudeConfig(readJson(path), settings),
      dryRun,
    );
    if (options.global) {
      const instruction = globalInstructionFile('claude')!;
      upsertInstructionFile(
        instruction.dir,
        instruction.file,
        instruction.template,
        dryRun,
      );
    }
    return;
  }

  // Codex only reads `$CODEX_HOME/config.toml` (default ~/.codex), even for a
  // workspace install, so the file is always user-level.
  const path = globalConfigFile('codex');
  writeText(path, mergeCodexConfig(readText(path), settings), dryRun);
  if (options.global) {
    const instruction = globalInstructionFile('codex')!;
    upsertInstructionFile(
      instruction.dir,
      instruction.file,
      instruction.template,
      dryRun,
    );
  } else {
    upsertInstructionFile(dir, 'AGENTS.md', 'AGENTS.md', dryRun);
  }
}

/**
 * One daemon, several client envs: `fleet` already knows how to keep one wake
 * loop per env, so the login service points at a generated fleet.json instead
 * of a single `wake --cwd`.
 *
 * Existing projects are preserved; entries are upserted by env.
 */
function writeFleetConfig(
  identities: InitIdentity[],
  hubUrl: string,
  cwd: string,
  projectName: string | undefined,
): string {
  const path = join(homedir(), '.zhunzou', 'fleet.json');
  let base: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (isRecord(parsed)) base = parsed;
    } catch {
      process.stdout.write(`! ${path} 不是合法 JSON，已重建\n`);
    }
  }

  const projects = Array.isArray(base.projects)
    ? base.projects.filter(isRecord)
    : [];
  const byEnv = new Map<string, Record<string, unknown>>();
  for (const project of projects) {
    if (typeof project.env === 'string') byEnv.set(project.env, project);
  }
  for (const identity of identities) {
    byEnv.set(identity.env, {
      env: identity.env,
      path: cwd,
      adapter: 'auto',
      token: identity.token,
      ...(projectName ? { project: projectName } : {}),
    });
  }

  const next = {
    ...base,
    hubUrl: hubUrl.replace(/\/+$/, ''),
    projects: [...byEnv.values()],
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  process.stdout.write(`✓ 已写入 ${path}（${byEnv.size} 个客户端）\n`);
  return path;
}

function detectTarget(dir: string): InitTarget {
  if (existsSync(join(dir, '.cursor'))) return 'cursor';
  if (existsSync(join(dir, 'opencode.json'))) return 'opencode';
  if (existsSync(join(dir, '.mcp.json'))) return 'claude';
  return 'cursor';
}

function parseTarget(raw: string | undefined, fallback: InitTarget): InitTarget {
  if (!raw) return fallback;
  const value = raw.toLowerCase();
  if (
    value === 'cursor' ||
    value === 'opencode' ||
    value === 'claude' ||
    value === 'codex' ||
    value === 'all'
  ) {
    return value;
  }
  throw new Error(
    `未知 target "${raw}"，可选 cursor / opencode / claude / codex / all`,
  );
}

function kindForTarget(target: InitTarget): AgentKind {
  if (target === 'cursor') return 'cursor';
  if (target === 'opencode') return 'opencode';
  if (target === 'claude') return 'claude-code';
  if (target === 'codex') return 'codex';
  return 'other';
}

function envSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '')
    .replace(/^-+|-+$/g, '');
}

/** `cursor-yikuaomed-erp`, so each client/workspace becomes a separate agent. */
function defaultAgentEnv(kind: AgentKind, project: string): string {
  const prefix =
    kind === 'cursor'
      ? 'cursor'
      : kind === 'opencode'
        ? 'opencode'
        : kind === 'claude-code'
          ? 'claude'
          : kind === 'codex'
            ? 'codex'
            : kind === 'gemini'
              ? 'gemini'
              : kind === 'windsurf'
                ? 'windsurf'
                : 'agent';
  const slug = envSlug(project) || envSlug(hostname()) || 'agent';
  return `${prefix}-${slug}`.slice(0, 64);
}

function parseAgentKind(raw: string | undefined): AgentKind | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  const allowed: AgentKind[] = [
    'cursor',
    'opencode',
    'claude-code',
    'codex',
    'gemini',
    'windsurf',
    'other',
  ];
  if (!allowed.includes(value as AgentKind)) {
    throw new Error(
      `未知 agent kind "${raw}"，可选 ${allowed.join(' / ')}`,
    );
  }
  return value as AgentKind;
}

/**
 * Ask the hub for a scoped token. Falls back to the admin token when the
 * server is older than the agent registry, so `init` keeps working.
 */
async function provisionAgentToken(
  settings: InitSettings,
): Promise<string | null> {
  const url = `${settings.hubUrl}/api/agents/${encodeURIComponent(settings.agentEnv)}/token`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${settings.token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return null;

  const body = (await response.json().catch(() => null)) as
    | { token?: unknown }
    | null;
  return typeof body?.token === 'string' && body.token ? body.token : null;
}

/**
 * Exchange a one-time dashboard code for a scoped agent token.
 *
 * This is the only network call a one-click install needs before writing
 * configs: it both proves connectivity and removes the admin token from the
 * end user's machine.
 */
async function exchangeEnrollmentCode(input: {
  hubUrl: string;
  code: string;
  env: string;
  host: string;
  os: string;
  kind: AgentKind;
  projectName?: string;
  version?: string;
}): Promise<{ token: string; env: string; projectName?: string }> {
  const response = await fetch(
    `${input.hubUrl.replace(/\/+$/, '')}/api/enroll`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: input.code.trim(),
        env: input.env,
        host: input.host,
        os: input.os,
        kind: input.kind,
        ...(input.projectName ? { projectName: input.projectName } : {}),
        ...(input.version ? { version: input.version } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );

  const body = (await response.json().catch(() => null)) as
    | {
        token?: unknown;
        env?: unknown;
        projectName?: unknown;
        error?: { message?: unknown };
      }
    | null;

  if (!response.ok) {
    const message =
      typeof body?.error?.message === 'string'
        ? body.error.message
        : `接入码兑换失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  if (typeof body?.token !== 'string' || !body.token) {
    throw new Error('服务端未返回 Token，请确认 hub 已升级到支持一键接入的版本');
  }

  return {
    token: body.token,
    env: typeof body.env === 'string' && body.env ? body.env : input.env,
    ...(typeof body.projectName === 'string' && body.projectName
      ? { projectName: body.projectName }
      : {}),
  };
}

/** Codex keeps a single user-level config; CODEX_HOME relocates it. */
function codexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  return raw ? resolve(raw) : join(homedir(), '.codex');
}

/** Global (user-level) config locations, so one install covers all projects. */
function globalTargetDir(target: Exclude<InitTarget, 'all'>): string {
  const configHome =
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  if (target === 'cursor') return join(homedir(), '.cursor');
  if (target === 'opencode') return join(configHome, 'opencode');
  if (target === 'codex') return codexHome();
  return homedir();
}

function globalConfigFile(target: Exclude<InitTarget, 'all'>): string {
  if (target === 'cursor') return join(globalTargetDir(target), 'mcp.json');
  if (target === 'opencode') {
    return join(globalTargetDir(target), 'opencode.json');
  }
  if (target === 'codex') return join(globalTargetDir(target), 'config.toml');
  return join(homedir(), '.claude.json');
}

function globalInstructionFile(target: Exclude<InitTarget, 'all'>): {
  dir: string;
  file: string;
  template: string;
} | null {
  if (target === 'opencode') {
    return {
      dir: globalTargetDir(target),
      file: 'AGENTS.md',
      template: 'AGENTS.md',
    };
  }
  if (target === 'codex') {
    return {
      dir: globalTargetDir(target),
      file: 'AGENTS.md',
      template: 'AGENTS.md',
    };
  }
  if (target === 'claude') {
    return {
      dir: join(homedir(), '.claude'),
      file: 'CLAUDE.md',
      template: 'AGENTS.md',
    };
  }
  return null;
}

async function checkHub(settings: InitSettings): Promise<string> {
  const signal = AbortSignal.timeout(5_000);

  try {
    const health = await fetch(`${settings.hubUrl}/healthz`, { signal });
    if (!health.ok) {
      throw new Error(`/healthz 返回 ${health.status}`);
    }

    const status = await fetch(`${settings.hubUrl}/api/status`, {
      headers: { authorization: `Bearer ${settings.token}` },
      signal,
    });
    if (status.status === 401) {
      throw new Error('Token 无效，请确认与服务端 HUB_SECRET_TOKEN 一致');
    }
    if (!status.ok) {
      throw new Error(`/api/status 返回 ${status.status}`);
    }

    return '服务端连通，Token 校验通过';
  } catch (error) {
    if ((error as Error).name === 'TimeoutError') {
      throw new Error(`连接 ${settings.hubUrl} 超时`);
    }
    throw error;
  }
}

function copyCursorRules(dir: string, dryRun: boolean): void {
  const source = fileURLToPath(
    new URL('../templates/.cursorrules', import.meta.url),
  );
  const target = join(dir, '.cursorrules');

  if (!existsSync(source)) return;
  if (existsSync(target)) {
    process.stdout.write('· 已存在 .cursorrules，保留原文件\n');
    return;
  }

  if (dryRun) {
    process.stdout.write(`\n--- ${target} ---\n(复制内置模板)\n`);
    return;
  }

  copyFileSync(source, target);
  process.stdout.write(`✓ 已写入 ${target}\n`);
}

const INSTRUCTION_BEGIN = '<!-- zhunzou:begin -->';
const INSTRUCTION_END = '<!-- zhunzou:end -->';

/**
 * Install the decision-escalation rules in a project instruction file.
 *
 * OpenCode reads `AGENTS.md`, and many projects already have one. Rather than
 * skipping the file (which would silently leave OpenCode without the rules),
 * append a clearly marked, replaceable block. Existing content is preserved.
 */
function upsertInstructionFile(
  dir: string,
  filename: string,
  template: string,
  dryRun: boolean,
): void {
  const source = fileURLToPath(
    new URL(`../templates/${template}`, import.meta.url),
  );
  const target = join(dir, filename);

  if (!existsSync(source)) return;
  const block = readFileSync(source, 'utf8').trim();

  if (!existsSync(target)) {
    if (dryRun) {
      process.stdout.write(`\n--- ${target} ---\n${block}\n`);
      return;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, `${block}\n`, 'utf8');
    process.stdout.write(`✓ 已写入 ${target}\n`);
    return;
  }

  const current = readFileSync(target, 'utf8');
  const begin = current.indexOf(INSTRUCTION_BEGIN);
  const end = current.indexOf(INSTRUCTION_END);

  if (begin !== -1 && end > begin) {
    const next = `${current.slice(0, begin)}${block}${current.slice(end + INSTRUCTION_END.length)}`;
    if (next === current) {
      process.stdout.write(`· ${target} 已是最新准奏规则\n`);
      return;
    }
    if (dryRun) {
      process.stdout.write(`\n--- ${target} ---\n(更新已有准奏规则块)\n${block}\n`);
      return;
    }
    writeFileSync(target, next, 'utf8');
    process.stdout.write(`✓ 已更新 ${target} 中的准奏规则\n`);
    return;
  }

  if (dryRun) {
    process.stdout.write(`\n--- ${target} ---\n(追加)\n${block}\n`);
    return;
  }

  const separator = current.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(target, `${current}${separator}${block}\n`, 'utf8');
  process.stdout.write(`✓ 已追加准奏规则到 ${target}\n`);
}

async function ask(
  rl: ReturnType<typeof createInterface>,
  question: string,
  fallback: string,
): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback;
}

export async function runInit(options: InitOptions = {}): Promise<number> {
  const dir = resolve(options.dir ?? process.cwd());
  const enrollmentCode = options.code?.trim();
  // A code is a complete, non-interactive setup: the installer must not stop
  // and ask questions on a machine whose owner has never heard of Node.
  const interactive = !options.yes && !enrollmentCode;
  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;

  try {
    process.stdout.write('准奏 · 端侧接入向导\n\n');

    const hubUrl =
      options.hubUrl ??
      (rl ? await ask(rl, '云端地址 HUB_URL', DEFAULT_HUB_URL) : DEFAULT_HUB_URL);

    // Global installs have no workspace to inspect, so default to all clients.
    const targetFallback = options.global ? 'all' : detectTarget(dir);
    const target = parseTarget(
      options.target ??
        (rl
          ? await ask(
              rl,
              '写入哪个客户端 cursor / opencode / claude / all',
              targetFallback,
            )
          : targetFallback),
      targetFallback,
    );

    const explicitKind = parseAgentKind(options.agentKind);
    const agentKind = explicitKind ?? kindForTarget(target);

    // `--target all` now means "every client on this machine". Each client
    // needs its own env (and therefore its own token): four editors sharing
    // one env would overwrite each other's heartbeat and collapse into a
    // single card. Pin `--env` / `--agent-kind` to keep the old behaviour.
    const perClient =
      target === 'all' &&
      options.env === undefined &&
      explicitKind === undefined;
    const targets: ClientTarget[] =
      target === 'all' ? [...CLIENT_TARGETS] : [target];

    let adminToken = options.token ?? '';
    let projectName = options.project;

    // Workspace installs default the project to the folder name; global
    // installs leave it empty until the first heartbeat reports a workspace.
    if (!enrollmentCode) {
      if (!adminToken && rl) {
        adminToken = await ask(
          rl,
          'HUB_SECRET_TOKEN（管理员 Token，用于签发该工作区的专属 Token）',
          '',
        );
      }
      if (!adminToken) {
        throw new Error('缺少 HUB_TOKEN；请加 --token 或在交互模式下输入');
      }
      if (projectName === undefined) {
        // Default to the workspace directory name (the folder the editor opened),
        // so the dashboard project dropdown is populated without manual input.
        const defaultProject = basename(dir);
        projectName = rl
          ? await ask(rl, '项目名 ZHUNZOU_PROJECT（回车使用工作区目录名）', defaultProject)
          : defaultProject;
      }
    }

    // A single identity is still what `--env`/`--agent-kind` ask for: one
    // workspace, one env, written into every selected client.
    let singleEnv: string | undefined;
    if (!perClient) {
      const defaultEnv = defaultAgentEnv(
        agentKind,
        projectName || (enrollmentCode ? hostname() : basename(dir)) || hostname(),
      );
      singleEnv =
        options.env ??
        (rl
          ? await ask(
              rl,
              '环境标识 AGENT_ENV（每个工作区应不同）',
              defaultEnv,
            )
          : defaultEnv);
    }

    // Per-client mode derives `cursor-<project>`, `opencode-<project>`, … so
    // the dashboard shows one card per client with the right type.
    const identities: InitIdentity[] = targets.map((item) => {
      const kind = perClient ? kindForTarget(item) : agentKind;
      const env =
        singleEnv ?? defaultAgentEnv(kind, projectName || hostname());
      return { target: item, kind, env, token: adminToken };
    });

    if (rl) {
      const preview = buildSettings({
        hubUrl,
        token: identities[0]!.token,
        agentEnv: identities[0]!.env,
        ...(projectName ? { projectName } : {}),
        agentKind: identities[0]!.kind,
      });
      process.stdout.write(
        [
          '',
          `云端：${preview.hubUrl}`,
          `项目：${preview.projectName ?? '（未设置，按打开的工作区自动识别）'}`,
          ...identities.map(
            (identity) => `环境：${identity.env}（${identity.kind}）`,
          ),
          `目标：${targets.join(' / ')}`,
          `MCP 命令：${preview.mcpCommand.join(' ')}`,
          '',
        ].join('\n'),
      );
      const confirm = await ask(rl, '确认写入以上配置？(y/n)', 'y');
      if (!/^y(es)?$/i.test(confirm)) {
        process.stdout.write('已取消，未写入任何文件。\n');
        return 1;
      }
    }

    if (!options.skipCheck && !enrollmentCode) {
      try {
        const message = await checkHub(
          buildSettings({
            hubUrl,
            token: adminToken,
            agentEnv: identities[0]!.env,
            ...(projectName ? { projectName } : {}),
            agentKind: identities[0]!.kind,
          }),
        );
        process.stdout.write(`✓ ${message}\n`);
      } catch (error) {
        process.stdout.write(
          `! 连通性检查失败：${(error as Error).message}\n`,
        );
        if (!rl) return 1;
        const proceed = await ask(rl, '仍然写入配置？(y/n)', 'n');
        if (!/^y(es)?$/i.test(proceed)) return 1;
      }
    }

    // One code, several clients: every target spends one redemption slot.
    // The server binds the code to this host, so a leaked link still cannot
    // enroll another machine.
    if (enrollmentCode) {
      for (const identity of identities) {
        let exchanged: { token: string; env: string; projectName?: string };
        try {
          exchanged = await exchangeEnrollmentCode({
            hubUrl,
            code: enrollmentCode,
            env: identity.env,
            host: hostname(),
            os: `${platform()}-${arch()}`,
            kind: identity.kind,
            ...(projectName ? { projectName } : {}),
            version: BRIDGE_VERSION,
          });
        } catch (error) {
          const message = (error as Error).message;
          throw new Error(
            identities.length > 1
              ? `${message}\n提示：一台电脑接入多个客户端需要能多次兑换的接入码（新版默认 10 次）。也可以改用 --target cursor|opencode|claude|codex 逐个接入。`
              : message,
          );
        }
        identity.token = exchanged.token;
        identity.env = exchanged.env;
        projectName = exchanged.projectName ?? projectName;
        process.stdout.write(
          `✓ ${identity.kind}: 已签发专属 Agent Token（${identity.env}）\n`,
        );
      }
    }

    // Admin-token path: the admin secret stays in the terminal; every client
    // env gets its own scoped `zz_…` token.
    if (!enrollmentCode && !options.dryRun && !options.noAgentToken) {
      for (const identity of identities) {
        try {
          const issued = await provisionAgentToken(
            buildSettings({
              hubUrl,
              token: adminToken,
              agentEnv: identity.env,
              ...(projectName ? { projectName } : {}),
              agentKind: identity.kind,
            }),
          );
          if (issued) {
            identity.token = issued;
            process.stdout.write(
              `✓ ${identity.kind}: 已签发专属 Agent Token（${identity.env}）\n`,
            );
          } else {
            process.stdout.write(
              `· ${identity.env} 未能签发专属 Token（服务端较旧或无权限），继续使用 HUB_TOKEN\n`,
            );
          }
        } catch (error) {
          process.stdout.write(
            `· ${identity.env} 签发专属 Token 失败：${(error as Error).message}；继续使用 HUB_TOKEN\n`,
          );
        }
      }
    }

    const settingsList = identities.map((identity) =>
      buildSettings({
        hubUrl,
        token: identity.token,
        agentEnv: identity.env,
        ...(projectName ? { projectName } : {}),
        agentKind: identity.kind,
      }),
    );

    for (let index = 0; index < identities.length; index += 1) {
      writeClientConfig(
        identities[index]!.target,
        settingsList[index]!,
        options,
        dir,
      );
    }

    // Keep the machine online when the editor is closed. Service failures are
    // non-fatal: the MCP config above already connects the editor.
    let serviceMessage: string | null = null;
    if (options.service && !options.dryRun) {
      try {
        const cliPath =
          process.argv[1] ??
          join(homedir(), '.zhunzou', 'bridge', 'cli.mjs');
        const primary = settingsList[0]!;
        const installed =
          identities.length > 1
            ? installService({
                mode: 'fleet',
                fleetConfig: writeFleetConfig(
                  identities,
                  primary.hubUrl,
                  dir,
                  projectName,
                ),
                env: primary.agentEnv,
                hubUrl: primary.hubUrl,
                token: primary.token,
                cwd: dir,
                adapter: 'auto',
                cliPath,
                nodePath: process.execPath,
                ...(primary.projectName
                  ? { projectName: primary.projectName }
                  : {}),
              })
            : installService({
                env: primary.agentEnv,
                hubUrl: primary.hubUrl,
                token: primary.token,
                cwd: dir,
                adapter: 'auto',
                cliPath,
                nodePath: process.execPath,
                ...(primary.projectName
                  ? { projectName: primary.projectName }
                  : {}),
              });
        serviceMessage = installed.message;
        process.stdout.write(
          `${installed.started ? '✓' : '·'} ${installed.message}\n`,
        );
      } catch (error) {
        serviceMessage = `常驻服务安装失败：${(error as Error).message}`;
        process.stdout.write(`! ${serviceMessage}\n`);
      }
    }

    process.stdout.write(
      [
        '',
        '完成。下一步：',
        '1. 重启对应客户端，或重新加载 MCP Server。',
        '2. 在新会话里调用 agent_hub_resume，恢复未决奏折与任务。',
        '3. Token 会写入本地配置，请勿把 .cursor/mcp.json / .mcp.json 提交到公开仓库。',
        ...(identities.length > 1
          ? [
              `· 已按客户端分别接入：${identities
                .map((identity) => `${identity.kind} → ${identity.env}`)
                .join('、')}`,
            ]
          : []),
        options.global
          ? '4. 本次写入的是用户级配置，所有项目共用；如需按项目区分环境，可在项目里再运行一次 init。'
          : '4. 每个工作区单独运行一次 init；AGENT_ENV 默认按项目名区分。多个工作区共用同一个 env 时，看板只会显示最后心跳的那个项目。',
        ...(serviceMessage ? [`5. ${serviceMessage}`] : []),
        '',
      ].join('\n'),
    );
    return 0;
  } finally {
    rl?.close();
  }
}
