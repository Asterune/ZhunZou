import type { AgentTask, Device, SupervisorInboxItem } from '@zhunzou/shared';
import { wipBranchName } from '@zhunzou/shared';

/**
 * Pure views over the supervisor inbox read-model.
 *
 * The server already orders and truncates these items; the panel still sorts
 * locally because the list arrives on its own request, not inside the sync
 * snapshot, so a fresh page can briefly hold rows in the order they were read.
 */

export function sortInbox(items: SupervisorInboxItem[]): SupervisorInboxItem[] {
  return [...items].sort(
    (left, right) =>
      statusRank(left.task) - statusRank(right.task) ||
      right.task.updatedAt - left.task.updatedAt ||
      Number(right.task.id) - Number(left.task.id),
  );
}

/** Blocked work waits for a person; finished work only waits for a glance. */
function statusRank(task: AgentTask): number {
  return task.status === 'BLOCKED' ? 0 : 1;
}

export function blockedCount(items: SupervisorInboxItem[]): number {
  return items.filter((item) => item.task.status === 'BLOCKED').length;
}

export interface MergeInfo {
  branch: string;
  path: string;
}

/**
 * What a person needs to finish the job by hand. The hub never runs git: the
 * node owns the checkout, so this is information, not an action.
 */
export function mergeInfoFor(item: SupervisorInboxItem): MergeInfo | undefined {
  const path = item.task.workspacePath;
  if (!path) return undefined;
  return { branch: item.branch ?? wipBranchName(item.task.id), path };
}

/** The machine a task ran on, read the way the agents panel reads it. */
export function deviceForTask(
  task: AgentTask,
  devices: Device[],
): Device | undefined {
  return devices.find((device) => device.envs.includes(task.env));
}
