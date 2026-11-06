import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildMcpEnv,
  buildSettings,
  mergeClaudeConfig,
  mergeCursorConfig,
  mergeOpenCodeConfig,
  runInit,
} from '../src/init.js';

const settings = buildSettings({
  hubUrl: 'https://hub.example.com/',
  token: 'secret-token',
  agentEnv: 'company-cursor',
  projectName: 'yikuaomed-erp',
});

describe('buildSettings', () => {
  it('normalizes the hub URL and includes project settings', () => {
    expect(settings.hubUrl).toBe('https://hub.example.com');
    expect(settings.mcpCommand[0]).toBeDefined();
    expect(buildMcpEnv(settings)).toMatchObject({
      HUB_URL: 'https://hub.example.com',
      HUB_TOKEN: 'secret-token',
      AGENT_ENV: 'company-cursor',
      ZHUNZOU_PROJECT: 'yikuaomed-erp',
      ZHUNZOU_WAIT_TIMEOUT_MS: '40000',
    });
  });

  it('omits ZHUNZOU_PROJECT when no project is given', () => {
    const env = buildMcpEnv(
      buildSettings({
        hubUrl: 'http://127.0.0.1:8787',
        token: 't',
        agentEnv: 'home-opencode',
      }),
    );
    expect(env.ZHUNZOU_PROJECT).toBeUndefined();
  });

  it('quotes the local CLI binary so paths with spaces still work', () => {
    // The source tree resolves bin/cli.js locally, so this exercises the
    // non-npx branch used by `node packages/bridge/bin/cli.js init`.
    if (settings.cliCommand.startsWith('npx ')) return;
    expect(settings.cliCommand).toMatch(/^".+" ".+"$/);
  });
});

describe('config merging', () => {
  it('preserves other Cursor MCP servers and replaces zhunzou', () => {
    const merged = mergeCursorConfig(
      {
        mcpServers: {
          other: { command: 'node', args: ['other.js'] },
          zhunzou: { command: 'old' },
        },
      },
      settings,
    );

    const servers = merged.mcpServers as Record<string, unknown>;
    expect(servers.other).toBeDefined();
    expect((servers.zhunzou as Record<string, unknown>).command).toBe(
      settings.mcpCommand[0],
    );
    expect(
      (servers.zhunzou as Record<string, unknown>).env,
    ).toMatchObject({ HUB_URL: 'https://hub.example.com' });
  });

  it('creates a Cursor config when none exists', () => {
    const merged = mergeCursorConfig(undefined, settings);
    expect(merged).toMatchObject({
      mcpServers: { zhunzou: { env: { HUB_TOKEN: 'secret-token' } } },
    });
  });

  it('writes OpenCode MCP servers under mcp.servers and preserves settings', () => {
    const merged = mergeOpenCodeConfig(
      {
        theme: 'dark',
        mcp: {
          timeout: 5000,
          legacy: { type: 'local', command: ['node', 'legacy.js'] },
          servers: { other: { type: 'local', command: ['node', 'other.js'] } },
        },
      },
      settings,
    );

    expect(merged.theme).toBe('dark');
    expect(merged.$schema).toBe('https://opencode.ai/config.json');
    const mcp = merged.mcp as Record<string, unknown>;
    expect(mcp.timeout).toBe(5000);
    expect(mcp.legacy).toBeDefined();
    const servers = mcp.servers as Record<string, unknown>;
    expect(servers.other).toBeDefined();
    expect(servers.zhunzou).toMatchObject({
      type: 'local',
      enabled: true,
      command: settings.mcpCommand,
      environment: { HUB_URL: 'https://hub.example.com' },
    });
  });

  it('migrates a legacy top-level zhunzou server into mcp.servers', () => {
    const merged = mergeOpenCodeConfig(
      { mcp: { zhunzou: { type: 'local', command: ['node', 'old.js'] } } },
      settings,
    );

    const mcp = merged.mcp as Record<string, unknown>;
    expect(mcp.zhunzou).toBeUndefined();
    expect(
      (mcp.servers as Record<string, Record<string, unknown>>).zhunzou.command,
    ).toEqual(settings.mcpCommand);
  });

  it('uses the same stdio shape for Claude Code', () => {
    const merged = mergeClaudeConfig(undefined, settings);
    const server = (merged.mcpServers as Record<string, unknown>)
      .zhunzou as Record<string, unknown>;
    expect(server).toMatchObject({
      command: settings.mcpCommand[0],
      args: settings.mcpCommand.slice(1),
    });
  });
});

describe('one-time enrollment', () => {
  const dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'zhunzou-enroll-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exchanges the code for a scoped token instead of asking for the admin token', async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        received.push(JSON.parse(raw) as Record<string, unknown>);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            hubUrl: 'http://127.0.0.1',
            token: 'zz_scoped_token',
            env: 'agent-test-host',
            agent: { env: 'agent-test-host' },
          }),
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const hubUrl = `http://127.0.0.1:${address.port}`;

    try {
      const dir = tempDir();
      const code = await runInit({
        dir,
        hubUrl,
        code: 'ABCDE-FGHIJ',
        target: 'opencode',
        yes: true,
      });
      expect(code).toBe(0);

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        code: 'ABCDE-FGHIJ',
        kind: 'opencode',
      });
      expect(received[0]).not.toHaveProperty('token');

      const config = JSON.parse(
        readFileSync(join(dir, 'opencode.json'), 'utf8'),
      ) as Record<string, unknown>;
      const servers = (config.mcp as Record<string, unknown>)
        .servers as Record<string, Record<string, unknown>>;
      expect(servers.zhunzou.environment).toMatchObject({
        HUB_URL: hubUrl,
        HUB_TOKEN: 'zz_scoped_token',
        AGENT_ENV: 'agent-test-host',
      });
    } finally {
      server.close();
    }
  });
});

describe('OpenCode instructions', () => {
  const dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'zhunzou-init-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function init(dir: string): Promise<void> {
    const code = await runInit({
      dir,
      hubUrl: 'https://hub.example.com',
      token: 'secret-token',
      env: 'home-opencode',
      target: 'opencode',
      yes: true,
      skipCheck: true,
      noAgentToken: true,
    });
    expect(code).toBe(0);
  }

  it('writes AGENTS.md next to the OpenCode config', async () => {
    const dir = tempDir();
    await init(dir);

    const config = JSON.parse(
      readFileSync(join(dir, 'opencode.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(
      (config.mcp as Record<string, unknown>).servers,
    ).toBeDefined();

    const instructions = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(instructions).toContain('agent_hub_escalate');
    expect(instructions).toContain('不要在对话里抛出开放式问题后就结束回合');
  });

  it('appends the rules to an existing AGENTS.md without losing content', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'AGENTS.md'), '# 现有项目约定\n\n- 使用 pnpm\n', 'utf8');

    await init(dir);

    const instructions = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(instructions).toContain('# 现有项目约定');
    expect(instructions).toContain('使用 pnpm');
    expect(instructions).toContain('agent_hub_escalate');
  });

  it('is idempotent when init runs twice', async () => {
    const dir = tempDir();
    await init(dir);
    await init(dir);

    const instructions = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(instructions.match(/<!-- zhunzou:begin -->/g)).toHaveLength(1);
    expect(instructions.match(/<!-- zhunzou:end -->/g)).toHaveLength(1);
  });

  it('derives a per-workspace AGENT_ENV so multiple Cursor windows stay visible', async () => {
    const root = tempDir();

    async function initProject(name: string): Promise<string> {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      const code = await runInit({
        dir,
        hubUrl: 'https://hub.example.com',
        token: 'secret-token',
        target: 'cursor',
        yes: true,
        skipCheck: true,
        noAgentToken: true,
      });
      expect(code).toBe(0);
      const config = JSON.parse(
        readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8'),
      ) as { mcpServers: { zhunzou: { env: Record<string, string> } } };
      return config.mcpServers.zhunzou.env.AGENT_ENV;
    }

    expect(await initProject('yikuaomed-erp')).toBe('cursor-yikuaomed-erp');
    expect(await initProject('design-system')).toBe('cursor-design-system');
  });

  it('provisions a scoped agent token instead of writing the admin token', async () => {
    const dir = tempDir();
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ token: 'zz_issued_token', agent: {} }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;

    try {
      const code = await runInit({
        dir,
        hubUrl: `http://127.0.0.1:${address.port}`,
        token: 'admin-secret-token',
        env: 'home-opencode',
        target: 'opencode',
        yes: true,
        skipCheck: true,
      });
      expect(code).toBe(0);
      expect(requests).toContain('POST /api/agents/home-opencode/token');

      const config = JSON.parse(
        readFileSync(join(dir, 'opencode.json'), 'utf8'),
      ) as {
        mcp: {
          servers: {
            zhunzou: { environment: Record<string, string> };
          };
        };
      };
      const env = config.mcp.servers.zhunzou.environment;
      expect(env.HUB_TOKEN).toBe('zz_issued_token');
      expect(env.HUB_TOKEN).not.toBe('admin-secret-token');
      expect(env.ZHUNZOU_AGENT_KIND).toBe('opencode');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
