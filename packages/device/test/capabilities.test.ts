import { describe, expect, it } from 'vitest';

import { detectCapabilities, detectStats, detectTools } from '../src/capabilities.js';
import { deviceSocketUrl, type DeviceConfig } from '../src/config.js';

describe('device capabilities', () => {
  it('detects the running node binary and returns a valid inventory', () => {
    const tools = detectTools(['node']);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0]).toMatchObject({ name: 'node' });
    expect(tools[0]!.path).toBeTruthy();
  });

  it('builds a capability document with protocol and features', () => {
    const capabilities = detectCapabilities();
    expect(capabilities.protocol).toBe(1);
    expect(capabilities.os).toBeTruthy();
    expect(capabilities.arch).toBeTruthy();
    expect(capabilities.hostname).toBeTruthy();
    expect(capabilities.features).toContain('ws');
    expect(capabilities.features).toContain('heartbeat');
  });

  it('reports machine stats', () => {
    const stats = detectStats();
    expect(stats.cpuCount).toBeGreaterThan(0);
    expect(stats.totalMemBytes).toBeGreaterThan(0);
    expect(stats.uptimeSec).toBeGreaterThan(0);
  });
});

describe('device config', () => {
  it('converts http(s) hub URLs to the device socket', () => {
    const config: DeviceConfig = {
      hubUrl: 'https://hub.example.com',
      token: 'zz_test',
      env: 'home-mac',
      heartbeatMs: 30_000,
      reconnectMinMs: 1_000,
      reconnectMaxMs: 30_000,
    };
    expect(deviceSocketUrl(config)).toBe(
      'wss://hub.example.com/ws/device?env=home-mac',
    );
  });

  it('keeps an explicit ws URL and preserves a base path', () => {
    const config: DeviceConfig = {
      hubUrl: 'ws://127.0.0.1:8787/base',
      token: 'zz_test',
      env: 'office-pc',
      heartbeatMs: 30_000,
      reconnectMinMs: 1_000,
      reconnectMaxMs: 30_000,
    };
    expect(deviceSocketUrl(config)).toBe(
      'ws://127.0.0.1:8787/base/ws/device?env=office-pc',
    );
  });
});
