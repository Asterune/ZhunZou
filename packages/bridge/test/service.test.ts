import { describe, expect, it } from 'vitest';

import {
  renderWindowsServiceCommand,
  windowsStartupPath,
  type ServiceConfig,
} from '../src/service.js';

const base: ServiceConfig = {
  env: 'office-cursor',
  hubUrl: 'https://hub.example.com',
  token: 'zz_token',
  cwd: 'C:\\Users\\liuqi\\work\\app',
  adapter: 'auto',
  cliPath: 'C:\\Users\\liuqi\\.zhunzou\\bridge\\cli.mjs',
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
};

describe('Windows service command', () => {
  it('runs wake for a single env', () => {
    const text = renderWindowsServiceCommand(base);
    expect(text).toContain('wake --cwd');
    expect(text).toContain('set "AGENT_ENV=office-cursor"');
    expect(text).toContain('cd /d "C:\\Users\\liuqi\\work\\app"');
  });

  it('runs fleet for several client envs', () => {
    const text = renderWindowsServiceCommand({
      ...base,
      mode: 'fleet',
      fleetConfig: 'C:\\Users\\liuqi\\.zhunzou\\fleet.json',
    });
    expect(text).toContain('fleet --config');
    expect(text).toContain('fleet.json');
    expect(text).not.toContain('wake --cwd');
  });

  it('resolves the per-user Startup folder and degrades without APPDATA', () => {
    expect(windowsStartupPath('C:\\Users\\liuqi\\AppData\\Roaming')).toBe(
      'C:\\Users\\liuqi\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\zhunzou-bridge.cmd',
    );
    expect(windowsStartupPath('')).toBeNull();
  });
});
