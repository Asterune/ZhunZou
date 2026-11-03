import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentTask } from '@zhunzou/shared';

import {
  agentKindForAdapter,
  buildFleetRuntimes,
  buildLaunchdPlist,
  loadFleetConfig,
  resolveFleetTokens,
  runFleet,
} from '../src/fleet.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-fleet-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(dir: string, value: unknown): string {
  const path = join(dir, 'fleet.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

interface FakeHub {
  baseUrl: string;
  requests: Array<{ method: string; url: string; body: unknown }>;
  close: () => Promise<void>;
}

async function startHub(
  handler: (
    request: { method: string; url: string; body: unknown },
    response: ServerResponse,
  ) => void,
): Promise<FakeHub> {
  const requests: FakeHub['requests'] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const captured = {
        method: req.method ?? '',
        url: req.url ?? '',
        body: raw ? JSON.parse(raw) : null,
      };
      requests.push(captured);
      handler(captured, res);
    });
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

describe('loadFleetConfig', () => {
  it('resolves project paths and applies defaults', () => {
    const dir = tempDir();
    const path = writeConfig(dir, {
      hubUrl: 'https://hub.example.com/',
      projects: [{ env: 'demo', path: './project' }],
    });

    const config = loadFleetConfig(path);

    expect(config.hubUrl).toBe('https://hub.example.com/');
    expect(config.adapter).toBe('auto');
    expect(config.projects[0]?.absolutePath).toBe(join(dir, 'project'));
  });

  it('rejects duplicate envs', () => {
    const dir = tempDir();
    const path = writeConfig(dir, {
      hubUrl: 'https://hub.example.com',
      projects: [
        { env: 'demo', path: './a' },
        { env: 'demo', path: './b' },
      ],
    });

    expect(() => loadFleetConfig(path)).toThrow(/duplicate env/);
  });

  it('reports invalid JSON with the file path', () => {
    const dir = tempDir();
    const path = join(dir, 'fleet.json');
    writeFileSync(path, '{ nope', 'utf8');

    expect(() => loadFleetConfig(path)).toThrow(/not valid JSON/);
  });
});

describe('agentKindForAdapter', () => {
  it('maps CLI presets to registry kinds', () => {
    expect(agentKindForAdapter('cursor-agent')).toBe('cursor');
    expect(agentKindForAdapter('opencode-run')).toBe('opencode');
    expect(agentKindForAdapter('claude')).toBe('claude-code');
    expect(agentKindForAdapter('command')).toBe('other');
  });
});

describe('buildLaunchdPlist', () => {
  it('runs fleet at login with a PATH that finds CLI agents', () => {
    const plist = buildLaunchdPlist({
      nodePath: '/usr/local/bin/node',
      cliPath: '/opt/zhunzou/packages/bridge/bin/cli.js',
      configPath: '/Users/me/.zhunzou/fleet.json',
      logDir: '/tmp/logs',
    });

    expect(plist).toContain('com.zhunzou.fleet');
    expect(plist).toContain('<string>fleet</string>');
    expect(plist).toContain('/Users/me/.zhunzou/fleet.json');
    expect(plist).toContain('.local/bin');
    expect(plist).toContain('/tmp/logs/zhunzou-fleet.log');
    expect(plist).toContain('<key>KeepAlive</key>');
  });
});

describe('resolveFleetTokens', () => {
  it('registers agents, issues tokens and caches them with 0600', async () => {
    const dir = tempDir();
    const cachePath = join(dir, 'tokens.json');
    const hub = await startHub((request, response) => {
      if (request.url === '/api/agents') {
        json(response, 201, { agent: { env: 'demo' } });
        return;
      }
      if (request.url === '/api/agents/demo/token') {
        json(response, 200, { agent: { env: 'demo' }, token: 'zz_issued' });
        return;
      }
      json(response, 404, { error: { message: 'not found' } });
    });

    try {
      const path = writeConfig(dir, {
        hubUrl: hub.baseUrl,
        adminToken: 'admin-token',
        projects: [{ env: 'demo', path: './project', project: 'demo' }],
      });
      const config = loadFleetConfig(path);

      const tokens = await resolveFleetTokens(config, { tokenCachePath: cachePath });
      expect(tokens.get('demo')).toBe('zz_issued');
      expect(hub.requests.map((item) => `${item.method} ${item.url}`)).toEqual([
        'POST /api/agents',
        'POST /api/agents/demo/token',
      ]);

      const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<
        string,
        string
      >;
      expect(cached.demo).toBe('zz_issued');
      expect(statSync(cachePath).mode & 0o777).toBe(0o600);

      // Second start must reuse the cached token instead of rotating it.
      const again = await resolveFleetTokens(config, { tokenCachePath: cachePath });
      expect(again.get('demo')).toBe('zz_issued');
      expect(hub.requests).toHaveLength(2);
    } finally {
      await hub.close();
    }
  });

  it('requires a token or admin token', async () => {
    const dir = tempDir();
    const path = writeConfig(dir, {
      hubUrl: 'https://hub.example.com',
      projects: [{ env: 'demo', path: './project' }],
    });

    await expect(
      resolveFleetTokens(loadFleetConfig(path), {
        tokenCachePath: join(dir, 'none.json'),
      }),
    ).rejects.toThrow(/no token for demo/);
  });
});

describe('buildFleetRuntimes', () => {
  it('carries env, cwd, adapter and extra args per project', () => {
    const dir = tempDir();
    const path = writeConfig(dir, {
      hubUrl: 'https://hub.example.com',
      adapter: 'cursor-agent',
      projects: [
        { env: 'a', path: './a', args: ['--model', 'gpt-5'] },
        { env: 'b', path: './b', adapter: 'opencode-run' },
      ],
    });

    const runtimes = buildFleetRuntimes(
      loadFleetConfig(path),
      new Map([
        ['a', 'zz_a'],
        ['b', 'zz_b'],
      ]),
    );

    expect(runtimes).toHaveLength(2);
    expect(runtimes[0]).toMatchObject({
      hub: { agentEnv: 'a', token: 'zz_a', agentKind: 'cursor' },
      wake: { adapter: 'cursor-agent', extraArgs: ['--model', 'gpt-5'] },
    });
    expect(runtimes[0]?.wake.cwd).toBe(join(dir, 'a'));
    expect(runtimes[1]).toMatchObject({
      hub: { agentEnv: 'b', agentKind: 'opencode' },
      wake: { adapter: 'opencode-run' },
    });
  });
});

describe('runFleet', () => {
  it('claims a task and reports completion for a project', async () => {
    const dir = tempDir();
    const task: AgentTask = {
      id: '7',
      env: 'demo',
      projectName: 'demo',
      title: '跑一次命令',
      instruction: '执行',
      status: 'PENDING',
      attempts: 0,
      createdAt: 1,
      updatedAt: 1,
    };

    let claimed = false;
    const completed: unknown[] = [];
    const hub = await startHub((request, response) => {
      if (request.url?.startsWith('/api/tasks/next')) {
        if (!claimed) {
          claimed = true;
          json(response, 200, { task, timedOut: false });
        } else {
          json(response, 200, { task: null, timedOut: true });
        }
        return;
      }
      if (request.url === '/api/tasks/7/complete') {
        completed.push(request.body);
        json(response, 200, { task: { ...task, status: 'DONE' } });
        return;
      }
      if (request.url === '/api/status/heartbeat') {
        json(response, 200, {
          heartbeat: { env: 'demo', status: 'Idle', lastSeenAt: 1, online: true },
        });
        return;
      }
      json(response, 404, { error: { message: 'not found' } });
    });

    try {
      const path = writeConfig(dir, {
        hubUrl: hub.baseUrl,
        projects: [
          {
            env: 'demo',
            path: dir,
            project: 'demo',
            adapter: 'command',
            command: 'true',
            token: 'zz_demo',
          },
        ],
      });

      const code = await runFleet(loadFleetConfig(path), {
        once: true,
        tokenCachePath: join(dir, 'tokens.json'),
        stdout: () => undefined,
        stderr: () => undefined,
      });

      expect(code).toBe(0);
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ status: 'DONE' });
    } finally {
      await hub.close();
    }
  });
});
