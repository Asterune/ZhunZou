import { describe, expect, it } from 'vitest';

import {
  allocateEnv,
  hostSlug,
  hostsMatch,
  sameMachine,
} from '../src/env-allocator.js';

function registry(entries: Record<string, string | undefined>) {
  const rows = new Map<string, { host?: string | null }>();
  for (const [env, host] of Object.entries(entries)) {
    rows.set(env, host === undefined ? {} : { host });
  }
  return {
    lookup: (env: string) => rows.get(env) ?? null,
    rows,
  };
}

/** Registry whose rows also carry the machine fingerprint they proved. */
function fingerprintedRegistry(
  entries: Record<string, { host?: string; machineId?: string }>,
) {
  const rows = new Map(Object.entries(entries));
  return {
    lookup: (env: string) => rows.get(env) ?? null,
    rows,
  };
}

describe('hostSlug', () => {
  it('turns a machine name into a stable label component', () => {
    expect(hostSlug('QideMacBook-Pro.local')).toBe('qide-mac-book-pro');
    expect(hostSlug('  LQ-Desktop ')).toBe('lq-desktop');
    expect(hostSlug('')).toBe('');
  });
});

describe('hostsMatch', () => {
  it('treats casing and the .local suffix as the same machine', () => {
    expect(hostsMatch('QideMacBook-Pro.local', 'qidemacbook-pro')).toBe(true);
    expect(hostsMatch('office-pc', 'home-mac')).toBe(false);
  });

  it('lets an unattributed side claim nothing', () => {
    expect(hostsMatch(undefined, 'home-mac')).toBe(true);
    expect(hostsMatch('office-pc', undefined)).toBe(true);
  });
});

describe('sameMachine', () => {
  it('trusts a fingerprint over a hostname', () => {
    // Disk images boot a fleet of machines under one name.
    expect(
      sameMachine({ host: 'lq', machineId: 'a' }, { host: 'lq', machineId: 'b' }),
    ).toBe(false);
    // A renamed laptop is still the laptop it was.
    expect(
      sameMachine({ host: 'old-name', machineId: 'a' }, { host: 'new-name', machineId: 'a' }),
    ).toBe(true);
  });

  it('falls back to the hostname until both sides report a fingerprint', () => {
    expect(sameMachine({ host: 'lq' }, { host: 'LQ.local' })).toBe(true);
    expect(sameMachine({ host: 'lq', machineId: 'a' }, { host: 'lq' })).toBe(true);
    expect(sameMachine({}, { host: 'lq', machineId: 'a' })).toBe(true);
  });
});

describe('allocateEnv', () => {
  it('keeps a free label untouched', () => {
    const { lookup } = registry({});
    expect(allocateEnv(lookup, 'cursor-erp', { host: 'home-mac' })).toBe(
      'cursor-erp',
    );
  });

  it('is idempotent when the same machine re-registers', () => {
    const { lookup } = registry({ 'cursor-erp': 'home-mac' });
    expect(allocateEnv(lookup, 'cursor-erp', { host: 'home-mac' })).toBe(
      'cursor-erp',
    );
  });

  it('distinguishes a label already owned by another machine', () => {
    const { lookup, rows } = registry({ 'cursor-erp': 'office-pc' });
    const env = allocateEnv(lookup, 'cursor-erp', { host: 'home-mac' });
    expect(env).toBe('cursor-erp-home-mac');
    // The other machine keeps its own identity instead of being overwritten.
    expect(rows.get('cursor-erp')?.host).toBe('office-pc');
  });

  it('distinguishes clones that share a hostname', () => {
    const { lookup } = fingerprintedRegistry({
      'cursor-erp': { host: 'lq', machineId: 'a' },
    });
    expect(
      allocateEnv(lookup, 'cursor-erp', { host: 'lq', machineId: 'b' }),
    ).toBe('cursor-erp-lq');
  });

  it('lets a renamed machine keep the label it owns', () => {
    const { lookup } = fingerprintedRegistry({
      'cursor-erp': { host: 'old-name', machineId: 'a' },
    });
    expect(
      allocateEnv(lookup, 'cursor-erp', { host: 'new-name', machineId: 'a' }),
    ).toBe('cursor-erp');
  });

  it('falls back to a numeric label when the host label is taken too', () => {
    const { lookup } = registry({
      'cursor-erp': 'office-pc',
      'cursor-erp-home-mac': 'somewhere-else',
    });
    expect(allocateEnv(lookup, 'cursor-erp', { host: 'home-mac' })).toBe(
      'cursor-erp-2',
    );
  });

  it('never renames a row that predates host reporting', () => {
    const { lookup } = registry({ 'cursor-erp': undefined });
    expect(allocateEnv(lookup, 'cursor-erp', { host: 'home-mac' })).toBe(
      'cursor-erp',
    );
  });

  it('keeps today behaviour for a client that reports no host', () => {
    const { lookup } = registry({ 'cursor-erp': 'office-pc' });
    expect(allocateEnv(lookup, 'cursor-erp', {})).toBe('cursor-erp');
  });

  it('mints a fresh identity per enrollment code on one machine', () => {
    const { lookup } = registry({ 'company-windows': 'lq' });
    expect(
      allocateEnv(lookup, 'company-windows', { host: 'lq' }, { reuseOwned: false }),
    ).toBe('company-windows-2');
  });

  it('stays inside the protocol limit when the label leaves no room', () => {
    const base = `cursor-${'y'.repeat(80)}`;
    const taken = base.slice(0, 64);
    const { lookup } = registry({ [taken]: 'office-pc' });
    const env = allocateEnv(lookup, base, { host: 'home-mac' });

    // A 64-char label cannot also carry a host or a counter, so the allocator
    // has to fall back to something that is still not the other machine's env.
    expect(env.length).toBeLessThanOrEqual(64);
    expect(env).not.toBe(taken);
  });
});
