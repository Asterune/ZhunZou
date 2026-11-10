import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  adoptProjectFromRoots,
  projectFromRoots,
} from '../src/project-roots.js';

function workspace(name: string, git = true): string {
  const root = mkdtempSync(join(tmpdir(), 'zhunzou-roots-'));
  const dir = join(root, name);
  mkdirSync(git ? join(dir, '.git') : dir, { recursive: true });
  return dir;
}

describe('project from client roots', () => {
  it('uses the git root of the single advertised workspace', () => {
    const dir = workspace('erp-console');
    const nested = join(dir, 'apps', 'web');
    mkdirSync(nested, { recursive: true });

    expect(
      projectFromRoots([{ uri: pathToFileURL(nested).href }]),
    ).toBe('erp-console');
  });

  it('stays silent when a multi-root workspace is ambiguous', () => {
    const first = workspace('billing');
    const second = workspace('reports');

    expect(
      projectFromRoots([
        { uri: pathToFileURL(first).href },
        { uri: pathToFileURL(second).href },
      ]),
    ).toBeUndefined();
  });

  it('ignores roots that are not local folders', () => {
    expect(
      projectFromRoots([
        { uri: 'untitled:Untitled-1' },
        { uri: 'https://example.com/repo' },
      ]),
    ).toBeUndefined();
  });
});

describe('adopting the client workspace', () => {
  it('reports the project on the next heartbeat', async () => {
    const dir = workspace('agent-hub');
    const beat = vi.fn(async () => ({}) as never);
    const log = vi.fn();

    const project = await adoptProjectFromRoots({
      listRoots: async () => ({ roots: [{ uri: pathToFileURL(dir).href }] }),
      presence: { beat },
      log,
    });

    expect(project).toBe('agent-hub');
    expect(beat).toHaveBeenCalledWith({ projectName: 'agent-hub' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('agent-hub'));
  });

  it('survives a client that advertises roots but does not answer', async () => {
    const beat = vi.fn(async () => ({}) as never);
    const log = vi.fn();

    await expect(
      adoptProjectFromRoots({
        // Cursor has shipped builds that answer "method not found" here.
        listRoots: async () => {
          throw new Error('Method not found');
        },
        presence: { beat },
        log,
      }),
    ).resolves.toBeUndefined();
    expect(beat).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Method not found'));
  });
});
