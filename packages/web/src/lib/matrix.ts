import type { Agent, AgentTask, Device, NodeRole } from '@zhunzou/shared';
import { nodeFreeMemoryMB } from '@zhunzou/shared';

import { isActiveTask } from './format';

/**
 * The machine matrix: one card per box the hub has seen.
 *
 * Grouping follows the agents panel exactly — devices first, then any agent the
 * hub cannot attribute to a device, bucketed by hostname — because two machines
 * can legitimately report one hostname (an image clone does), and the card that
 * pretends otherwise is worse than the card that shows the device id.
 */

export interface NodeCard {
  host: string;
  os?: string;
  version?: string;
  total: number;
  online: number;
  disabled: number;
  lastSeenAt?: number;
  role: NodeRole;
  tags: string[];
  repoCount: number;
  /** Absent when no node reported one: an unknown ceiling is not ceiling 1. */
  maxConcurrency?: number;
  freeMemoryMB?: number;
  /** 0..1; undefined when either figure is missing, so no bar is drawn. */
  memoryRatio?: number;
  /** Work the scheduler still counts against this machine. */
  activeCount: number;
  /** Work that ran in its own worktree, as the edge reported it. */
  isolatedCount: number;
}

export interface MatrixOptions {
  /** Label for a machine that never reported a hostname. */
  unknownHost?: string;
}

export function buildNodeMatrix(
  devices: Device[],
  agents: Agent[],
  tasks: AgentTask[],
  options: MatrixOptions = {},
): NodeCard[] {
  const unknownHost = options.unknownHost || 'unknown';
  const groups = new Map<string, NodeCard>();
  /** Which card each env belongs to, so tasks can be tallied per machine. */
  const cardOfEnv = new Map<string, string>();

  const tally = (node: NodeCard, agent: Agent, key: string): void => {
    node.total += 1;
    if (agent.online) node.online += 1;
    if (agent.status === 'disabled') node.disabled += 1;
    if (!node.os && agent.os) node.os = agent.os;
    if (!node.version && agent.version) node.version = agent.version;
    if (
      agent.lastSeenAt &&
      (!node.lastSeenAt || agent.lastSeenAt > node.lastSeenAt)
    ) {
      node.lastSeenAt = agent.lastSeenAt;
    }
    cardOfEnv.set(agent.env, key);
  };

  // Two machines can legitimately report one hostname — an image clone does.
  const duplicates = new Map<string, number>();
  for (const device of devices) {
    const label = device.host?.trim() || unknownHost;
    duplicates.set(label, (duplicates.get(label) ?? 0) + 1);
  }

  for (const device of devices) {
    const label = device.host?.trim() || unknownHost;
    const freeMemoryMB = nodeFreeMemoryMB(
      { freeMemoryMB: device.profile?.freeMemoryMB },
      device.deviceStats,
    );
    const node: NodeCard = {
      host:
        (duplicates.get(label) ?? 0) > 1 && !device.id.startsWith('host:')
          ? `${label} · ${device.id.slice(0, 8)}`
          : label,
      os: device.os,
      total: 0,
      online: 0,
      disabled: 0,
      activeCount: 0,
      isolatedCount: 0,
      lastSeenAt: device.lastSeenAt,
      role: device.profile?.role ?? 'worker',
      tags: [...(device.profile?.tags ?? [])],
      repoCount: device.profile?.repos.length ?? 0,
      ...(device.profile?.maxConcurrency
        ? { maxConcurrency: device.profile.maxConcurrency }
        : {}),
      ...(freeMemoryMB === undefined ? {} : { freeMemoryMB }),
      ...memoryRatioFor(device, freeMemoryMB),
    };
    for (const agent of agents) {
      if (agent.deviceId === device.id) tally(node, agent, device.id);
    }
    groups.set(device.id, node);
  }

  for (const agent of agents) {
    if (agent.deviceId && groups.has(agent.deviceId)) continue;
    const host = agent.host?.trim() || unknownHost;
    const key = `ungrouped:${host}`;
    const node =
      groups.get(key) ??
      {
        host,
        total: 0,
        online: 0,
        disabled: 0,
        role: 'worker' as NodeRole,
        tags: [] as string[],
        repoCount: 0,
        activeCount: 0,
        isolatedCount: 0,
      };
    tally(node, agent, key);
    groups.set(key, node);
  }

  for (const task of tasks) {
    const key = cardOfEnv.get(task.env);
    if (!key) continue;
    const node = groups.get(key);
    if (!node) continue;
    if (isActiveTask(task)) node.activeCount += 1;
    if (task.workspacePath) node.isolatedCount += 1;
  }

  return [...groups.values()].sort(
    (left, right) =>
      right.online - left.online ||
      right.total - left.total ||
      left.host.localeCompare(right.host),
  );
}

function memoryRatioFor(
  device: Device,
  freeMemoryMB: number | undefined,
): { memoryRatio?: number } {
  const totalMB = device.deviceStats?.totalMemBytes
    ? device.deviceStats.totalMemBytes / 1024 / 1024
    : undefined;
  if (!totalMB || freeMemoryMB === undefined) return {};
  return { memoryRatio: Math.min(1, Math.max(0, freeMemoryMB / totalMB)) };
}
