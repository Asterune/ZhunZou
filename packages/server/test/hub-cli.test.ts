import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { HUB_HELP, parseHubArgs, warningsFor } from '../src/hub-cli.js';

describe('hub command', () => {
  it('reads the one-shot flags after the command word', () => {
    expect(parseHubArgs(['hub', '--port', '8765', '--token', 'secret'])).toMatchObject({
      command: 'hub',
      port: '8765',
      token: 'secret',
    });
  });

  it('works as bare flags on the plain start path', () => {
    expect(parseHubArgs(['--port', '9000', '--db', './tmp/hub.db'])).toMatchObject({
      command: 'serve',
      port: '9000',
      dbPath: './tmp/hub.db',
    });
  });

  it('feeds loadConfig through the real environment names', () => {
    const args = parseHubArgs([
      'hub',
      '--port',
      '8765',
      '--host',
      '127.0.0.1',
      '--token',
      'secret',
      '--db',
      ':memory:',
    ]);
    const config = loadConfig({ ...process.env, ...args.env });

    expect(config).toMatchObject({ port: 8765, host: '127.0.0.1', token: 'secret' });
    expect(config.dbPath).toBe(':memory:');
  });

  it('leaves the environment untouched when no flag was given', () => {
    expect(parseHubArgs([]).env).toEqual({});
  });

  it('rejects a malformed port instead of falling back silently', () => {
    expect(() => parseHubArgs(['hub', '--port', 'ftp'])).toThrow(/--port/);
    expect(() => parseHubArgs(['hub', '--port', '70000'])).toThrow(/--port/);
  });

  it('does not accept an option-looking value as a flag argument', () => {
    expect(() => parseHubArgs(['hub', '--token', '--port'])).toThrow(/--token/);
  });

  it('warns that a command-line token is visible to other users', () => {
    expect(warningsFor(parseHubArgs(['hub', '--token', 'secret']))).toContainEqual(
      expect.stringContaining('--token'),
    );
    expect(warningsFor(parseHubArgs(['hub']))).toEqual([]);
  });

  it('documents the command', () => {
    expect(HUB_HELP).toContain('node dist/main.js hub');
    expect(HUB_HELP).toContain('--port');
  });
});
