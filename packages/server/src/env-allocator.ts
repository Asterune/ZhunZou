import { randomBytes } from 'node:crypto';

/** Cap an env label the same way every client does. */
const ENV_MAX_LENGTH = 64;

/**
 * Resolves who owns an env label today. `host` is absent when the row predates
 * device reporting, or when the caller looks in a namespace without hosts.
 */
export type EnvOwnerLookup = (env: string) => { host?: string | null } | null;

export interface AllocateOptions {
  /**
   * Keep the base label when this very machine already owns it, so re-running a
   * registration is idempotent. Enrollment passes false: two codes bound to the
   * same label are two identities the admin meant to create. Defaults to true.
   */
  reuseOwned?: boolean;
}

/** Host names are case-insensitive in practice, and FQDNs differ per machine. */
function normalizeHost(host: string | undefined | null): string {
  return (host ?? '').trim().toLowerCase().replace(/\.local$/, '');
}

/**
 * True when a reported host may rewrite the machine metadata of an env.
 *
 * A heartbeat cannot be re-labelled by the hub — the client keeps sending the
 * env it chose — so an env already owned by a different machine must not have
 * its host/os/capabilities taken over by the newcomer. An unknown host on
 * either side claims nothing, which keeps pre-existing deployments unchanged.
 */
export function hostsMatch(
  owner: string | undefined | null,
  incoming: string | undefined | null,
): boolean {
  const stored = normalizeHost(owner);
  const reported = normalizeHost(incoming);
  if (!stored || !reported) return true;
  return stored === reported;
}

/** `QideMacBook-Pro.local` → `qide-macbook-pro`; empty when unreportable. */
export function hostSlug(host: string | undefined | null): string {
  return (host ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/\.(local|lan|internal)$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

function take(candidate: string): string {
  return candidate.slice(0, ENV_MAX_LENGTH);
}

/**
 * Pick the env label a registration should use.
 *
 * Two machines that opened repositories with the same basename derive the
 * identical label, and `agents.env` is the primary key, so the second one
 * silently overwrites the first machine's identity and steals its traffic. When
 * a contested label belongs to a *different* host it gains a host component
 * instead of a `-2` suffix, which keeps both machines addressable.
 *
 * A caller or owner that reports no host counts as the same machine, so
 * pre-existing deployments keep the labels they already use.
 */
export function allocateEnv(
  lookup: EnvOwnerLookup,
  base: string,
  host: string | undefined | null,
  options: AllocateOptions = {},
): string {
  const wanted = take(base);
  const owner = lookup(wanted);
  if (!owner) return wanted;

  const mine = normalizeHost(host);
  const theirs = normalizeHost(owner.host);
  const unattributed = !mine || !theirs;

  if (unattributed || mine === theirs) {
    if (options.reuseOwned !== false || unattributed) return wanted;
  } else {
    const suffix = hostSlug(host);
    const hosted = take(`${wanted}-${suffix}`);
    if (suffix && !lookup(hosted)) return hosted;
  }

  for (let index = 2; index < 100; index += 1) {
    const attempt = take(`${wanted}-${index}`);
    if (!lookup(attempt)) return attempt;
  }
  return take(`${wanted.slice(0, 55)}-${randomBytes(3).toString('hex')}`);
}
