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

export type InitTarget = 'cursor' | 'opencode' | 'claude' | 'all';

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

function detectTarget(dir: string): InitTarget {
  if (existsSync(join(dir, '.cursor'))) return 'cursor';
  if (existsSync(join(dir, 'opencode.json'))) return 'opencode';
  if (existsSync(join(dir, '.mcp.json'))) return 'claude';
  return 'cursor';
}

function parseTarget(raw: string | undefined, fallback: InitTarget): InitTarget {
  if (!raw) return fallback;
  const value = raw.toLowerCase();
  if (value === 'cursor' || value === 'opencode' || value === 'claude' || value === 'all') {
    return value;
  }
  throw new Error(`未知 target "${raw}"，可选 cursor / opencode / claude / all`);
}

function kindForTarget(target: InitTarget): AgentKind {
  if (target === 'cursor') return 'cursor';
  if (target === 'opencode') return 'opencode';
  if (target === 'claude') return 'claude-code';
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

/** `cursor-yikuaomed-erp`, so each workspace becomes a separate agent. */
function defaultAgentEnv(target: InitTarget, project: string): string {
  const prefix =
    target === 'cursor'
      ? 'cursor'
      : target === 'opencode'
        ? 'opencode'
        : target === 'claude'
          ? 'claude'
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

/** Global (user-level) config locations, so one install covers all projects. */
function globalTargetDir(target: Exclude<InitTarget, 'all'>): string {
  const configHome =
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  if (target === 'cursor') return join(homedir(), '.cursor');
  if (target === 'opencode') return join(configHome, 'opencode');
  return homedir();
}

function globalConfigFile(target: Exclude<InitTarget, 'all'>): string {
  if (target === 'cursor') return join(globalTargetDir(target), 'mcp.json');
  if (target === 'opencode') {
    return join(globalTargetDir(target), 'opencode.json');
  }
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

    const agentKind =
      parseAgentKind(options.agentKind) ?? kindForTarget(target);

    let token = options.token ?? '';
    let projectName = options.project;

    // Workspace installs default the project to the folder name; global
    // installs leave it empty until the first heartbeat reports a workspace.
    if (!enrollmentCode) {
      if (!token && rl) {
        token = await ask(
          rl,
          'HUB_SECRET_TOKEN（管理员 Token，用于签发该工作区的专属 Token）',
          '',
        );
      }
      if (!token) {
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

    // Cursor spawns one MCP server per opened workspace. If every workspace
    // shares one AGENT_ENV, their heartbeats overwrite each other and the
    // dashboard only ever shows the most recently active project. Deriving the
    // env from the project keeps each workspace visible as its own agent.
    const envPrefix =
      agentKind === 'cursor'
        ? 'cursor'
        : agentKind === 'opencode'
          ? 'opencode'
          : agentKind === 'claude-code'
            ? 'claude'
            : 'agent';
    const defaultEnv = enrollmentCode
      ? `${envPrefix}-${envSlug(projectName || hostname()) || 'device'}`.slice(0, 64)
      : defaultAgentEnv(target, projectName || basename(dir));
    let agentEnv =
      options.env ??
      (rl
        ? await ask(
            rl,
            '环境标识 AGENT_ENV（每个工作区应不同）',
            defaultEnv,
          )
        : defaultEnv);

    // One-click path: swap the code for a scoped token before anything is
    // written. This also proves the hub is reachable, so the separate
    // /api/status check is unnecessary.
    if (enrollmentCode) {
      const exchanged = await exchangeEnrollmentCode({
        hubUrl,
        code: enrollmentCode,
        env: agentEnv,
        host: hostname(),
        os: `${platform()}-${arch()}`,
        kind: agentKind,
        ...(projectName ? { projectName } : {}),
        version: BRIDGE_VERSION,
      });
      token = exchanged.token;
      agentEnv = exchanged.env;
      projectName = exchanged.projectName ?? projectName;
      process.stdout.write('✓ 接入码已兑换，已签发专属 Agent Token\n');
    }

    const settings = buildSettings({
      hubUrl,
      token,
      agentEnv,
      ...(projectName ? { projectName } : {}),
      agentKind,
    });

    if (rl) {
      process.stdout.write(
        [
          '',
          `云端：${settings.hubUrl}`,
          `环境：${settings.agentEnv}`,
          `项目：${settings.projectName ?? '（未设置）'}`,
          `目标：${target}`,
          `MCP 命令：${settings.mcpCommand.join(' ')}`,
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
        const message = await checkHub(settings);
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

    // Provision a scoped token after the admin-token connectivity check.
    // The admin token stays in the terminal; the project config gets `zz_…`.
    // Enrollment already did this, so never rotate the freshly issued token.
    if (!enrollmentCode && !options.dryRun && !options.noAgentToken) {
      try {
        const issued = await provisionAgentToken(settings);
        if (issued) {
          settings.token = issued;
          process.stdout.write('✓ 已签发专属 Agent Token（只显示一次，已写入配置）\n');
        } else {
          process.stdout.write(
            '· 未能签发专属 Token（服务端较旧或无权限），继续使用 HUB_TOKEN\n',
          );
        }
      } catch (error) {
        process.stdout.write(
          `· 签发专属 Token 失败：${(error as Error).message}；继续使用 HUB_TOKEN\n`,
        );
      }
    }

    const targets: Exclude<InitTarget, 'all'>[] =
      target === 'all' ? ['cursor', 'opencode', 'claude'] : [target];

    for (const item of targets) {
      if (item === 'cursor') {
        const path = options.global
          ? globalConfigFile('cursor')
          : join(dir, '.cursor', 'mcp.json');
        writeJson(
          path,
          mergeCursorConfig(readJson(path), settings),
          Boolean(options.dryRun),
        );
        // Cursor user rules live in the app settings, not a file; project
        // installs can still drop .cursorrules next to the workspace.
        if (!options.global) copyCursorRules(dir, Boolean(options.dryRun));
      } else if (item === 'opencode') {
        const path = options.global
          ? globalConfigFile('opencode')
          : join(dir, 'opencode.json');
        writeJson(
          path,
          mergeOpenCodeConfig(readJson(path), settings),
          Boolean(options.dryRun),
        );
        if (options.global) {
          const instruction = globalInstructionFile('opencode')!;
          upsertInstructionFile(
            instruction.dir,
            instruction.file,
            instruction.template,
            Boolean(options.dryRun),
          );
        } else {
          upsertInstructionFile(
            dir,
            'AGENTS.md',
            'AGENTS.md',
            Boolean(options.dryRun),
          );
        }
      } else {
        const path = options.global
          ? globalConfigFile('claude')
          : join(dir, '.mcp.json');
        writeJson(
          path,
          mergeClaudeConfig(readJson(path), settings),
          Boolean(options.dryRun),
        );
        if (options.global) {
          const instruction = globalInstructionFile('claude')!;
          upsertInstructionFile(
            instruction.dir,
            instruction.file,
            instruction.template,
            Boolean(options.dryRun),
          );
        }
      }
    }

    // Keep the machine online when the editor is closed. Service failures are
    // non-fatal: the MCP config above already connects the editor.
    let serviceMessage: string | null = null;
    if (options.service && !options.dryRun) {
      try {
        const installed = installService({
          env: settings.agentEnv,
          hubUrl: settings.hubUrl,
          token: settings.token,
          cwd: dir,
          adapter: 'auto',
          cliPath:
            process.argv[1] ?? join(homedir(), '.zhunzou', 'bridge', 'cli.mjs'),
          nodePath: process.execPath,
          ...(settings.projectName ? { projectName: settings.projectName } : {}),
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
