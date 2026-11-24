import { describe, expect, it } from 'vitest';

import {
  removeCodexSection,
  removeMcpServer,
  removeOpenCodeServer,
  removeVscodeServer,
} from '../src/uninstall.js';

describe('uninstall removes only our entry', () => {
  it('keeps the other mcpServers entries', () => {
    const { next, changed } = removeMcpServer({
      mcpServers: {
        zhunzou: { command: 'node' },
        octo: { command: 'octo' },
      },
      theme: 'dark',
    });

    expect(changed).toBe(true);
    expect(next).toMatchObject({
      theme: 'dark',
      mcpServers: { octo: { command: 'octo' } },
    });
  });

  it('reports no change when the file never had us', () => {
    expect(removeMcpServer({ mcpServers: {} }).changed).toBe(false);
    expect(removeMcpServer(undefined).changed).toBe(false);
  });

  it('removes both OpenCode shapes', () => {
    const modern = removeOpenCodeServer({
      mcp: { servers: { zhunzou: {}, other: {} }, theme: 'x' },
    });
    expect(modern.next).toMatchObject({
      mcp: { servers: { other: {} }, theme: 'x' },
    });

    const legacy = removeOpenCodeServer({ mcp: { zhunzou: {}, other: {} } });
    expect(legacy.next).toMatchObject({ mcp: { other: {} } });
  });

  it('removes VS Code servers entries', () => {
    const { next, changed } = removeVscodeServer({
      servers: { zhunzou: { type: 'stdio' }, keep: { type: 'http' } },
    });
    expect(changed).toBe(true);
    expect(next).toMatchObject({ servers: { keep: { type: 'http' } } });
  });

  it('drops the Codex TOML section and leaves the rest intact', () => {
    const text = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.zhunzou]',
      'command = "node"',
      'args = ["mcp.mjs"]',
      '',
      '[mcp_servers.other]',
      'command = "other"',
      '',
    ].join('\n');

    const { next, changed } = removeCodexSection(text);
    expect(changed).toBe(true);
    expect(next).toContain('model = "gpt-5"');
    expect(next).toContain('[mcp_servers.other]');
    expect(next).not.toContain('zhunzou');
  });

  it('leaves a Codex config without our section alone', () => {
    expect(removeCodexSection('model = "gpt-5"\n').changed).toBe(false);
  });
});
