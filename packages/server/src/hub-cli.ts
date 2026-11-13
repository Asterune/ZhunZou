import { SERVER_VERSION } from './version.js';

/**
 * Command-line front door for the hub.
 *
 * The server has always read its settings from the environment, and operators
 * asked for the blueprint's one-shot `hub` command. Rather than a second
 * config path, flags are translated into the same env names `loadConfig`
 * already understands, so there stays exactly one place where a default lives.
 */
export interface HubArgs {
  command: string;
  port?: string;
  host?: string;
  token?: string;
  dbPath?: string;
  help: boolean;
  /** Overrides in the names loadConfig reads. */
  env: Record<string, string>;
}

const FLAG_TO_ENV: Record<string, keyof Omit<HubArgs, 'command' | 'help' | 'env'>> =
  {
    '--port': 'port',
    '--host': 'host',
    '--token': 'token',
    '--db': 'dbPath',
  };

export const HUB_HELP = `zhunzou-server ${SERVER_VERSION}

Usage:
  node dist/main.js hub [options]     Start the control plane
  node dist/main.js                   Same thing, no overrides

Options:
  --port <port>       Listen port, 1-65535 (env PORT, default 8787)
  --host <host>       Bind address (env HOST, default 0.0.0.0)
  --token <secret>    Admin token (env HUB_SECRET_TOKEN)
  --db <path>         SQLite file, or :memory: (env DATABASE_PATH)
  --help              Show this help

Examples:
  node dist/main.js hub --port 8765 --token "$(openssl rand -hex 16)"
  pnpm --filter @zhunzou/server start -- hub --port 8765 --db ./data/hub.db

Join a machine to it:
  zhunzou-device join http://127.0.0.1:8765 --token <token> --scan-dir ~/code
`;

function fail(flag: string, message: string): never {
  throw new Error(`${flag} ${message}`);
}

function readPort(raw: string): string {
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || String(port) !== raw.trim() || port < 1 || port > 65_535) {
    fail('--port', `must be a whole port between 1 and 65535, got "${raw}"`);
  }
  return raw.trim();
}

export function parseHubArgs(argv: readonly string[]): HubArgs {
  const args = [...argv];
  const parsed: HubArgs = { command: 'serve', help: false, env: {} };

  if (args[0] && !args[0].startsWith('-')) {
    parsed.command = args.shift()!;
  }

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--help' || flag === '-h') {
      parsed.help = true;
      continue;
    }
    const key = FLAG_TO_ENV[flag];
    if (!key) {
      throw new Error(`unknown option ${flag}\n\n${HUB_HELP}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('-')) {
      fail(flag, 'needs a value');
    }
    const accepted = flag === '--port' ? readPort(value!) : value!;
    index += 1;
    parsed[key] = accepted;
  }

  if (parsed.port) parsed.env.PORT = parsed.port;
  if (parsed.host) parsed.env.HOST = parsed.host;
  if (parsed.token) parsed.env.HUB_SECRET_TOKEN = parsed.token;
  if (parsed.dbPath) parsed.env.DATABASE_PATH = parsed.dbPath;

  return parsed;
}

/**
 * argv is world-readable through `ps`, so a token typed on the command line
 * leaks to every other user on the box — say so once, at startup.
 */
export function warningsFor(args: HubArgs): string[] {
  const warnings: string[] = [];
  if (args.token) {
    warnings.push(
      '--token is visible in the process list; prefer HUB_SECRET_TOKEN in the environment',
    );
  }
  return warnings;
}
