import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findDelegationTarget } from '../src/launcher.js';

let root = '';

function installVersion(version: string): void {
  mkdirSync(join(root, 'versions', version), { recursive: true });
  writeFileSync(join(root, 'versions', version, 'mcp.mjs'), `// ${version}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zhunzou-launcher-'));
  writeFileSync(join(root, 'mcp.mjs'), '// bootstrap\n');
});

afterEach(() => {
  delete process.env.ZHUNZOU_NO_DELEGATE;
  rmSync(root, { recursive: true, force: true });
});

describe('findDelegationTarget', () => {
  it('returns null without a current.json', () => {
    expect(findDelegationTarget(join(root, 'mcp.mjs'), '0.1.0')).toBeNull();
  });

  it('returns null when the bootstrap already is the active version', () => {
    installVersion('0.1.0');
    writeFileSync(join(root, 'current.json'), JSON.stringify({ version: '0.1.0' }));

    expect(findDelegationTarget(join(root, 'mcp.mjs'), '0.1.0')).toBeNull();
  });

  it('delegates to the version recorded in current.json', () => {
    installVersion('0.2.0');
    writeFileSync(join(root, 'current.json'), JSON.stringify({ version: '0.2.0' }));

    expect(findDelegationTarget(join(root, 'mcp.mjs'), '0.1.0')).toEqual({
      version: '0.2.0',
      entry: join(root, 'versions', '0.2.0', 'mcp.mjs'),
    });
  });

  it('resolves the install root from a version directory', () => {
    installVersion('0.3.0');
    writeFileSync(join(root, 'current.json'), JSON.stringify({ version: '0.3.0' }));

    expect(
      findDelegationTarget(join(root, 'versions', '0.2.0', 'mcp.mjs'), '0.2.0'),
    ).toEqual({
      version: '0.3.0',
      entry: join(root, 'versions', '0.3.0', 'mcp.mjs'),
    });
  });

  it('ignores current.json that points at a missing file', () => {
    writeFileSync(join(root, 'current.json'), JSON.stringify({ version: '9.9.9' }));

    expect(findDelegationTarget(join(root, 'mcp.mjs'), '0.1.0')).toBeNull();
  });

  it('honours the ZHUNZOU_NO_DELEGATE escape hatch', () => {
    installVersion('0.2.0');
    writeFileSync(join(root, 'current.json'), JSON.stringify({ version: '0.2.0' }));
    process.env.ZHUNZOU_NO_DELEGATE = '1';

    expect(findDelegationTarget(join(root, 'mcp.mjs'), '0.1.0')).toBeNull();
  });
});
