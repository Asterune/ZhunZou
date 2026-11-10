import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentTask } from '@zhunzou/shared';

import {
  addFleetProjects,
  agentKindForAdapter,
  buildFleetRuntimes,
  buildLaunchdPlist,
  defaultEnvForProject,
  loadFleetConfig,
  readFleetFile,
  removeFleetProject,
  resolveFleetTokens,
  runFleet,
  writeFleetFile,
} from '../src/fleet.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-fleet-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Put fake executables on a throwaway PATH so adapter detection is stable. */
function stubPathWith(dir: string, binaries: string[]): void {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  for (const name of binaries) {
    const file = join(bin, `${name}${suffix}`);
    writeFileSync(file, 'exit 0\n', 'utf8');
    chmodSync(file, 0o755);
  }
  vi.stubEnv('PATH', bin);
}

function writeConfig(dir: string, value: unknown): string {
  const path = join(dir, 'fleet.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

/** Fake Cursor's recent-workspace history in a throwaway home directory. */
function writeEditorStorage(home: string, repos: string[]): void {
  const dir = join(
    home,
    'Library',
    'Application Support',
    'Cursor',
    'User',
    'globalStorage',
  );
  mkdirSync(dir, { recursive: true });
  const workspaces = Object.fromEntries(
    repos.map((repo) => [pathToFileURL(repo).href, {}]),
  );
  writeFileSync(
    join(dir, 'storage.json'),
    JSON.stringify({ profileAssociations: { workspaces } }),
    'utf8',
  );
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('timed out waiting for condition');
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

  it('adds git repos discovered under scan.roots', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'repos', 'one', '.git'), { recursive: true });
    mkdirSync(join(dir, 'repos', 'team', 'two', '.git'), {
      recursive: true,
    });
    const path = writeConfig(dir, {
      hubUrl: 'https://hub.example.com',
      adapter: 'cursor-agent',
      projects: [{ env: 'explicit', path: './repos/one' }],
      scan: { roots: ['./repos'], depth: 2 },
    });

    const config = loadFleetConfig(path);

    expect(config.projects.map((project) => project.env)).toEqual([
      'explicit',
      'cursor-two',
    ]);
    expect(config.projects[1]).toMatchObject({
      env: 'cursor-two',
      path: join(dir, 'repos', 'team', 'two'),
      absolutePath: join(dir, 'repos', 'team', 'two'),
      project: 'two',
      adapter: 'cursor-agent',
      discovered: true,
    });
  });

  it('keeps discovered envs unique when basenames collide', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'repos', 'a', 'same', '.git'), { recursive: true });
    mkdirSync(join(dir, 'repos', 'b', 'same', '.git'), { recursive: true });
    stubPathWith(dir, ['opencode']);
    const path = writeConfig(dir, {
      hubUrl: 'https://hub.example.com',
      scan: { roots: ['./repos'], depth: 2 },
    });

    const config = loadFleetConfig(path);

    expect(config.projects.map((project) => project.env)).toEqual([
      'opencode-same',
      'opencode-same-2',
    ]);
    expect(config.projects.every((project) => project.discovered)).toBe(true);
  });

  it('falls back to the agent prefix when no CLI is on PATH', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'repos', 'solo', '.git'), { recursive: true });
    vi.stubEnv('PATH', '');
    const path = writeConfig(dir, {
      hubUrl: 'https://hub.example.com',
      scan: { roots: ['./repos'], depth: 1 },
    });

    expect(loadFleetConfig(path).projects[0]?.env).toBe('agent-solo');
  });

  it('accepts a scan-only config and rejects a completely empty one', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'repos', 'solo', '.git'), { recursive: true });
    const scanned = writeConfig(dir, {
      hubUrl: 'https://hub.example.com',
      scan: { roots: ['./repos'], depth: 1 },
    });

    expect(loadFleetConfig(scanned).projects).toHaveLength(1);

    const empty = writeConfig(dir, { hubUrl: 'https://hub.example.com' });
    expect(() => loadFleetConfig(empty)).toThrow(/no projects/);
  });

  it('adopts recently opened editor workspaces when scan is absent', () => {
    const home = tempDir();
    const repo = join(home, 'code', 'erp');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const plain = join(home, 'code', 'notes');
    mkdirSync(plain, { recursive: true });
    writeEditorStorage(home, [repo, plain]);

    const dir = tempDir();
    const path = writeConfig(dir, {
      hubUrl: 'https://hub.example.com',
      adapter: 'cursor-agent',
    });

    // Opt-in: a plain config read must stay deterministic.
    expect(() => loadFleetConfig(path)).toThrow(/no projects/);

    const config = loadFleetConfig(path, {
      autoDiscover: true,
      workspaces: { platform: 'darwin', home },
    });

    // Only git repositories are adopted; a plain folder is ignored.
    expect(config.projects).toHaveLength(1);
    expect(config.projects[0]).toMatchObject({
      env: 'cursor-erp',
      path: repo,
      absolutePath: repo,
      project: 'erp',
      adapter: 'cursor-agent',
      discovered: true,
      implicit: true,
    });
  });

  it('does not duplicate a workspace that is already configured', () => {
    const home = tempDir();
    const repo = join(home, 'code', 'erp');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeEditorStorage(home, [repo]);

    const dir = tempDir();
    const path = writeConfig(dir, {
      hubUrl: 'https://hub.example.com',
      projects: [{ env: 'hand-written', path: repo }],
    });

    const config = loadFleetConfig(path, {
      autoDiscover: true,
      workspaces: { platform: 'darwin', home },
    });

    expect(config.projects.map((project) => project.env)).toEqual([
      'hand-written',
    ]);
    expect(config.projects[0]?.implicit).toBeUndefined();
  });

  it('prefers explicit scan.roots over editor history', () => {
    const home = tempDir();
    const recent = join(home, 'code', 'recent');
    mkdirSync(join(recent, '.git'), { recursive: true });
    writeEditorStorage(home, [recent]);

    const dir = tempDir();
    mkdirSync(join(dir, 'rooted', '.git'), { recursive: true });
    const path = writeConfig(dir, {
      hubUrl: 'https://hub.example.com',
      adapter: 'cursor-agent',
      scan: { roots: ['./rooted'], depth: 1 },
    });

    const config = loadFleetConfig(path, {
      autoDiscover: true,
      workspaces: { platform: 'darwin', home },
    });

    expect(config.projects.map((project) => project.project)).toEqual(['rooted']);
  });
});

describe('defaultEnvForProject', () => {
  it('names auto envs after the detected client, matching init MCP envs', () => {
    const dir = tempDir();
    stubPathWith(dir, ['opencode']);

    expect(defaultEnvForProject('auto', 'My Project')).toBe('opencode-my-project');
  });

  it('detects claude when opencode is absent', () => {
    const dir = tempDir();
    stubPathWith(dir, ['claude']);

    expect(defaultEnvForProject('auto', 'demo')).toBe('claude-demo');
  });

  it('detects qoder when it is the only client on PATH', () => {
    const dir = tempDir();
    stubPathWith(dir, ['qoder']);

    expect(defaultEnvForProject('auto', 'demo')).toBe('qoder-demo');
  });

  it('detects the qodercli / qcode installer aliases too', () => {
    const npm = tempDir();
    stubPathWith(npm, ['qodercli']);
    expect(defaultEnvForProject('auto', 'demo')).toBe('qoder-demo');

    const alias = tempDir();
    stubPathWith(alias, ['qcode']);
    expect(defaultEnvForProject('auto', 'demo')).toBe('qoder-demo');
  });

  it('keeps explicit adapter prefixes and falls back for unknown ones', () => {
    expect(defaultEnvForProject('cursor-agent', 'demo')).toBe('cursor-demo');
    expect(defaultEnvForProject('qoder', 'demo')).toBe('qoder-demo');
    expect(defaultEnvForProject('command', 'demo')).toBe('agent-demo');
  });
});

describe('agentKindForAdapter', () => {
  it('maps CLI presets to registry kinds', () => {
    expect(agentKindForAdapter('cursor-agent')).toBe('cursor');
    expect(agentKindForAdapter('opencode-run')).toBe('opencode');
    expect(agentKindForAdapter('claude')).toBe('claude-code');
    expect(agentKindForAdapter('qoder')).toBe('qoder');
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

      // Registration carries machine metadata so the node card is correct
      // even if the project never wakes up.
      expect(hub.requests[0]?.body).toMatchObject({
        env: 'demo',
        host: expect.any(String),
        os: expect.any(String),
        kind: expect.any(String),
      });

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

  it('adopts the env the hub allocates when another machine owns the label', async () => {
    const dir = tempDir();
    const cachePath = join(dir, 'tokens.json');
    writeFileSync(cachePath, JSON.stringify({ demo: 'zz_shared' }), {
      mode: 0o600,
    });

    const hub = await startHub((request, response) => {
      if (request.url === '/api/agents') {
        json(response, 201, { agent: { env: 'demo-home-mac' } });
        return;
      }
      if (request.url === '/api/agents/demo-home-mac/token') {
        json(response, 200, { agent: { env: 'demo-home-mac' }, token: 'zz_new' });
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
      const lines: string[] = [];

      const tokens = await resolveFleetTokens(config, {
        tokenCachePath: cachePath,
        refreshTokens: true,
        stderr: (line) => lines.push(line),
      });

      expect(hub.requests.map((item) => item.url)).toEqual([
        '/api/agents',
        '/api/agents/demo-home-mac/token',
      ]);
      expect(tokens.get('demo-home-mac')).toBe('zz_new');
      expect(config.projects[0]?.env).toBe('demo-home-mac');
      expect(lines.join('')).toContain('demo-home-mac');

      // The token minted for the shared label must not survive under it.
      const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<
        string,
        string
      >;
      expect(cached).toEqual({ 'demo-home-mac': 'zz_new' });
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

  it('skips implicit discoveries when no admin token is available', async () => {
    const home = tempDir();
    const repo = join(home, 'code', 'erp');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeEditorStorage(home, [repo]);

    const dir = tempDir();
    const path = writeConfig(dir, {
      hubUrl: 'https://hub.example.com',
      projects: [{ env: 'demo', path: './project', token: 'zz_demo' }],
    });
    const config = loadFleetConfig(path, {
      autoDiscover: true,
      workspaces: { platform: 'darwin', home },
    });
    expect(config.projects).toHaveLength(2);

    const tokens = await resolveFleetTokens(config, {
      tokenCachePath: join(dir, 'none.json'),
    });

    // The explicit project keeps working; the auto-discovered one is skipped
    // instead of failing the whole fleet.
    expect([...tokens.keys()]).toEqual(['demo']);
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

  it('applies and removes dashboard associations at runtime', async () => {
    const dir = tempDir();
    const root = join(dir, 'repos');
    const base = join(dir, 'base');
    const newRepo = join(root, 'new-repo');
    mkdirSync(base, { recursive: true });
    mkdirSync(root, { recursive: true });

    const startedAt = Date.now();
    let desired: Array<Record<string, unknown>> = [];
    let browseTasks: Array<Record<string, unknown>> = [];
    const statuses: Array<Record<string, unknown>> = [];
    const candidateReports: Array<Record<string, unknown>> = [];
    const browseResults: Array<Record<string, unknown>> = [];

    const hub = await startHub((request, response) => {
      if (request.url?.startsWith('/api/tasks')) {
        json(response, 200, { tasks: [], total: 0 });
        return;
      }
      if (request.url === '/api/status/heartbeat') {
        json(response, 200, {
          heartbeat: { env: 'base', status: 'Idle', lastSeenAt: 1, online: true },
        });
        return;
      }
      if (request.url === '/api/fleet/candidates') {
        candidateReports.push(request.body as Record<string, unknown>);
        json(response, 200, { candidates: [], total: 0 });
        return;
      }
      if (request.url?.startsWith('/api/fleet/desired?')) {
        json(response, 200, { workspaces: desired, browse: browseTasks });
        return;
      }
      if (request.url === '/api/fleet/browse/2/result') {
        browseResults.push(request.body as Record<string, unknown>);
        browseTasks = [];
        json(response, 200, {
          request: {
            id: '2',
            host: 'test-host',
            path: root,
            status: 'DONE',
            entries: [],
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        });
        return;
      }
      if (request.url === '/api/fleet/desired/1/status') {
        statuses.push(request.body as Record<string, unknown>);
        if ((request.body as { status?: string }).status === 'APPLIED') {
          desired = [];
        }
        json(response, 200, {
          workspace: {
            id: '1',
            host: 'test-host',
            env: 'agent-new-repo',
            path: newRepo,
            projectName: 'new-repo',
            status: 'APPLIED',
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        });
        return;
      }
      json(response, 404, { error: { message: 'not found' } });
    });

    const previousInterval = process.env.ZHUNZOU_WAKE_NOTIFY_INTERVAL_MS;
    process.env.ZHUNZOU_WAKE_NOTIFY_INTERVAL_MS = '2000';

    try {
      const configPath = writeConfig(dir, {
        hubUrl: hub.baseUrl,
        adapter: 'notify',
        scan: { roots: [root], depth: 1 },
        projects: [
          {
            env: 'base',
            path: base,
            project: 'base',
            adapter: 'notify',
            token: 'zz_base',
          },
        ],
      });
      const config = loadFleetConfig(configPath);

      // The repo appears after the config was loaded, exactly like a project
      // cloned while fleet keeps running.
      mkdirSync(join(newRepo, '.git'), { recursive: true });
      desired = [
        {
          id: '1',
          host: 'test-host',
          env: 'agent-new-repo',
          path: newRepo,
          projectName: 'new-repo',
          adapter: 'notify',
          status: 'PENDING',
          token: 'zz_new',
          createdAt: startedAt,
          updatedAt: startedAt,
        },
      ];
      browseTasks = [
        { id: '2', host: 'test-host', path: root, requestedAt: startedAt },
      ];

      const controller = new AbortController();
      const running = runFleet(config, {
        configPath,
        signal: controller.signal,
        syncIntervalMs: 2_000,
        stdout: () => undefined,
        stderr: () => undefined,
      });

      await waitFor(() => {
        const file = readFleetFile(configPath);
        return file.projects.some(
          (project) => project.env === 'agent-new-repo',
        );
      });

      const added = readFleetFile(configPath).projects.find(
        (project) => project.env === 'agent-new-repo',
      );
      expect(added).toMatchObject({
        path: newRepo,
        project: 'new-repo',
        source: 'hub',
        token: 'zz_new',
      });

      await waitFor(
        () => statuses.some((item) => item.status === 'APPLIED'),
      );
      await waitFor(() => browseResults.length > 0);

      const firstReport = candidateReports[0] as {
        candidates?: Array<{ path: string; associated: boolean }>;
      };
      expect(firstReport.candidates).toContainEqual(
        expect.objectContaining({ path: newRepo, associated: false }),
      );
      expect(statuses).toContainEqual(
        expect.objectContaining({ status: 'APPLIED' }),
      );

      const browseResult = browseResults[0] as {
        entries?: Array<{ name: string; isRepo: boolean }>;
      };
      expect(browseResult.entries).toContainEqual(
        expect.objectContaining({ name: 'new-repo', isRepo: true }),
      );

      // Unbinding in the dashboard removes the directory and stops its loop.
      await waitFor(
        () =>
          !readFleetFile(configPath).projects.some(
            (project) => project.env === 'agent-new-repo',
          ),
      );

      controller.abort();
      await running;
    } finally {
      if (previousInterval === undefined) {
        delete process.env.ZHUNZOU_WAKE_NOTIFY_INTERVAL_MS;
      } else {
        process.env.ZHUNZOU_WAKE_NOTIFY_INTERVAL_MS = previousInterval;
      }
      await hub.close();
    }
  }, 20_000);
});

describe('editing fleet.json', () => {
  it('adds projects, preserves unknown keys and upserts by env', () => {
    const dir = tempDir();
    const path = join(dir, 'fleet.json');
    writeFileSync(
      path,
      JSON.stringify({
        hubUrl: 'https://hub.example.com',
        adminToken: 'admin',
        adapter: 'auto',
        custom: 'keep-me',
        projects: [{ env: 'cursor-a', path: '/work/a', token: 'zz_old' }],
      }),
    );

    const first = addFleetProjects({
      configPath: path,
      projects: [
        { env: 'agent-b', path: '/work/b', project: 'b', adapter: 'auto' },
      ],
    });
    expect(first.added.map((project) => project.env)).toEqual(['agent-b']);

    const second = addFleetProjects({
      configPath: path,
      projects: [
        { env: 'cursor-a', path: '/work/a2', project: 'a2', adapter: 'claude' },
      ],
    });
    expect(second.updated.map((project) => project.env)).toEqual(['cursor-a']);
    expect(second.updated[0]!.token).toBe('zz_old');

    const file = readFleetFile(path);
    expect(file.hubUrl).toBe('https://hub.example.com');
    expect(file.extra.custom).toBe('keep-me');
    expect(file.projects.map((project) => project.env).sort()).toEqual([
      'agent-b',
      'cursor-a',
    ]);
    expect(file.projects.find((project) => project.env === 'cursor-a')).toMatchObject({
      path: '/work/a2',
      project: 'a2',
      adapter: 'claude',
    });

    // The written file must still be loadable by the runtime.
    expect(loadFleetConfig(path).projects).toHaveLength(2);
  });

  it('removes a project and reports whether anything changed', () => {
    const dir = tempDir();
    const path = join(dir, 'fleet.json');
    writeFleetFile(
      {
        hubUrl: 'https://hub.example.com',
        projects: [
          { env: 'a', path: '/a' },
          { env: 'b', path: '/b' },
        ],
        extra: {},
      },
      path,
    );

    expect(removeFleetProject('a', path)).toBe(true);
    expect(removeFleetProject('missing', path)).toBe(false);
    expect(readFleetFile(path).projects.map((project) => project.env)).toEqual([
      'b',
    ]);
  });

  it('refuses to clobber a broken fleet.json', () => {
    const dir = tempDir();
    const path = join(dir, 'fleet.json');
    writeFileSync(path, '{ not json');
    expect(() => readFleetFile(path)).toThrow(/合法 JSON/);
  });
});
