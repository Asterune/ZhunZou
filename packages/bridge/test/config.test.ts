import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectWorkspaceProject, loadBridgeConfig } from '../src/config.js';

describe('loadBridgeConfig', () => {
  it('requires HUB_TOKEN', () => {
    expect(() => loadBridgeConfig({})).toThrow(/HUB_TOKEN/);
  });

  it('applies local-development defaults', () => {
    const config = loadBridgeConfig({ HUB_TOKEN: 'secret' }, '/workspace/demo-project');
    expect(config.hubUrl).toBe('http://127.0.0.1:8787');
    expect(config.token).toBe('secret');
    expect(config.fallback).toBe('cli');
    expect(config.waitTimeoutMs).toBe(40_000);
    expect(config.agentEnv).toContain('unknown-');
    expect(config.projectName).toBe('demo-project');
    expect(config.cliCommand).toBe('npx zhunzou-bridge');
    expect(config.heartbeatIntervalMs).toBe(30_000);
    expect(config.agentKind).toBe('other');
  });

  it('parses ZHUNZOU_AGENT_KIND and falls back to other', () => {
    expect(
      loadBridgeConfig({
        HUB_TOKEN: 'secret',
        ZHUNZOU_AGENT_KIND: 'opencode',
      }).agentKind,
    ).toBe('opencode');
    expect(
      loadBridgeConfig({
        HUB_TOKEN: 'secret',
        ZHUNZOU_AGENT_KIND: 'not-a-client',
      }).agentKind,
    ).toBe('other');
  });

  it('auto-detects the project from the git workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'zhunzou-ws-'));
    const workspace = join(root, 'yikuaomed-erp');
    const nested = join(workspace, 'apps', 'web');
    mkdirSync(join(workspace, '.git'), { recursive: true });
    mkdirSync(nested, { recursive: true });

    expect(detectWorkspaceProject(nested)).toBe('yikuaomed-erp');
    expect(loadBridgeConfig({ HUB_TOKEN: 'secret' }, nested).projectName).toBe(
      'yikuaomed-erp',
    );
  });

  it('accepts a project binding hint for the workspace', () => {
    const config = loadBridgeConfig(
      {
        HUB_TOKEN: 'secret',
        ZHUNZOU_PROJECT: ' agent-hub ',
      },
      '/workspace/other-project',
    );
    expect(config.projectName).toBe('agent-hub');
  });

  it('accepts a custom CLI command for self-hosted bridges', () => {
    const config = loadBridgeConfig({
      HUB_TOKEN: 'secret',
      ZHUNZOU_CLI_COMMAND: 'node /opt/zhunzou/packages/bridge/dist/cli.js',
    });
    expect(config.cliCommand).toBe('node /opt/zhunzou/packages/bridge/dist/cli.js');
  });

  it('accepts the MCP relay fallback and a custom env', () => {
    const config = loadBridgeConfig({
      HUB_TOKEN: 'secret',
      HUB_URL: 'https://hub.example.com/',
      AGENT_ENV: 'home-opencode',
      AGENT_HUB_FALLBACK: 'mcp',
      AGENT_HUB_WAIT_TIMEOUT_MS: '12000',
    });

    expect(config.hubUrl).toBe('https://hub.example.com');
    expect(config.agentEnv).toBe('home-opencode');
    expect(config.fallback).toBe('mcp');
    expect(config.waitTimeoutMs).toBe(12_000);
  });

  it('clamps the wait window to the proxy-safe range', () => {
    expect(
      loadBridgeConfig({ HUB_TOKEN: 's', AGENT_HUB_WAIT_TIMEOUT_MS: '10' }).waitTimeoutMs,
    ).toBe(1_000);
    expect(
      loadBridgeConfig({ HUB_TOKEN: 's', AGENT_HUB_WAIT_TIMEOUT_MS: '999999' }).waitTimeoutMs,
    ).toBe(55_000);
  });

  it('rejects invalid or non-http URLs', () => {
    expect(() => loadBridgeConfig({ HUB_TOKEN: 's', HUB_URL: 'not a url' })).toThrow(
      /valid URL/,
    );
    expect(() =>
      loadBridgeConfig({ HUB_TOKEN: 's', HUB_URL: 'ftp://example.com' }),
    ).toThrow(/http or https/);
  });
});
