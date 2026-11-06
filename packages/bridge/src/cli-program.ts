import { existsSync } from 'node:fs';
import { arch, hostname, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { loadBridgeConfig, detectWorkspaceProject } from './config.js';
import {
  addFleetProjects,
  agentKindForAdapter,
  buildLaunchdPlist,
  defaultFleetConfigPath,
  expandHome,
  loadFleetConfig,
  readFleetFile,
  removeFleetProject,
  runFleet,
  type FleetProjectEntry,
} from './fleet.js';
import { createHubApi } from './hub.js';
import { runInit } from './init.js';
import {
  installService,
  readServiceConfig,
  serviceStatus,
  uninstallService,
} from './service.js';
import { runSessionDaemon, supportsChat } from './session.js';
import { BRIDGE_VERSION } from './version.js';
import { defaultInstallRoot, runUpgrade } from './upgrade.js';
import { waitForDecision } from './wait-command.js';
import {
  loadWakeConfig,
  runWakeDaemon,
  WAKE_ADAPTERS,
  type WakeAdapterName,
} from './wake/index.js';
import {
  scanRecentWorkspaces,
  type EditorFlavor,
} from './workspaces.js';

const DEFAULT_HUB_URL = 'http://127.0.0.1:8787';
const DEFAULT_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 55_000;

/** Env prefix that matches `init` (`opencode-…`, `claude-…`, `agent-…`). */
const ADAPTER_ENV_PREFIX: Record<string, string> = {
  opencode: 'opencode',
  'opencode-run': 'opencode',
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  'cursor-agent': 'cursor',
};

function envSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * The parent `fleet` command owns `--config`; commander consumes it before the
 * subcommand sees it, so read both places. `--file` is the subcommand alias.
 */
function fleetConfigPathOf(
  options: { file?: string; config?: string },
  command?: Command,
): string {
  const parentOptions = command?.parent?.opts() as
    | { config?: string }
    | undefined;
  return resolve(
    expandHome(
      options.file ??
        options.config ??
        parentOptions?.config ??
        defaultFleetConfigPath(),
    ),
  );
}

/** Exchange a dashboard enrollment code for a scoped token for one env. */
async function exchangeEnrollment(
  hubUrl: string,
  code: string,
  env: string,
  kind: string,
  project?: string,
): Promise<string> {
  const response = await fetch(`${hubUrl.replace(/\/+$/, '')}/api/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: code.trim(),
      env,
      kind,
      host: hostname(),
      os: `${platform()}-${arch()}`,
      ...(project ? { projectName: project } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => null)) as
    | { token?: unknown; env?: unknown; error?: { message?: unknown } }
    | null;
  if (!response.ok) {
    const message =
      typeof body?.error?.message === 'string'
        ? body.error.message
        : `接入码兑换失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  if (typeof body?.token !== 'string' || !body.token) {
    throw new Error('服务端未返回 Token');
  }
  return body.token;
}

/** Mint a scoped `zz_…` token; null when the hub rejects the admin token. */
async function mintAgentToken(
  hubUrl: string,
  env: string,
  adminToken: string,
): Promise<string | null> {
  const response = await fetch(
    `${hubUrl.replace(/\/+$/, '')}/api/agents/${encodeURIComponent(env)}/token`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as
    | { token?: unknown }
    | null;
  return typeof body?.token === 'string' && body.token ? body.token : null;
}

/** Options shared by `fleet add` and `fleet scan --add`. */
interface AddProjectsOptions {
  env?: string;
  project?: string;
  adapter?: string;
  token?: string;
  code?: string;
  adminToken?: string;
  hubUrl?: string;
  file?: string;
  restart?: boolean;
}

/**
 * Shared implementation for `fleet add` and `fleet scan --add`. Returns the
 * process exit code; prints human-readable progress to stdout.
 */
async function addProjectsFromPaths(
  paths: string[],
  options: AddProjectsOptions,
  command?: Command,
): Promise<number> {
  if (options.env && paths.length > 1) {
    process.stderr.write('[zhunzou] --env 只能和单个目录一起用\n');
    return 1;
  }
  if (
    options.adapter &&
    !(WAKE_ADAPTERS as readonly string[]).includes(options.adapter)
  ) {
    process.stderr.write(
      `[zhunzou] 未知 adapter ${options.adapter}；可选 ${WAKE_ADAPTERS.join(', ')}\n`,
    );
    return 1;
  }

  const configPath = fleetConfigPathOf(options, command);
  let file;
  try {
    file = readFleetFile(configPath);
  } catch (error) {
    process.stderr.write(`[zhunzou] ${(error as Error).message}\n`);
    return 1;
  }

  const hubUrl = (
    options.hubUrl ??
    file.hubUrl ??
    process.env.HUB_URL ??
    DEFAULT_HUB_URL
  ).replace(/\/+$/, '');
  const adminToken =
    options.adminToken ?? file.adminToken ?? process.env.HUB_SECRET_TOKEN ?? '';

  const entries: FleetProjectEntry[] = [];
  for (const raw of paths) {
    const absolute = resolve(expandHome(raw));
    if (!existsSync(absolute)) {
      process.stderr.write(`[zhunzou] 目录不存在：${absolute}\n`);
      return 1;
    }
    const project =
      options.project ?? detectWorkspaceProject(absolute) ?? basename(absolute);
    const adapter = options.adapter ?? 'auto';
    const env =
      options.env ??
      `${ADAPTER_ENV_PREFIX[adapter] ?? 'agent'}-${envSlug(project) || 'project'}`;

    let token =
      options.token ?? file.projects.find((item) => item.env === env)?.token;
    if (!token && options.code) {
      try {
        token = await exchangeEnrollment(
          hubUrl,
          options.code,
          env,
          agentKindForAdapter(adapter as WakeAdapterName),
          project,
        );
      } catch (error) {
        process.stderr.write(
          `[zhunzou] ${env} 兑换接入码失败：${(error as Error).message}\n`,
        );
        return 1;
      }
    }
    if (!token && adminToken) {
      token =
        (await mintAgentToken(hubUrl, env, adminToken).catch(() => null)) ??
        undefined;
    }

    entries.push({
      env,
      path: absolute,
      project,
      adapter,
      ...(token ? { token } : {}),
    });
  }

  const result = addFleetProjects({ projects: entries, hubUrl, configPath });
  for (const project of result.added) {
    process.stdout.write(
      `✓ 已添加 ${project.env} → ${project.path}（项目 ${project.project}，adapter ${project.adapter}）\n`,
    );
  }
  for (const project of result.updated) {
    process.stdout.write(
      `✓ 已更新 ${project.env} → ${project.path}（项目 ${project.project}，adapter ${project.adapter}）\n`,
    );
  }
  const missing = entries.filter((entry) => !entry.token);
  if (missing.length > 0) {
    process.stdout.write(
      `· ${missing.map((entry) => entry.env).join('、')} 还没有专属 Token：` +
        '加 --code（看板接入码）或 --admin-token，或签发后用 --token 重跑\n',
    );
  }
  process.stdout.write(`· 配置：${result.configPath}\n`);

  if (options.restart !== false) {
    const stored = readServiceConfig();
    if (!stored) {
      process.stdout.write(
        '· 常驻服务未安装；先运行 init --service，或直接 zhunzou-bridge fleet\n',
      );
    } else {
      const primary = result.file.projects[0];
      const restarted = installService({
        ...stored,
        mode: 'fleet',
        fleetConfig: result.configPath,
        hubUrl,
        ...(primary ? { env: primary.env } : {}),
        ...(primary?.token ? { token: primary.token } : {}),
      });
      process.stdout.write(`✓ ${restarted.message}\n`);
    }
  }

  return 0;
}

function clampInterval(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, parsed));
}

function resolveHubUrl(flag: string | undefined): string {
  const raw = (flag ?? process.env.HUB_URL ?? DEFAULT_HUB_URL)
    .trim()
    .replace(/\/+$/, '');  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`HUB_URL 不是合法 URL：${raw}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`HUB_URL 必须使用 http 或 https：${raw}`);
  }
  return raw;
}

/** Path of the CLI entry, for launchd ProgramArguments. */
function currentCliPath(): string {
  // Prefer the entry the user actually launched: the one-click installer runs
  // a stable root bootstrap, which keeps service definitions working after an
  // upgrade flips `current.json`.
  const launched = process.argv[1];
  if (
    launched &&
    /(^|[\\/])cli\.(mjs|js)$/.test(launched) &&
    existsSync(launched)
  ) {
    return launched;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of ['cli.js', 'cli.mjs']) {
    const candidate = join(here, name);
    if (existsSync(candidate)) return candidate;
  }
  return launched ?? join(here, 'cli.js');
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('zhunzou-bridge')
    .description('Bridge Cursor/OpenCode to the Zhunzou decision service')
    .version(BRIDGE_VERSION);

  program
    .command('init')
    .description(
      'Interactive setup: write Cursor / OpenCode / Claude Code MCP config and verify connectivity',
    )
    .option('--hub-url <url>', 'Zhunzou server URL')
    .option('--token <token>', 'same value as the server HUB_SECRET_TOKEN')
    .option('--code <code>', 'one-time enrollment code from the dashboard (no admin token needed)')
    .option('--global', 'write user-level editor config instead of the workspace')
    .option('--service', 'register a login-time daemon so the device stays online')
    .option('--env <name>', 'environment label shown on the dashboard')
    .option('--project <name>', 'project name reported in heartbeats')
    .option('--target <target>', 'cursor | opencode | claude | codex | all (all = one env per client)')
    .option('--agent-kind <kind>', 'cursor | opencode | claude-code | codex | gemini | other')
    .option('--no-agent-token', 'keep using the admin token instead of issuing a scoped one')
    .option('--dir <path>', 'workspace directory (defaults to cwd)')
    .option('--yes', 'non-interactive; use flags and defaults')
    .option('--skip-check', 'skip the server connectivity check')
    .option('--dry-run', 'print config instead of writing files')
    .action(async (options: Record<string, string | boolean | undefined>) => {
      process.exitCode = await runInit({
        ...(typeof options.hubUrl === 'string'
          ? { hubUrl: options.hubUrl }
          : {}),
        ...(typeof options.token === 'string'
          ? { token: options.token }
          : {}),
        ...(typeof options.code === 'string' ? { code: options.code } : {}),
        ...(options.global === true ? { global: true } : {}),
        ...(options.service === true ? { service: true } : {}),
        ...(typeof options.env === 'string' ? { env: options.env } : {}),
        ...(typeof options.project === 'string'
          ? { project: options.project }
          : {}),
        ...(typeof options.target === 'string'
          ? { target: options.target }
          : {}),
        ...(typeof options.agentKind === 'string'
          ? { agentKind: options.agentKind }
          : {}),
        ...(options.agentToken === false ? { noAgentToken: true } : {}),
        ...(typeof options.dir === 'string' ? { dir: options.dir } : {}),
        ...(options.yes === true ? { yes: true } : {}),
        ...(options.skipCheck === true ? { skipCheck: true } : {}),
        ...(options.dryRun === true ? { dryRun: true } : {}),
      });
    });

  program
    .command('wait')
    .description(
      'Block until a ticket is approved, printing the decision to stdout (safe to run in a Cursor terminal)',
    )
    .requiredOption('--ticket <id>', 'ticket id, e.g. 104 or #104')
    .option(
      '--interval <ms>',
      'long-poll window per attempt in milliseconds',
      String(DEFAULT_INTERVAL_MS),
    )
    .action(async (options: { ticket: string; interval: string }) => {
      const config = loadBridgeConfig();
      const client = createHubApi(config);

      process.exitCode = await waitForDecision({
        client,
        ticketId: options.ticket,
        intervalMs: clampInterval(options.interval),
      });
      client.close?.();
    });

  program
    .command('upgrade')
    .description(
      'Download the newest standalone bridge from the hub and switch this install to it (applies on next launch)',
    )
    .option('--check', 'only report whether a newer version exists')
    .option('--force', 'reinstall the published version even if it is not newer')
    .option('--rollback', 'switch back to the newest previously installed version')
    .option('--dir <path>', 'install directory (defaults to the folder holding cli.mjs)')
    .option('--hub-url <url>', 'Zhunzou server URL (defaults to HUB_URL)')
    .action(
      async (options: {
        check?: boolean;
        force?: boolean;
        rollback?: boolean;
        dir?: string;
        hubUrl?: string;
      }) => {
        const hubUrl = resolveHubUrl(options.hubUrl);
        const installRoot = options.dir ?? defaultInstallRoot();
        const token = (process.env.HUB_TOKEN ?? process.env.HUB_SECRET_TOKEN ?? '').trim();

        try {
          const result = await runUpgrade({
            hubUrl,
            installRoot,
            ...(token ? { token } : {}),
            ...(options.check === true ? { checkOnly: true } : {}),
            ...(options.force === true ? { force: true } : {}),
            ...(options.rollback === true ? { rollback: true } : {}),
            log: (line) => process.stdout.write(`[zhunzou] ${line}\n`),
          });

          switch (result.status) {
            case 'up-to-date':
              process.stdout.write(
                `[zhunzou] 已是最新版本 ${result.from}（安装目录 ${installRoot}）\n`,
              );
              break;
            case 'available':
              process.stdout.write(
                `[zhunzou] 发现新版本 ${result.to}（当前 ${result.from}），执行 node cli.mjs upgrade 安装\n`,
              );
              break;
            case 'updated':
              process.stdout.write(
                `[zhunzou] 已更新 ${result.from} → ${result.to}；完全退出并重启 Cursor 后生效\n`,
              );
              break;
            case 'rolled-back':
              process.stdout.write(
                `[zhunzou] 已回滚 ${result.from} → ${result.to}；完全退出并重启 Cursor 后生效\n`,
              );
              break;
          }
        } catch (error) {
          process.stderr.write(`[zhunzou] 升级失败：${(error as Error).message}\n`);
          process.exitCode = 1;
        }
      },
    );

  program
    .command('service')
    .description(
      'Manage the login-time daemon: install | uninstall | status | restart',
    )
    .argument('[action]', 'install | uninstall | status | restart', 'status')
    .action((action: string) => {
      if (action === 'status') {
        process.stdout.write(`[zhunzou] ${serviceStatus()}\n`);
        return;
      }
      if (action === 'uninstall') {
        const result = uninstallService();
        process.stdout.write(`[zhunzou] ${result.message}\n`);
        return;
      }
      if (action === 'restart') {
        const stored = readServiceConfig();
        if (!stored) {
          process.stderr.write(
            '[zhunzou] 未安装常驻服务；先运行 init --service 或 fleet add <path>\n',
          );
          process.exitCode = 1;
          return;
        }
        const restarted = installService(stored);
        process.stdout.write(`[zhunzou] ${restarted.message}\n`);
        return;
      }
      if (action !== 'install') {
        process.stderr.write(
          `[zhunzou] 未知操作 ${action}；可选 install / uninstall / status / restart\n`,
        );
        process.exitCode = 1;
        return;
      }

      const config = loadBridgeConfig();
      const result = installService({
        env: config.agentEnv,
        hubUrl: config.hubUrl,
        token: config.token,
        cwd: process.cwd(),
        adapter: 'auto',
        cliPath: currentCliPath(),
        nodePath: process.execPath,
        ...(config.projectName ? { projectName: config.projectName } : {}),
      });
      process.stdout.write(`[zhunzou] ${result.message}\n`);
    });

  program
    .command('wake')
    .description(
      'Long-poll dispatched tasks and wake a local AI agent (OpenCode / Claude Code / Codex / any CLI)',
    )
    .option(
      '--adapter <name>',
      `local client to wake: ${WAKE_ADAPTERS.join(' | ')}`,
    )
    .option('--command <template>', 'shell template for the command adapter, e.g. "claude -p {prompt}"')
    .option('--cwd <path>', 'working directory for run adapters (defaults to cwd)')
    .option('--args <args>', 'extra arguments appended to a preset CLI adapter')
    .option('--poll <ms>', 'long-poll window per task claim')
    .option('--run-timeout <ms>', 'how long a run adapter may execute')
    .option('--once', 'handle at most one poll cycle and exit')
    .action(
      async (options: {
        adapter?: string;
        command?: string;
        cwd?: string;
        args?: string;
        poll?: string;
        runTimeout?: string;
        once?: boolean;
      }) => {
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (options.adapter) env.ZHUNZOU_WAKE_ADAPTER = options.adapter;
        if (options.command) env.ZHUNZOU_WAKE_COMMAND = options.command;
        if (options.cwd) env.ZHUNZOU_WAKE_CWD = options.cwd;
        if (options.args) env.ZHUNZOU_WAKE_ARGS = options.args;
        if (options.poll) env.ZHUNZOU_WAKE_POLL_TIMEOUT_MS = options.poll;
        if (options.runTimeout) env.ZHUNZOU_WAKE_RUN_TIMEOUT_MS = options.runTimeout;

        if (
          options.adapter &&
          !(WAKE_ADAPTERS as readonly string[]).includes(options.adapter)
        ) {
          process.stderr.write(
            `[zhunzou] unknown adapter: ${options.adapter}\n` +
              `[zhunzou] available: ${WAKE_ADAPTERS.join(', ')}\n`,
          );
          process.exitCode = 1;
          return;
        }

        const hub = loadBridgeConfig(env, options.cwd ?? process.cwd());
        const wake = loadWakeConfig(env, options.cwd ?? process.cwd());
        if (options.adapter) {
          wake.adapter = options.adapter as WakeAdapterName;
        }

        const client = createHubApi(hub);
        const loops: Array<Promise<number>> = [
          runWakeDaemon({
            client,
            hub,
            wake,
            ...(options.once === true ? { once: true } : {}),
          }),
        ];

        // Chat sessions are only serviced by a session loop. `fleet` starts one
        // per project; a standalone `wake` daemon must do the same, otherwise
        // dashboard conversations sit in "waiting for the client" forever.
        if (supportsChat(wake)) {
          loops.push(
            runSessionDaemon({
              client,
              hub,
              wake,
              ...(options.once === true ? { once: true } : {}),
              stdout: (line) => process.stdout.write(`${line}\n`),
              stderr: (line) => process.stderr.write(`${line}\n`),
            }),
          );
        }

        const codes = await Promise.all(loops);
        client.close?.();
        process.exitCode = codes.find((code) => code !== 0) ?? 0;
      },
    );

  const fleetCommand = program
    .command('fleet')
    .description(
      'Run one wake daemon per project on this machine (hub dispatches, no editor needed)',
    )
    .option(
      '--config <path>',
      `fleet config file (default ${defaultFleetConfigPath()})`,
    )
    .option('--once', 'handle at most one poll cycle per project')
    .option('--refresh-tokens', 'rotate and cache a new token for every project')
    .option('--print-launchd', 'print a launchd plist for auto-start and exit')
    .action(
      async (options: {
        config?: string;
        once?: boolean;
        refreshTokens?: boolean;
        printLaunchd?: boolean;
      }) => {
        const configPath = resolve(
          expandHome(options.config ?? defaultFleetConfigPath()),
        );

        if (options.printLaunchd) {
          process.stdout.write(
            buildLaunchdPlist({
              nodePath: process.execPath,
              cliPath: currentCliPath(),
              configPath,
            }),
          );
          return;
        }

        let config;
        try {
          config = loadFleetConfig(configPath);
        } catch (error) {
          process.stderr.write(`[zhunzou] ${(error as Error).message}\n`);
          process.exitCode = 1;
          return;
        }

        const controller = new AbortController();
        const stop = (): void => controller.abort();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);

        try {
          process.exitCode = await runFleet(config, {
            ...(options.once === true ? { once: true } : {}),
            ...(options.refreshTokens === true
              ? { refreshTokens: true }
              : {}),
            signal: controller.signal,
          });
        } catch (error) {
          process.stderr.write(`[zhunzou] fleet failed: ${(error as Error).message}\n`);
          process.exitCode = 1;
        }
      },
    );

  fleetCommand
    .command('add')
    .description(
      'Add one or more project directories to fleet.json (registers the project without opening an editor)',
    )
    .argument('<path...>', 'project directory')
    .option('--env <name>', 'agent env (only with a single path; derived from the project otherwise)')
    .option('--project <name>', 'project name reported to the hub')
    .option(
      '--adapter <name>',
      `local client that handles dispatched tasks: ${WAKE_ADAPTERS.join(' | ')}`,
    )
    .option('--token <token>', 'scoped agent token (otherwise minted with an admin token)')
    .option('--code <code>', 'dashboard enrollment code; mints one scoped token per project')
    .option('--admin-token <token>', 'admin token used to mint a scoped token')
    .option('--hub-url <url>', 'hub URL (defaults to fleet.json or HUB_URL)')
    .option('--file <path>', 'fleet config file (same as fleet --config)')
    .option('--no-restart', 'do not restart the login daemon')
    .action(
      async (paths: string[], options: AddProjectsOptions, command: Command) => {
        process.exitCode = await addProjectsFromPaths(paths, options, command);
      },
    );

  fleetCommand
    .command('scan')
    .description(
      'Find recently opened Cursor / VS Code workspaces; `--add` registers them in fleet.json',
    )
    .option('--add', 'add every discovered workspace')
    .option('--client <name>', 'cursor | code | all', 'cursor')
    .option('--adapter <name>', `local client for dispatched tasks`)
    .option('--code <code>', 'dashboard enrollment code; mints one scoped token per project')
    .option('--admin-token <token>', 'admin token used to mint a scoped token')
    .option('--token <token>', 'use this scoped token for every discovered project')
    .option('--hub-url <url>', 'hub URL (defaults to fleet.json or HUB_URL)')
    .option('--file <path>', 'fleet config file (same as fleet --config)')
    .option('--no-restart', 'do not restart the login daemon')
    .action(
      async (
        options: AddProjectsOptions & { add?: boolean; client?: string },
        command: Command,
      ) => {
        const client = (options.client ?? 'cursor').toLowerCase();
        if (!['cursor', 'code', 'all'].includes(client)) {
          process.stderr.write('[zhunzou] --client 可选 cursor / code / all\n');
          process.exitCode = 1;
          return;
        }
        const flavors: EditorFlavor[] =
          client === 'all' ? ['cursor', 'code'] : [client as EditorFlavor];
        const results = scanRecentWorkspaces({ flavors });

        if (results.length === 0) {
          process.stdout.write(
            '没有找到最近工作区：先在 Cursor 里打开过一个项目，或用 fleet add <路径> 直接指定\n',
          );
          return;
        }

        const paths: string[] = [];
        for (const result of results) {
          process.stdout.write(`${result.source}（${result.storage}）\n`);
          for (const path of result.paths) {
            paths.push(path);
            process.stdout.write(`  · ${path}\n`);
          }
        }
        const unique = [...new Set(paths)];
        process.stdout.write(`共 ${unique.length} 个目录\n`);

        if (!options.add) {
          process.stdout.write('加 --add 即可登记到 fleet.json\n');
          return;
        }
        process.exitCode = await addProjectsFromPaths(unique, options, command);
      },
    );

  fleetCommand
    .command('list')
    .description('List the projects in fleet.json')
    .option('--file <path>', 'fleet config file (same as fleet --config)')
    .action((options: { file?: string }, command: Command) => {
      const configPath = fleetConfigPathOf(options, command);
      let file;
      try {
        file = readFleetFile(configPath);
      } catch (error) {
        process.stderr.write(`[zhunzou] ${(error as Error).message}\n`);
        process.exitCode = 1;
        return;
      }
      if (file.projects.length === 0) {
        process.stdout.write(
          `fleet.json 里还没有项目（${configPath}）；用 zhunzou-bridge fleet add <path> 添加\n`,
        );
        return;
      }
      process.stdout.write(`hub: ${file.hubUrl ?? '(未设置)'}\n`);
      for (const project of file.projects) {
        const token = project.token ? `${project.token.slice(0, 10)}…` : '（未签发）';
        process.stdout.write(
          `${project.env}\t${project.path}\t${project.project ?? '-'}\t${project.adapter ?? file.adapter ?? 'auto'}\t${token}\n`,
        );
      }
    });

  fleetCommand
    .command('remove')
    .description('Remove a project from fleet.json by env')
    .argument('<env>', 'agent env to remove')
    .option('--file <path>', 'fleet config file (same as fleet --config)')
    .option('--no-restart', 'do not restart the login daemon')
    .action(
      (env: string, options: { file?: string; restart?: boolean }, command: Command) => {
        const configPath = fleetConfigPathOf(options, command);
        const removed = removeFleetProject(env, configPath);
        if (!removed) {
          process.stderr.write(`[zhunzou] fleet.json 里没有 ${env}\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`✓ 已从 ${configPath} 移除 ${env}\n`);

        if (options.restart === false) return;
        const stored = readServiceConfig();
        if (!stored) return;
        const remaining = readFleetFile(configPath).projects;
        if (remaining.length === 0) {
          process.stdout.write(
            '· 已无项目，常驻服务未重启；可运行 zhunzou-bridge service uninstall 停掉它\n',
          );
          return;
        }
        const restarted = installService({
          ...stored,
          mode: 'fleet',
          fleetConfig: configPath,
        });
        process.stdout.write(`✓ ${restarted.message}\n`);
      },
    );

  return program;
}
