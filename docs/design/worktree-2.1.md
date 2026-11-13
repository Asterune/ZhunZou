# Step 2.1 设计：Git Worktree 隔离生命周期

蓝图原文（`~/Desktop/zhunzou_ai.md` §Phase 2 / Step 2.1）要求三个方法：
`createWorktree(taskId, repoPath, targetBranch)` → `.zhunzou/wt/<taskId>` + `wip/zz-<taskId>`；
`createCheckpoint(taskId, label)` → `git stash create` 快照 hash；
`squashAndRebase(taskId, mainBranch, commitMessage)` → 多次 AI 提交压成一条干净提交并变基到主干。
本文件确定落地位置、语义边界与测试矩阵，然后才写代码。

## 1. 现状核实

- 任务在 **bridge** 的 wake 守护进程里执行：`runClaimLoop` 领取任务后用
  `adapter.wake(task, ctx)` 起子进程，cwd 恒等于 `WakeConfig.cwd`
  （[packages/bridge/src/wake/daemon.ts:117](file:///Users/qiliu/agent-hub/packages/bridge/src/wake/daemon.ts) 起，
  [packages/bridge/src/wake/adapters.ts:285](file:///Users/qiliu/agent-hub/packages/bridge/src/wake/adapters.ts) 用），
  没有任何 worktree/分支概念；`ZHUNZOU_WORKDIR` 只是把这个固定 cwd 透传给命令适配器。
- `device` 包只有 PTY 终端与画像上报，不碰仓库；`server` 端 `agent_tasks` 没有工作区列。
- bridge 已有子进程封装 `runProcess(command, args, {cwd, timeoutMs})`，无 git 依赖，
  也没有任何真实 git 测试先例（现有测试一律注入 fake）。

## 2. 落点：`packages/bridge/src/git/worktree.ts`

蓝图把这个模块画在 `packages/cli-node/src/git`，但本仓库没有 cli-node；执行任务的是
bridge 的 wake 循环，所以模块放在真正会调用它的包里，避免再造一个没人用的平行入口。
目录名保留蓝图的 `git/`。

## 3. 路径与命名（不可信任输入）

| 项 | 规则 |
|---|---|
| `taskId` | `^[A-Za-z0-9._-]{1,64}$` 且不是 `.`/`..`；否则直接抛错 |
| worktree 目录 | `join(toplevel, '.zhunzou', 'wt', taskId)`，`toplevel` 由 `git rev-parse --show-toplevel` 得到 |
| 分支名 | `wip/zz-<taskId>`（`git check-ref-format` 由 git 自己校验，失败原样上抛） |
| 调用方式 | 只允许 `spawn('git', [...args])` 数组 argv，永不 `shell:true`——commitMessage/label 都是任意文本 |

`repoPath` 允许传仓库内任意子目录；由 git 自己折算到 top-level，Hub 与调用方都不做路径推导
（`docs/design/scheduler-1.3.md` §6 的约定：`repos[].path` 与 `workspacePath` 只有边缘知道）。

worktree 建在仓库内部，主检出 `git status` 就会多出 `?? .zhunzou/`；`git worktree add` 并不会
自己忽略它。所以 `createWorktree` 首次创建前把 `/.zhunzou/` 追加进 `.git/info/exclude`
（本机生效、不会被提交），否则主检出里的 `git add -A` 会把别的任务的工作区一起暂存。
写失败不影响隔离，静默跳过。

## 4. 三个方法的语义边界

### createWorktree(taskId, repoPath, targetBranch?)

幂等：重试/自愈再进同一个任务不能失败在"目录已存在"。

1. `git -C repoPath rev-parse --show-toplevel` → 仓库根；
2. 目录已存在 → 直接返回 `{workspacePath, branch, created: false}`；
3. `wip/zz-<taskId>` 已存在 → `git worktree add <path> <branch>`（不带 `-b`）；
4. 否则 `git worktree add -b <branch> <path> <targetBranch ?? HEAD>`。

`targetBranch` 缺省用当前 HEAD：任务没写分支就不该猜一个 `main`。

### createCheckpoint(taskId, label)

蓝图写的是 `git stash create`。真实 git 测试直接否掉了这条路：`stash create` **看不见未跟踪文件**
（`-u`/`--include-untracked` 在 Apple Git 2.37 上被静默忽略，只有新文件的工作树返回空 hash），
而 agent 的产出恰恰大多是新文件——快照会什么都没存下来，还不报错。

改为：`git add -A --` + `git commit -m "zhunzou:<taskId> checkpoint: <label>"` 落在
`wip/zz-<taskId>` 这条一次性分支上，返回 `{hash, label}`（hash 是新提交的 commit）。

- 未跟踪文件一并进快照，对象因为被分支 ref 引用而天然可达，不需要 `stash store`；
- 不破坏现场：不 reset、不清工作树，回滚用 `git checkout <hash> -- .` 或 `reset --soft HEAD~1`；
- 工作树没有任何改动 → 返回 `undefined`（"没什么可存"，不是错误）；
- 与 §4 squash 的关系：checkpoint 提交之后工作树变干净，squash 才有资格动手——
  这正是 `WORKTREE_DIRTY` 报"先做 checkpoint 再合并"的意思。压扁发布时这些 checkpoint 提交
  会被 `reset --soft` 归并成一条，人工审批看的是最终 diff，不是 WIP 历史。

### squashAndRebase(taskId, mainBranch, commitMessage)

目标：`wip/zz-<taskId>` 上多次 AI 提交 → 主干最新提交之上的一条干净提交。

1. 工作树脏 → 抛 `WORKTREE_DIRTY`，要求先 `createCheckpoint`。**不替用户 `git add -A`**：
   把未知文件静默提交进主干历史，比报错严重得多。
2. `base = git merge-base <mainBranch> HEAD`；
3. `git reset --soft <base>` + `git commit -m <commitMessage>` → 一条提交；
4. `git rebase --onto <mainBranch> <base>` → 挪到主干尖端；
5. 任一步失败：`git rebase --abort` + `git reset --hard <原 HEAD>` 还原，再抛错。

**本步不动 `mainBranch` 本身**：把 WIP 合并/快进进主干是"发布"动作，蓝图自己把它留给
Phase 4 的 `[一键 Squash 变基合并]` 审批按钮（§Phase 4）。库默认改共享分支，等于把不可逆
操作藏在一次调用里；调用方之后要合并，只需对返回的 commit 做一次 `merge --ff-only`。

返回值：`{branch, commit, base, mainBranch, workspacePath}`。

## 5. 谁调用：wake 循环按开关隔离

`ZHUNZOU_WORKTREES=1`（`WakeConfig.worktrees`）默认关闭，行为与今天完全一致；开启时：

- 任务带 `repoName` 且当前 `wake.cwd` 所在仓库的顶层目录名与之相符 → 建 worktree，
  `adapter.wake` 的 cwd 换成 worktree 路径；
- 任务没带 `repoName` → 直接在 `wake.cwd` 的仓库里隔离（老部署的自然用法）；
- 对不上（比如 cwd 是另一个仓库）→ 记一条日志、照旧在原目录执行，不静默猜路径；
- 完成回报带上边缘算出的绝对 `workspacePath`，Hub 原样记录。

## 6. Hub 侧只多一列

`agent_tasks.workspace_path`（可空，`ensureColumn` 升级）+ `completeTaskSchema.workspacePath`
（≤1024，绝对路径字符串）。§6 of 设计 1.3 说过：不落相对路径、不建 Hub 侧推导。
`task_workspaces` 注册表（一台机器多个历史 worktree）留到有查询需求时（Phase 4 设备矩阵），
本步不建表。

## 7. 测试矩阵

`packages/bridge/test/git-worktree.test.ts`（fake runner，断 argv 序列与状态机）
- create：toplevel 折算、目录新建 `-b`、分支已存在时不带 `-b`、目录已存在直接复用不再调 git
- 非法 taskId（`../x`、空、超长）在任何 git 调用之前拒绝
- checkpoint：有改动 → `add -A --` → `commit -mzhunzou:<id> checkpoint: <label>` → `rev-parse HEAD`；
  干净树只到 `status` 就返回 undefined；无 label 时兜底 `checkpoint`
- 首次创建 worktree 才写 `.git/info/exclude`，第二次调用不重复追加
- squash：脏树先抛 `WORKTREE_DIRTY` 且没有任何写操作；干净树 argv 顺序 =
  `status --porcelain` → `merge-base` → `reset --soft` → `commit` → `rebase --onto`
- rebase 失败 → 依次 `rebase --abort` 与 `reset --hard <原 HEAD>`，错误上抛

`packages/bridge/test/git-worktree-repo.test.ts`（真实 git，`whichSync('git')` 缺失时整文件 skip）
- 建 worktree 后目录存在、分支是 `wip/zz-<id>`、在主仓库 `git worktree list` 里可见
- 在 worktree 里只留一个未跟踪新文件 → checkpoint 拿到 hash、工作树转干净、主检出仍干净
- checkpoint 提交被丢弃后，`git checkout <hash> -- .` 能把那个新文件取回来
- `.git/info/exclude` 里出现 `/.zhunzou/`，主检出 `git status --porcelain` 为空
- worktree 里两次提交 → squash 后主干不变、WIP 分支变成一条提交且父提交是主干尖端

`packages/bridge/test/wake-worktrees.test.ts`
- 默认关闭时 `adapter.wake` 的 cwd 仍是 `wake.cwd`（回归保护）；注入 isolation 也不能绕过开关
- 开启时 cwd 变成 `.zhunzou/wt/<id>`，`completeTask` 带上该绝对路径
- `repoName` 对不上 → 不隔离、原样执行、日志说明原因
- 建 worktree 抛错 → 原样执行、任务照样 DONE
- 不注入时由 daemon 自己造的 `WorktreeManager` 对着真实仓库建出 worktree（打通最后一层）

`packages/server/test/task-workspace.test.ts`
- `completeTask` 落 `workspace_path` 并能从 `/api/tasks/:id` 读回；不传则保持 NULL
- 旧库（无该列）升级后仍可完成带 workspacePath 的任务
