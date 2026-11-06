import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Identity of the running build. `healthz` reports it so an operator (or an
 * agent that just deployed) can see which release is live and when it started,
 * instead of guessing from a restart.
 */
function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', 'package.json'), join(here, 'package.json')]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
        version?: unknown;
      };
      if (typeof parsed.version === 'string' && parsed.version) return parsed.version;
    } catch {
      // Bundled or exotic layout: fall through to the next candidate.
    }
  }
  return '0.0.0-unknown';
}

export const SERVER_VERSION: string = readPackageVersion();

/** Process start; moves on every deploy, so `uptime` is meaningful. */
export const STARTED_AT = Date.now();
