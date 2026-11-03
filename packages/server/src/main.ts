import { resolve } from 'node:path';

import { REPO_ROOT, loadConfig } from './config.js';
import { buildApp } from './app.js';

// Node >= 20.12 ships process.loadEnvFile; a missing .env is not an error.
try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  // no .env file: rely on the real environment
}

const config = loadConfig();
const app = await buildApp({ config });

if (!config.isProduction && config.token === 'dev-token') {
  app.log.warn(
    'HUB_SECRET_TOKEN is not set; using the development token "dev-token"',
  );
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'graceful shutdown failed');
    process.exit(1);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
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
