import { pathToFileURL } from 'node:url';

import { NODE_HEARTBEAT_REPORT_MS } from '@zhunzou/shared';

import { detectCapabilities, detectStats } from './capabilities.js';
import { loadDeviceConfig } from './config.js';
import { runDeviceDaemon } from './daemon.js';

const DEVICE_VERSION = '0.1.0';

export const HELP = `zhunzou-device ${DEVICE_VERSION}

Usage:
  zhunzou-device join <hub-url> [options] Reverse-connect this machine as a routable node
  zhunzou-device run [options]            Reverse-connect this machine to the hub
  zhunzou-device capabilities [--json]    Print detected OS / load / CLI inventory

Options:
  --hub <url>              Hub URL, e.g. https://hub.example.com (or HUB_URL)
  --token <token>          Scoped agent token (zz_...) or HUB_SECRET_TOKEN
  --env <name>             Environment label shown on the dashboard (AGENT_ENV)
  --project <name>         Project name reported with device metadata
  --role <worker|portal|hybrid>  How the scheduler may use this machine (default worker)
  --tags <a,b>             Free-form labels a dispatch can require
  --scan-dir <path>        Root to search for git checkouts; repeatable
  --max-concurrency <n>    Tasks this node takes at once, 1-16 (default 1)
  --heartbeat <ms>         Heartbeat interval (default ${NODE_HEARTBEAT_REPORT_MS})
  --help                   Show this help
  --version                Print the device version

Examples:
  zhunzou-device join https://hub.example.com --token zz_xxx --env home-mac --scan-dir ~/code
  zhunzou-device run --hub https://hub.example.com --token zz_xxx --env home-mac
  AGENT_ENV=home-mac HUB_URL=https://hub.example.com HUB_TOKEN=zz_xxx zhunzou-device
`;

interface ParsedArgs {
  command: string;
  hub?: string;
  token?: string;
  env?: string;
  project?: string;
  heartbeat?: string;
  role?: string;
  tags?: string;
  maxConcurrency?: string;
  scanDirs: string[];
  json: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const parsed: ParsedArgs = {
    command: 'run',
    scanDirs: [],
    json: false,
    help: false,
    version: false,
  };

  if (args[0] && !args[0].startsWith('-')) {
    parsed.command = args.shift()!;
  }
  // `join <hub-url>`: the URL is the command's subject, not an option value.
  if (parsed.command === 'join' && args[0] && !args[0].startsWith('-')) {
    parsed.hub = args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const next = (): string | undefined => {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith('-')) {
        index += 1;
        return value;
      }
      return undefined;
    };

    switch (arg) {
      case '--hub':
        parsed.hub = next();
        break;
      case '--token':
        parsed.token = next();
        break;
      case '--env':
        parsed.env = next();
        break;
      case '--project':
        parsed.project = next();
        break;
      case '--heartbeat':
        parsed.heartbeat = next();
        break;
      case '--role':
        parsed.role = next();
        break;
      case '--tags':
        parsed.tags = next();
        break;
      case '--max-concurrency':
        parsed.maxConcurrency = next();
        break;
      case '--scan-dir': {
        const dir = next();
        if (dir) parsed.scanDirs.push(dir);
        break;
      }
      case '--json':
        parsed.json = true;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--version':
      case '-v':
        parsed.version = true;
        break;
      default:
        break;
    }
  }

  return parsed;
}

/** Flags win over the environment, and both land in the same config reader. */
export function envFromArgs(parsed: ParsedArgs): Record<string, string> {
  return {
    ...(parsed.hub ? { ZHUNZOU_HUB_URL: parsed.hub } : {}),
    ...(parsed.token ? { ZHUNZOU_DEVICE_TOKEN: parsed.token } : {}),
    ...(parsed.env ? { ZHUNZOU_DEVICE_ENV: parsed.env } : {}),
    ...(parsed.project ? { ZHUNZOU_PROJECT: parsed.project } : {}),
    ...(parsed.heartbeat
      ? { ZHUNZOU_HEARTBEAT_INTERVAL_MS: parsed.heartbeat }
      : {}),
    ...(parsed.role ? { ZHUNZOU_NODE_ROLE: parsed.role } : {}),
    ...(parsed.tags ? { ZHUNZOU_NODE_TAGS: parsed.tags } : {}),
    ...(parsed.maxConcurrency
      ? { ZHUNZOU_MAX_CONCURRENCY: parsed.maxConcurrency }
      : {}),
    ...(parsed.scanDirs.length
      ? { ZHUNZOU_SCAN_DIRS: parsed.scanDirs.join(',') }
      : {}),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`${DEVICE_VERSION}\n`);
    return 0;
  }

  if (parsed.command === 'capabilities' || parsed.command === 'print') {
    const payload = {
      version: DEVICE_VERSION,
      capabilities: detectCapabilities(),
      stats: detectStats(),
    };
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      const { capabilities, stats } = payload;
      process.stdout.write(
        [
          `host      ${capabilities.hostname}`,
          `os        ${capabilities.os}-${capabilities.arch} (${capabilities.release ?? 'unknown'})`,
          `shell     ${capabilities.shell ?? '—'}`,
          `pty       ${capabilities.pty?.available ? capabilities.pty.backend : 'unavailable'}`,
          `cpu/mem   ${stats.cpuCount ?? '?'} cores · ${formatBytes(stats.totalMemBytes)} total`,
          `load      ${stats.load1?.toFixed(2)} / ${stats.load5?.toFixed(2)} / ${stats.load15?.toFixed(2)}`,
          `tools     ${capabilities.tools.map((tool) => tool.name).join(', ') || 'none detected'}`,
        ].join('\n') + '\n',
      );
    }
    return 0;
  }

  if (parsed.command !== 'run' && parsed.command !== 'join') {
    process.stderr.write(`unknown command: ${parsed.command}\n\n${HELP}`);
    return 2;
  }
  if (parsed.command === 'join' && !parsed.hub) {
    process.stderr.write(
      'join needs a hub url: zhunzou-device join https://hub.example.com --token zz_xxx\n',
    );
    return 2;
  }

  let config;
  try {
    config = loadDeviceConfig({ ...process.env, ...envFromArgs(parsed) });
  } catch (error) {
    process.stderr.write(`[zhunzou-device] ${(error as Error).message}\n`);
    return 1;
  }

  const node = config.node;
  process.stdout.write(
    `[zhunzou-device] env=${config.env} hub=${config.hubUrl} heartbeat=${config.heartbeatMs}ms` +
      `${node ? ` role=${node.role} max-concurrency=${node.maxConcurrency} scan-dirs=${node.scanDirs.length ? node.scanDirs.join(',') : '—'}` : ''}\n`,
  );

  return runDeviceDaemon({
    config,
    log: (line) => process.stdout.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
  });
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return '—';
  const gib = bytes / 1024 ** 3;
  return `${gib.toFixed(1)} GiB`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `[zhunzou-device] ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
