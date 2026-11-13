import {
  NODE_HEARTBEAT_TIMEOUT_MS,
  ROUTE_MIN_FREE_MEMORY_MB,
  nodeFreeMemoryMB,
  type Agent,
  type Device,
  type NodeRepo,
  type NodeRole,
  type TaskEngine,
} from '@zhunzou/shared';

/**
 * Placement: which agent identity should take this task.
 *
 * The hub cannot see a machine's filesystem, so everything here comes from
 * what the node last reported. A fact the node never sent is treated as weak
 * evidence (rank it last), never as permission to ignore the rule — except for
 * the checkout, where absence means the task would fail on the first command.
 */

/** One dispatch target: an agent identity plus the machine facts behind it. */
export interface RouteCandidate {
  env: string;
  role: NodeRole;
  /** Engine CLIs this identity actually runs. */
  engines: TaskEngine[];
  tags: string[];
  repos: NodeRepo[];
  maxConcurrency: number;
  /** Work already assigned to this env and not finished yet. */
  activeCount: number;
  freeMemoryMB?: number;
  lastSeenAt?: number;
}

/** What the caller asks for. */
export interface RouteRequirement {
  repoName?: string;
  engine?: TaskEngine;
  tags?: string[];
}

export type RouteRejection =
  | 'PORTAL'
  | 'OFFLINE'
  | 'ENGINE'
  | 'TAGS'
  | 'REPO'
  | 'MEMORY'
  | 'CAPACITY';

export interface RouteAssessment {
  env: string;
  /** Higher is better; absent when the node was rejected. */
  score?: number;
  rejection?: RouteRejection;
}

export interface RouteDecision {
  env: string | null;
  /** Short, human-readable summary; also the API's error message. */
  reason: string;
  assessed: RouteAssessment[];
}

/** Bonus for the one thing no other node can substitute. */
const REPO_MATCH_BONUS = 1_000;
/** Bonus for a machine with nothing running, and the penalty per active task. */
const IDLE_BONUS = 240;
const LOAD_PENALTY = 120;
/** A node's own memory reading, in MB, is worth this much per 32 MB. */
const MEMORY_DIVISOR = 32;
const MEMORY_BONUS_CAP = 256;
/** Reported within the last second gets the full bonus, gone stale at 60s. */
const FRESHNESS_BONUS = 60;

function rejection(
  candidate: RouteCandidate,
  requirement: RouteRequirement,
  now: number,
): RouteRejection | undefined {
  if (candidate.role === 'portal') return 'PORTAL';

  if (
    candidate.lastSeenAt === undefined ||
    now - candidate.lastSeenAt > NODE_HEARTBEAT_TIMEOUT_MS
  ) {
    return 'OFFLINE';
  }

  if (requirement.engine && !candidate.engines.includes(requirement.engine)) return 'ENGINE';

  if (requirement.tags?.length) {
    const missing = requirement.tags.some((tag) => !candidate.tags.includes(tag));
    if (missing) return 'TAGS';
  }

  // A beat that never carried a memory figure is a legacy bridge, not a box
  // that ran out of RAM, so the floor only applies to what was measured.
  if (
    candidate.freeMemoryMB !== undefined &&
    candidate.freeMemoryMB <= ROUTE_MIN_FREE_MEMORY_MB
  ) {
    return 'MEMORY';
  }

  if (candidate.activeCount >= candidate.maxConcurrency) return 'CAPACITY';

  // The checkout is the one thing a remote agent cannot create on demand.
  if (requirement.repoName) {
    const hasRepo = candidate.repos.some(
      (repo) => repo.name === requirement.repoName && repo.ready !== false,
    );
    if (!hasRepo) return 'REPO';
  }

  return undefined;
}

function score(
  candidate: RouteCandidate,
  requirement: RouteRequirement,
  now: number,
): number {
  let value = 0;

  if (requirement.repoName) value += REPO_MATCH_BONUS;
  value += candidate.activeCount === 0 ? IDLE_BONUS : -LOAD_PENALTY * candidate.activeCount;

  if (candidate.freeMemoryMB !== undefined) {
    value += Math.min(MEMORY_BONUS_CAP, Math.floor(candidate.freeMemoryMB / MEMORY_DIVISOR));
  }

  const ageMs = Math.max(0, now - (candidate.lastSeenAt ?? now));
  value += Math.max(0, FRESHNESS_BONUS - Math.floor(ageMs / 1_000));

  return value;
}

/** Rank the machines that may take this work, best first, with the reasons. */
export function routeTask(
  candidates: RouteCandidate[],
  requirement: RouteRequirement = {},
  now = Date.now(),
): RouteDecision {
  const assessed = candidates
    .map((candidate) => {
      const dropped = rejection(candidate, requirement, now);
      return dropped
        ? { env: candidate.env, rejection: dropped }
        : { env: candidate.env, score: score(candidate, requirement, now) };
    })
    .sort((a, b) => {
      const byScore = (b.score ?? Number.NEGATIVE_INFINITY) -
        (a.score ?? Number.NEGATIVE_INFINITY);
      // Same score is decided by name, or a restart would reshuffle the fleet.
      return byScore !== 0 ? byScore : a.env.localeCompare(b.env);
    });

  const winner = assessed.find((item) => item.score !== undefined);

  if (!winner) {
    return { env: null, reason: explain(candidates.length, assessed), assessed };
  }

  const eligible = assessed.filter((item) => item.score !== undefined).length;
  return {
    env: winner.env,
    reason:
      eligible === 1
        ? `only ${winner.env} fits`
        : `${winner.env} scored best of ${eligible} eligible nodes`,
    assessed,
  };
}

function explain(total: number, assessed: RouteAssessment[]): string {
  if (total === 0) return 'no nodes are registered with this hub';

  const counts = new Map<RouteRejection, number>();
  for (const item of assessed) {
    if (!item.rejection) continue;
    counts.set(item.rejection, (counts.get(item.rejection) ?? 0) + 1);
  }

  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => `${count} ${REJECTION_TEXT[code]}`);

  return `no node fits: ${parts.join(', ')}`;
}

const REJECTION_TEXT: Record<RouteRejection, string> = {
  PORTAL: 'portal-only',
  OFFLINE: 'offline',
  ENGINE: 'missing the engine',
  TAGS: 'missing the tags',
  REPO: 'without the checkout',
  MEMORY: 'short on memory',
  CAPACITY: 'at capacity',
};

/**
 * Turn the hub's two registries into routing facts: the agent is what a task is
 * dispatched to, the device card is what decides whether it should be.
 */
export function toRouteCandidates(
  agents: Agent[],
  devices: Device[],
  activeCounts: Record<string, number>,
): RouteCandidate[] {
  return agents.map((agent) => {
    const device =
      (agent.deviceId ? devices.find((item) => item.id === agent.deviceId) : undefined) ??
      devices.find((item) => item.envs.includes(agent.env));
    const profile = device?.profile;

    return {
      env: agent.env,
      role: profile?.role ?? 'worker',
      engines: [agent.kind],
      tags: profile?.tags ?? [],
      repos: profile?.repos ?? [],
      maxConcurrency: profile?.maxConcurrency ?? 1,
      activeCount: activeCounts[agent.env] ?? 0,
      // A heartbeat snapshot can be newer than the stored profile figure.
      freeMemoryMB: nodeFreeMemoryMB(
        { freeMemoryMB: profile?.freeMemoryMB },
        agent.deviceStats ?? undefined,
      ),
      lastSeenAt: agent.lastSeenAt,
    };
  });
}
