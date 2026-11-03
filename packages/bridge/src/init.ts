import { hostname } from 'node:os';
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
}

const DEFAULT_HUB_URL = 'http://127.0.0.1:8787';
const WAIT_TIMEOUT_MS = 40_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function localBin(name: 'mcp' | 'cli'): string | null {
  const path = fileURLToPath(new URL(`../bin/${name}.js`, import.meta.url));
  // npx caches are temporary; prefer the stable npm package name there.
  return existsSync(path) && !path.includes('_npx') ? path : null;
}

export function buildSettings(
  input: {
    hubUrl: string;
    token: string;
    agentEnv: string;
    projectName?: string;
    fallback?: 'cli' | 'mcp';
  },
): InitSettings {
  const mcpBin = localBin('mcp');
  const cliBin = localBin('cli');

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
  const interactive = !options.yes;
  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;

  try {
    process.stdout.write('准奏 · 端侧接入向导\n\n');

    const hubUrl =
      options.hubUrl ??
      (rl ? await ask(rl, '云端地址 HUB_URL', DEFAULT_HUB_URL) : DEFAULT_HUB_URL);

    let token = options.token ?? '';
    if (!token && rl) {
      token = await ask(rl, 'HUB_TOKEN（与服务端一致，会写入本地配置）', '');
    }
    if (!token) {
      throw new Error('缺少 HUB_TOKEN；请加 --token 或在交互模式下输入');
    }

    const defaultEnv = `unknown-${hostname()}`;
    const agentEnv =
      options.env ??
      (rl ? await ask(rl, '环境标识 AGENT_ENV', defaultEnv) : defaultEnv);

    let projectName = options.project;
    if (projectName === undefined) {
      // Default to the workspace directory name (the folder the editor opened),
      // so the dashboard project dropdown is populated without manual input.
      const defaultProject = basename(dir);
      projectName = rl
        ? await ask(rl, '项目名 ZHUNZOU_PROJECT（回车使用工作区目录名）', defaultProject)
        : defaultProject;
    }

    const target = parseTarget(
      options.target ??
        (rl
          ? await ask(rl, '写入哪个客户端 cursor / opencode / claude / all', detectTarget(dir))
          : detectTarget(dir)),
      detectTarget(dir),
    );

    const settings = buildSettings({
      hubUrl,
      token,
      agentEnv,
      ...(projectName ? { projectName } : {}),
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

    if (!options.skipCheck) {
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

    const targets: Exclude<InitTarget, 'all'>[] =
      target === 'all' ? ['cursor', 'opencode', 'claude'] : [target];

    for (const item of targets) {
      if (item === 'cursor') {
        const path = join(dir, '.cursor', 'mcp.json');
        writeJson(
          path,
          mergeCursorConfig(readJson(path), settings),
          Boolean(options.dryRun),
        );
        copyCursorRules(dir, Boolean(options.dryRun));
      } else if (item === 'opencode') {
        const path = join(dir, 'opencode.json');
        writeJson(
          path,
          mergeOpenCodeConfig(readJson(path), settings),
          Boolean(options.dryRun),
        );
        upsertInstructionFile(
          dir,
          'AGENTS.md',
          'AGENTS.md',
          Boolean(options.dryRun),
        );
      } else {
        const path = join(dir, '.mcp.json');
        writeJson(
          path,
          mergeClaudeConfig(readJson(path), settings),
          Boolean(options.dryRun),
        );
      }
    }

    process.stdout.write(
      [
        '',
        '完成。下一步：',
        '1. 重启对应客户端，或重新加载 MCP Server。',
        '2. 在新会话里调用 agent_hub_resume，恢复未决奏折与任务。',
        '3. Token 会写入本地配置，请勿把 .cursor/mcp.json / .mcp.json 提交到公开仓库。',
        '',
      ].join('\n'),
    );
    return 0;
  } finally {
    rl?.close();
  }
}
