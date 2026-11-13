import { describe, expect, it } from 'vitest';

import { HELP, envFromArgs, parseArgs } from '../src/cli.js';

describe('zhunzou-device join', () => {
  it('takes the hub url as a positional argument', () => {
    const parsed = parseArgs(['join', 'https://hub.example.com', '--token', 'zz_1']);

    expect(parsed).toMatchObject({
      command: 'join',
      hub: 'https://hub.example.com',
      token: 'zz_1',
    });
  });

  it('collects the routing flags into the device environment', () => {
    const parsed = parseArgs([
      'join',
      'http://127.0.0.1:8787',
      '--token',
      'zz_1',
      '--env',
      'mini',
      '--role',
      'hybrid',
      '--tags',
      'office,gpu',
      '--max-concurrency',
      '4',
      '--scan-dir',
      '/Users/me/code',
      '--scan-dir',
      '/srv/work',
    ]);
    const env = envFromArgs(parsed);

    expect(env).toMatchObject({
      ZHUNZOU_HUB_URL: 'http://127.0.0.1:8787',
      ZHUNZOU_DEVICE_TOKEN: 'zz_1',
      ZHUNZOU_DEVICE_ENV: 'mini',
      ZHUNZOU_NODE_ROLE: 'hybrid',
      ZHUNZOU_NODE_TAGS: 'office,gpu',
      ZHUNZOU_MAX_CONCURRENCY: '4',
      ZHUNZOU_SCAN_DIRS: '/Users/me/code,/srv/work',
    });
  });

  it('documents the join command in the help text', () => {
    expect(HELP).toContain('zhunzou-device join <hub-url>');
    expect(HELP).toContain('--scan-dir');
    expect(HELP).toContain('--max-concurrency');
  });

  it('keeps the run command working with flags only', () => {
    expect(parseArgs(['--hub', 'http://127.0.0.1:8787', '--env', 'mac'])).toMatchObject({
      command: 'run',
      hub: 'http://127.0.0.1:8787',
      env: 'mac',
    });
  });
});
