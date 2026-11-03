import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DecisionTicket } from '@zhunzou/shared';
import type { FastifyInstance } from 'fastify';

import { REPO_ROOT, type ServerConfig } from './config.js';

export interface PluginLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface PluginContext {
  config: ServerConfig;
  logger: PluginLogger;
  version: string;
}

export type PluginHook =
  | 'onTicketCreated'
  | 'onTicketPendingHuman'
  | 'onTicketResolved'
  | 'onTicketCancelled';

export interface HubPlugin {
  name: string;
  /** Called once after HTTP routes and static hosting are ready. */
  onReady?: (app: FastifyInstance) => void | Promise<void>;
  /** Called right after a ticket is persisted (status PENDING_META). */
  onTicketCreated?: (ticket: DecisionTicket) => void | Promise<void>;
  /** Called when a ticket is escalated to a human (including review errors). */
  onTicketPendingHuman?: (ticket: DecisionTicket) => void | Promise<void>;
  /** Called for AUTO_RESOLVED / HUMAN_RESOLVED. */
  onTicketResolved?: (ticket: DecisionTicket) => void | Promise<void>;
  /** Called for CANCELLED. */
  onTicketCancelled?: (ticket: DecisionTicket) => void | Promise<void>;
  /** Called during graceful shutdown. */
  onClose?: () => void | Promise<void>;
}

export type HubPluginFactory = (context: PluginContext) => HubPlugin | Promise<HubPlugin>;

interface PluginModule {
  default?: HubPlugin | HubPluginFactory;
  createPlugin?: HubPluginFactory;
  plugin?: HubPlugin;
}

function isPlugin(value: unknown): value is HubPlugin {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

function resolvePluginPath(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

async function instantiatePlugin(
  path: string,
  context: PluginContext,
): Promise<HubPlugin> {
  const module = (await import(pathToFileURL(resolvePluginPath(path)).href)) as PluginModule;
  const candidate = module.default ?? module.createPlugin ?? module.plugin;

  if (typeof candidate === 'function') {
    const plugin = await candidate(context);
    if (!isPlugin(plugin)) {
      throw new Error(`plugin "${path}" factory did not return a plugin object`);
    }
    return plugin;
  }

  if (isPlugin(candidate)) return candidate;

  throw new Error(
    `plugin "${path}" must export a factory (default/named createPlugin) or a plugin object`,
  );
}

/**
 * Load operator-configured plugin modules. Unlike notification/webhook calls,
 * a broken plugin fails startup: silently running without an explicitly
 * configured integration is harder to debug.
 */
export async function loadPlugins(
  paths: string[],
  context: PluginContext,
): Promise<HubPlugin[]> {
  const plugins: HubPlugin[] = [];
  for (const path of paths) {
    plugins.push(await instantiatePlugin(path, context));
  }
  return plugins;
}

export function emitPluginEvent(
  plugins: HubPlugin[],
  hook: PluginHook,
  ticket: DecisionTicket,
  logger: PluginLogger,
): void {
  for (const plugin of plugins) {
    const handler = plugin[hook];
    if (!handler) continue;

    void Promise.resolve()
      .then(() => handler.call(plugin, ticket))
      .catch((error: unknown) => {
        logger.warn(
          { plugin: plugin.name, hook, err: (error as Error).message },
          'plugin hook failed',
        );
      });
  }
}

export async function readyPlugins(
  plugins: HubPlugin[],
  app: FastifyInstance,
  logger: PluginLogger,
): Promise<void> {
  for (const plugin of plugins) {
    if (!plugin.onReady) continue;
    try {
      await plugin.onReady(app);
    } catch (error) {
      logger.warn(
        { plugin: plugin.name, err: (error as Error).message },
        'plugin onReady failed',
      );
    }
  }
}

export async function closePlugins(
  plugins: HubPlugin[],
  logger: PluginLogger,
): Promise<void> {
  for (const plugin of plugins) {
    if (!plugin.onClose) continue;
    try {
      await plugin.onClose();
    } catch (error) {
      logger.warn(
        { plugin: plugin.name, err: (error as Error).message },
        'plugin onClose failed',
      );
    }
  }
}
