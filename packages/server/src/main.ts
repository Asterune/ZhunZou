import { resolve } from 'node:path';

import { REPO_ROOT, loadConfig } from './config.js';
import { buildApp } from './app.js';
import { HUB_HELP, parseHubArgs, warningsFor } from './hub-cli.js';
import { SERVER_VERSION } from './version.js';

// Node >= 20.12 ships process.loadEnvFile; a missing .env is not an error.
try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  // no .env file: rely on the real environment
}

let args;
try {
  args = parseHubArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`[zhunzou-server] ${(error as Error).message}\n`);
  process.exit(2);
}
if (args.help) {
  process.stdout.write(HUB_HELP);
  process.exit(0);
}

const config = loadConfig({ ...process.env, ...args.env });
const app = await buildApp({ config });

/** Bounds how long a restart keeps the port closed before answering polls. */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

if (!config.isProduction && config.token === 'dev-token') {
  app.log.warn(
    'HUB_SECRET_TOKEN is not set; using the development token "dev-token"',
  );
}

for (const warning of warningsFor(args)) app.log.warn(warning);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  // Held long polls answer themselves, but a request stuck on an upstream
  // call must not hold the port while systemd waits TimeoutStopSec for us.
  const deadline = setTimeout(() => {
    app.log.warn('shutdown drain timed out; exiting');
    process.exit(0);
  }, SHUTDOWN_DRAIN_TIMEOUT_MS);
  try {
    await app.close();
    clearTimeout(deadline);
    process.exit(0);
  } catch (error) {
    clearTimeout(deadline);
    app.log.error({ err: error }, 'graceful shutdown failed');
    process.exit(1);
  }
};

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => void shutdown(signal));
}

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      version: SERVER_VERSION,
      port: config.port,
      host: config.host,
      db: config.dbPath,
      rules: config.rulesPath,
      metaAgent:
        config.metaAgent.provider === 'none' ? 'off' : config.metaAgent.provider,
      notifications: config.notifications.map((channel) => channel.type),
      plugins: config.plugins.length,
    },
    'zhunzou server ready',
  );
} catch (error) {
  app.log.error({ err: error }, 'failed to start server');
  process.exit(1);
}
