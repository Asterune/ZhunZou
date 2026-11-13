import type { WorktreeHandle } from '../git/worktree.js';

/**
 * Decide where a claimed task actually runs.
 *
 * Isolation is opt-in and best-effort: a machine that cannot make a worktree
 * still runs the task where it always did, because losing the work is worse
 * than running it un-isolated. The reason is logged either way.
 */

/** The part of WorktreeManager the wake loop depends on, so it can be stubbed. */
export interface WorkspaceIsolation {
  repoNameFor(path: string): Promise<string>;
  createWorktree(taskId: string, repoPath?: string): Promise<WorktreeHandle>;
}

export interface WorkspaceResolution {
  cwd: string;
  /** Set only when the task got its own worktree. */
  workspacePath?: string;
}

export interface ResolveWorkspaceOptions {
  isolation?: WorkspaceIsolation;
  cwd: string;
  taskId: string;
  repoName?: string;
  log: (message: string) => void;
}

export async function resolveWorkspace(
  options: ResolveWorkspaceOptions,
): Promise<WorkspaceResolution> {
  const { isolation, cwd, taskId, log } = options;
  if (!isolation) return { cwd };

  try {
    if (options.repoName) {
      const local = await isolation.repoNameFor(cwd);
      if (local !== options.repoName) {
        log(
          `任务 #${taskId} 属于仓库 ${options.repoName}，本机 ${cwd} 是 ${local}，按原目录执行`,
        );
        return { cwd };
      }
    }

    const handle = await isolation.createWorktree(taskId, cwd);
    log(`任务 #${taskId} 隔离在 ${handle.workspacePath}（分支 ${handle.branch}）`);
    return { cwd: handle.workspacePath, workspacePath: handle.workspacePath };
  } catch (error) {
    const reason = (error as Error).message || '未知错误';
    log(`任务 #${taskId} 未能隔离：${reason}；按原目录执行`);
    return { cwd };
  }
}
