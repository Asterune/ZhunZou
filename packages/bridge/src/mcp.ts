import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadBridgeConfig } from './config.js';
import { HubClient } from './hub-client.js';
import { delegateToActiveRelease } from './launcher.js';
import { createMcpServer } from './mcp-server.js';
import { createPresenceReporter } from './presence.js';

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
  const client = new HubClient(config);
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

  const shutdown = (): void => {
    presence.stop();
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
