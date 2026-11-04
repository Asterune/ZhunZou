import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { loadBridgeConfig } from './config.js';
import {
  buildLaunchdPlist,
  defaultFleetConfigPath,
  expandHome,
  loadFleetConfig,
  runFleet,
} from './fleet.js';
import { HubClient } from './hub-client.js';
import { runInit } from './init.js';
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

const DEFAULT_HUB_URL = 'http://127.0.0.1:8787';
const DEFAULT_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 55_000;

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
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of ['cli.js', 'cli.mjs']) {
    const candidate = join(here, name);
    if (existsSync(candidate)) return candidate;
  }
  return process.argv[1] ?? join(here, 'cli.js');
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
    .option('--env <name>', 'environment label shown on the dashboard')
    .option('--project <name>', 'project name reported in heartbeats')
    .option('--target <target>', 'cursor | opencode | claude | all')
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
      const client = new HubClient(config);

      process.exitCode = await waitForDecision({
        client,
        ticketId: options.ticket,
        intervalMs: clampInterval(options.interval),
      });
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

        const client = new HubClient(hub);
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
        process.exitCode = codes.find((code) => code !== 0) ?? 0;
      },
    );

  program
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

  return program;
}
