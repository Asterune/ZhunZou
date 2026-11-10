import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadBridgeConfig } from './config.js';
import { createHubApi } from './hub.js';
import { maybeAutoUpgrade } from './auto-upgrade.js';
import { delegateToActiveRelease } from './launcher.js';
import { createMcpServer } from './mcp-server.js';
import { createPresenceReporter } from './presence.js';
import { adoptProjectFromRoots } from './project-roots.js';

async function main(): Promise<void> {
  // After `upgrade`, current.json points at a newer versions/<v>/mcp.mjs.
  if (await delegateToActiveRelease(import.meta.url)) return;

  // Make the CLI fallback work even when the package is not installed globally.
  // The source build uses cli.js; the standalone bundle uses cli.mjs.
  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = ['cli.js', 'cli.mjs']
    .map((file) => join(here, file))
    .find((file) => existsSync(file)) ?? join(here, 'cli.js');
  process.env.ZHUNZOU_CLI_COMMAND ??= `"${process.execPath}" "${cliPath}"`;

  const config = loadBridgeConfig();

  // Standalone installs keep themselves current; the new version applies on
  // the next launch. Fire-and-forget so the MCP handshake is never delayed.
  void maybeAutoUpgrade({
    hubUrl: config.hubUrl,
    log: (line) => console.error(`[zhunzou] ${line}`),
  });

  const client = createHubApi(config);
  const presence = createPresenceReporter(client, {
    intervalMs: config.heartbeatIntervalMs,
    ...(config.projectName ? { projectName: config.projectName } : {}),
    onError: (error) =>
      console.error(`[zhunzou] heartbeat failed: ${(error as Error).message}`),
  });
  const server = createMcpServer({ client, config, presence });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  presence.start();

  // The editor knows which folder is open; cwd does not always. Ask once the
  // handshake is done, and only let it correct a cwd guess or fill a blank.
  if (!config.projectName || config.projectSource === 'cwd') {
    void adoptProjectFromRoots({
      listRoots: () => server.server.listRoots(undefined, { timeout: 5_000 }),
      presence,
      log: (line) => console.error(`[zhunzou] ${line}`),
    });
  }

  const shutdown = (): void => {
    presence.stop();
    client.close?.();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // stdout is reserved for the MCP protocol. Logs must go to stderr.
  console.error(
    `[zhunzou] MCP server ready (env=${config.agentEnv}, hub=${config.hubUrl}, fallback=${config.fallback})`,
  );
}

main().catch((error: unknown) => {
  console.error(
    `[zhunzou] failed to start MCP server: ${(error as Error).message}`,
  );
  process.exit(1);
});
