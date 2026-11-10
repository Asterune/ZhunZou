import type { Root } from '@modelcontextprotocol/sdk/types.js';

import { detectWorkspaceProject } from './config.js';
import type { PresenceReporter } from './presence.js';
import { fileUriToPath } from './workspaces.js';

/**
 * Adopt the project from the workspaces the client advertises over MCP.
 *
 * Editors do not agree on how an MCP server learns which folder is open:
 * Cursor starts the process in a directory it does not let us choose, and on
 * Windows that is usually not the workspace. `roots/list` is the protocol's
 * answer to that question, so when the cwd and the client's environment both
 * come up empty, ask the client directly.
 *
 * The answer is only used when it is unambiguous — a multi-root workspace
 * would make every ticket belong to whichever folder happened to be first.
 */

export type RootLister = () => Promise<{ roots: Root[] }>;

/** Project name implied by the client's roots, or undefined when unclear. */
export function projectFromRoots(
  roots: readonly Pick<Root, 'uri'>[],
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const names = new Set<string>();
  for (const root of roots) {
    const path = fileUriToPath(root.uri, platform);
    if (!path) continue;
    const name = detectWorkspaceProject(path);
    if (name) names.add(name);
  }
  return names.size === 1 ? [...names][0] : undefined;
}

export interface AdoptProjectOptions {
  listRoots: RootLister;
  presence: Pick<PresenceReporter, 'beat'>;
  log?: (message: string) => void;
  platform?: NodeJS.Platform;
}

/**
 * Ask the client for its roots and report the project on the next heartbeat.
 *
 * Failures are logged and swallowed: Cursor advertises the roots capability
 * but has shipped versions where `roots/list` answers "method not found", and
 * an unknown project is a missing label, not a reason to break the session.
 */
export async function adoptProjectFromRoots(
  options: AdoptProjectOptions,
): Promise<string | undefined> {
  const log = options.log ?? (() => undefined);
  let roots: Root[];
  try {
    const result = await options.listRoots();
    roots = result.roots ?? [];
  } catch (error) {
    log(
      `client roots unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }

  const project = projectFromRoots(roots, options.platform);
  if (!project) return undefined;

  try {
    await options.presence.beat({ projectName: project });
  } catch (error) {
    log(
      `heartbeat after adopting ${project} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
  log(`project ${project} adopted from the client workspace`);
  return project;
}
