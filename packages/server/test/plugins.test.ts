import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DecisionTicket } from '@zhunzou/shared';

import type { ServerConfig } from '../src/config.js';
import {
  closePlugins,
  emitPluginEvent,
  loadPlugins,
  readyPlugins,
  type HubPlugin,
} from '../src/plugins.js';
import { createTestContext, ticketInput, waitFor } from './helpers.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete (globalThis as { __pluginHits?: string[] }).__pluginHits;
});

function tempPlugin(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'zhunzou-plugin-'));
  dirs.push(dir);
  const path = join(dir, 'plugin.mjs');
  writeFileSync(path, source);
  return path;
}

const ticket: DecisionTicket = {
  id: '1',
  env: 'test',
  projectName: 'demo',
  status: 'PENDING_META',
  doneSummary: 'done',
  blockerQuestion: 'which?',
  nextStepPlan: 'next',
  options: [{ key: 'A', label: 'A' }],
  recommendedOption: 'A',
  createdAt: 1,
  updatedAt: 1,
};

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function context(config = {} as ServerConfig) {
  return { config, logger: logger(), version: 'test' };
}

describe('plugin loader', () => {
  it('accepts a factory module and exposes its hooks', async () => {
    const path = tempPlugin(`
      export default (ctx) => ({
        name: 'factory-plugin',
        onReady(app) { globalThis.__pluginHits.push('ready:' + typeof app.inject) },
        onTicketCreated(ticket) { globalThis.__pluginHits.push('created:' + ticket.id) },
        onClose() { globalThis.__pluginHits.push('close') },
      })
    `);
    (globalThis as { __pluginHits?: string[] }).__pluginHits = [];

    const plugins = await loadPlugins([path], context());
    expect(plugins[0]?.name).toBe('factory-plugin');

    const app = { inject: () => Promise.resolve() };
    await readyPlugins(plugins, app as never, logger());
    emitPluginEvent(plugins, 'onTicketCreated', ticket, logger());
    await new Promise((resolve) => setTimeout(resolve, 5));
    await closePlugins(plugins, logger());

    expect((globalThis as { __pluginHits?: string[] }).__pluginHits).toEqual([
      'ready:function',
      'created:1',
      'close',
    ]);
  });

  it('accepts a plain plugin object', async () => {
    const path = tempPlugin(`export const plugin = { name: 'object-plugin' }`);
    const plugins = await loadPlugins([path], context());
    expect(plugins.map((plugin) => plugin.name)).toEqual(['object-plugin']);
  });

  it('rejects modules without a plugin export', async () => {
    const path = tempPlugin(`export const nope = 1`);
    await expect(loadPlugins([path], context())).rejects.toThrow(/must export/);
  });

  it('logs hook failures instead of crashing the request', async () => {
    const warn = vi.fn();
    const plugin: HubPlugin = {
      name: 'broken',
      onTicketCreated() {
        throw new Error('boom');
      },
    };

    emitPluginEvent([plugin], 'onTicketCreated', ticket, {
      info: vi.fn(),
      warn,
      error: vi.fn(),
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'broken', hook: 'onTicketCreated' }),
      'plugin hook failed',
    );
  });
});

describe('plugin hooks in the HTTP lifecycle', () => {
  it('emits created and resolved events', async () => {
    const hits: string[] = [];
    const ctx = await createTestContext(undefined, [
      {
        name: 'recorder',
        onTicketCreated: (created) => void hits.push(`created:${created.id}`),
        onTicketResolved: (resolved) => void hits.push(`resolved:${resolved.status}`),
      },
    ]);

    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/tickets',
        headers: ctx.auth,
        payload: ticketInput(),
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().ticket.id as string;

      await ctx.app.inject({
        method: 'POST',
        url: `/api/tickets/${id}/resolve`,
        headers: ctx.auth,
        payload: { selectedOption: 'A' },
      });

      await waitFor(() => hits.length >= 2);
      expect(hits).toEqual([`created:${id}`, 'resolved:HUMAN_RESOLVED']);
    } finally {
      await ctx.close();
    }
  });
});
