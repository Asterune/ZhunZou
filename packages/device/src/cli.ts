import { pathToFileURL } from 'node:url';

import { detectCapabilities, detectStats } from './capabilities.js';
import { loadDeviceConfig } from './config.js';
import { runDeviceDaemon } from './daemon.js';

const DEVICE_VERSION = '0.1.0';

const HELP = `zhunzou-device ${DEVICE_VERSION}

Usage:
  zhunzou-device run [options]          Reverse-connect this machine to the hub
  zhunzou-device capabilities [--json]  Print detected OS / load / CLI inventory

Options:
  --hub <url>        Hub URL, e.g. https://hub.example.com (or HUB_URL)
  --token <token>    Scoped agent token (zz_...) or HUB_SECRET_TOKEN
  --env <name>       Environment label shown on the dashboard (AGENT_ENV)
  --project <name>   Project name reported with device metadata
  --heartbeat <ms>   Heartbeat interval (default 30000)
  --help             Show this help
  --version          Print the device version

Examples:
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
  json: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const parsed: ParsedArgs = {
    command: 'run',
    json: false,
    help: false,
    version: false,
  };

  if (args[0] && !args[0].startsWith('-')) {
    parsed.command = args.shift()!;
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

  if (parsed.command !== 'run') {
    process.stderr.write(`unknown command: ${parsed.command}\n\n${HELP}`);
    return 2;
  }

  let config;
  try {
    config = loadDeviceConfig({
      ...process.env,
      ...(parsed.hub ? { ZHUNZOU_HUB_URL: parsed.hub } : {}),
      ...(parsed.token ? { ZHUNZOU_DEVICE_TOKEN: parsed.token } : {}),
      ...(parsed.env ? { ZHUNZOU_DEVICE_ENV: parsed.env } : {}),
      ...(parsed.project ? { ZHUNZOU_PROJECT: parsed.project } : {}),
      ...(parsed.heartbeat
        ? { ZHUNZOU_HEARTBEAT_INTERVAL_MS: parsed.heartbeat }
        : {}),
    });
  } catch (error) {
    process.stderr.write(`[zhunzou-device] ${(error as Error).message}\n`);
    return 1;
  }

  process.stdout.write(
    `[zhunzou-device] env=${config.env} hub=${config.hubUrl} heartbeat=${config.heartbeatMs}ms\n`,
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
