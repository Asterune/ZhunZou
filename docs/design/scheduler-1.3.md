# 1.3 调度器设计（定稿草案）

本文件先于实现写定，随后按此落地。**只新增、不改变现有行为**：
`POST /api/tasks`、`claimNextTask`、`GET /api/devices|/api/agents` 的语义逐字不变，
调度只挂在新端点上。文末"待定问题"里有三条需要确认，实现按当前设计走，
若结论不同只需改 `scheduler.ts` 的规则表。

## 1. 要解决的问题

现在派单必须指定 `env`（`POST /api/tasks`），也就是说由人决定哪台机器干活。
蓝图要求 Hub 自己决定：给定仓库/引擎/标签，挑一台跑得动、看得见、有余量的机器。

## 2. 已核实的现状（代码事实，非推测）

- `TicketRepository.listTasks(query)` 的 `ListTasksQuery` 只有 `env` / `status` / `limit`
  （`packages/shared/src/schemas.ts:480`），**没有** `repoName` 过滤。
  `claimNextTask(env)` 会取该 env 下 `createdAt` 最早的 PENDING，不比较仓库
  （`packages/server/src/repository.ts:2474` 起）。
  → 因此"在 claim 时校验 repo 匹配"必须先给 query/claim 加 repoName 维度，属于行为变更。
- 任务状态只有 `PENDING → CLAIMED → DONE/FAILED/CANCELLED`（`HEALING`/`BLOCKED`
  已加入枚举，但目前没有任何代码写入）。
- 设备在线判定：`toDevice` / `toAgent` 用 `HEARTBEAT_ONLINE_WINDOW_MS = 90_000`
  （`packages/shared/src/constants.ts:200`）。
- 边缘上报的 `profile.repos[].path` 是**节点本机绝对路径**
  （`packages/shared/src/node.ts:16-21`，强制 absolute 校验）。
- worktree 尚不存在：只有 `parseWorkspacesFromLog` 从任务日志里**识别**
  `.claude/worktrees/<name>`（`packages/server/src/repository.ts:254`），
  Hub 侧没有 worktree 注册表，也没有创建/回收能力（那是 Step 2.1）。
- 并发上限目前无处生效：`claimNextTask` 不做任何容量检查。

## 3. 设计原则

1. **不静默改变现有任务语义**。老的 `POST /api/tasks`（指定 env）行为逐字保持不变；
   调度只挂在新的 `/api/tasks/dispatch` 上。
2. **调度是"选择"，不是"改写"**。调度器只回答"这个任务交给哪个 env"，
   其余字段一律原样落库。
3. **Hub 没有本机视角就不做断言**。Hub 不知道节点文件系统，
   因此任何"路径"都必须来自节点上报，不能由 Hub 拼接。

## 4. 数据结构

```ts
// packages/server/src/scheduler.ts（新增）
export interface RouteCandidate {
  env: string;
  role: NodeRole;
  engines: TaskEngine[];        // 该 identity 实际会跑的 CLI
  tags: string[];
  repos: NodeRepo[];            // 节点自报的绝对路径
  maxConcurrency: number;
  activeCount: number;          // 该 env 未完成任务数
  freeMemoryMB?: number;
  lastSeenAt?: number;
}

export interface RouteRequirement {
  repoName?: string;
  engine?: TaskEngine;
  tags?: string[];
}

export interface RouteDecision {
  env: string | null;
  reason: string;               // 同时是 API 的错误文案
  assessed: RouteAssessment[];  // 每台机器为何被排除
}

export interface TaskRecordShape {   // 本步未落库，留给 Step 2.1
  repoPath?: string;        // 节点上报的 checkout 绝对路径
  workspacePath?: string;   // worktree 落地后由边缘回写；Hub 不推导
}
```

`toRouteCandidates(agents, devices, activeCounts)` 把两张表合成候选：
画像缺失时按协议默认值（worker / `[]` / 并发 1）补齐。

## 5. 路由规则

硬过滤（顺序即优先级，全部有代码可验证的依据）：

| 排除原因 | 条件 |
|---|---|
| `PORTAL` | `role === 'portal'`（门户机只看不干） |
| `OFFLINE` | `lastSeenAt` 缺失，或超过 `NODE_HEARTBEAT_TIMEOUT_MS = 30s` |
| `ENGINE` | 指定了引擎但该 identity 的 `kind` 不是它 |
| `TAGS` | 要求的 tag 没全带上 |
| `MEMORY` | 自报 `freeMemoryMB <= 2048`；**从未上报内存的节点不套用此条**（遗留 bridge 只是没测，不是没内存） |
| `CAPACITY` | `activeCount >= maxConcurrency` |
| `REPO` | 指定了 `repoName`，但节点的 `repos` 里没有同名且 `ready !== false` 的 checkout |

`REPO` 取硬过滤而不是加分：节点没有该 checkout 时，任务第一条命令就会失败，
把它派过去比退回 409 更糟。没有上报 `repos` 的遗留节点在带 `repoName` 的
dispatch 下不可路由，但仍可用 `env` 直派。

打分（只在通过硬过滤的候选之间比较）：

```
score = repo 命中 +1000
      + 空闲 +240 / 每个在跑的任务 -120
      + min(256, freeMemoryMB / 32)   // 未上报内存 = 0 分，不淘汰
      + max(0, 60 - 最近心跳秒数)      // 越新鲜越靠前
```
同分按 `env` 字典序，保证 Hub 重启后同一批节点得到同一结论。

## 6. Worktree 路径：本次不做

蓝图希望任务记录 `workspacePath = .zhunzou/wt/<taskId>`。两个前提还没到位：

- 创建 worktree 的能力在 Step 2.1（`bridge/src/git`），Hub 无法单独落盘；
- 根目录该设在哪个 checkout 下，Hub 只能从节点上报的 `repos[].path` 得知。

所以本步**不引入 `workspacePath`**，避免写进 DB 的相对路径被误当成绝对路径
（这正是问题里点出的隐患）。落地方案：

1. Step 2.1 提供 `WorktreeManager.createWorktree(taskId, repoPath)`，
   `repoPath` 由边缘用 `repoName` 在自己的 `repos[]` 里查到的**绝对路径**；
2. 边缘创建成功后，通过 `task.log`/新帧把 `workspacePath`（绝对）报回来，
   Hub 只做记录，不做路径推导；
3. 若要 Hub 侧可查，需先建 `task_workspaces` 注册表（新增表，非改现有列），
   并把 `repos[].path` 与 `taskId` 关联。此项列为 Step 2.1 的前置设计，不进 1.3。

## 7. 状态机：本次不改

现有 `claimNextTask` 的 `PENDING → CLAIMED` 是当前所有 bridge 依赖的取任务路径，
本步不改。蓝图新增的 `HEALING`/`BLOCKED` 保持"只读枚举"：只有 Step 3.x 的
管家才会写入它们，调度器不产出这两种状态。

如果后续要"dispatch 后由 Hub 直接下发到 WS 而不等长轮询"，那属于 device-router
的推送路径（`packages/server/src/realtime/device-router.ts`），与状态机改造解耦，
单独一步做。

## 8. 并发上限

`maxConcurrency` 只在 **dispatch 时**生效（`CAPACITY` 过滤），
不改 `claimNextTask`。理由：claim 是节点主动取任务，
它自己决定并行度；Hub 侧拒绝的是"再往已经满的机器上派"。
这样遗留 bridge（并发默认 1）不会被误伤：它只会因为 `CAPACITY` 少收任务，
而不是收到后取不到。

## 9. 测试矩阵（下一步实现时先写这些）

调度器单测（`test/scheduler.test.ts`）
- repo 命中优先 / 未命中被 `REPO` 排除
- portal 被排除
- `freeMemoryMB === 2048` 被排除，`2049` 通过
- 未上报内存 → 可路由但排在健康节点之后
- `activeCount === maxConcurrency` → `CAPACITY`
- 心跳刚好 30s / 30s+1ms 边界
- tag 全部命中 vs 缺一个
- 引擎过滤
- 同分按 env 字典序
- 全部被排除时 `reason` 汇总各原因计数
- `toRouteCandidates`：画像缺失走默认值；内存取最新心跳

API 测试（`test/nodes-api.test.ts`）
- `GET /api/nodes` 需 admin token
- dispatch 选中持有仓库的节点，任务落库字段与 `POST /api/tasks` 一致
- dispatch 无候选 → 409 + `reason`
- 指定 `env` 时不调度、直派
- 不传 `repoName` 且不传 `env` → 400

回归保护
- 现有 `POST /api/tasks` 全部测试逐字不变且继续通过
- `GET /api/devices`、`GET /api/agents` 响应结构不因调度器改动

## 10. 待定问题（实施前需确认）

1. 遗留 bridge（从未上报 profile）是否允许参与 `repoName` 路由？
   当前设计：不允许（`REPO` 过滤），但允许 `env` 直派。
2. `HEALING`/`BLOCKED` 是否占用 `maxConcurrency`？
   当前设计：`HEALING` 占用（进程仍在），`BLOCKED` 不占用（等人期间应放行别的活）。
3. 同机多引擎（一台机器 4 个 identity）时，`maxConcurrency` 是每台机器还是每个 identity？
   当前实现：每个 identity 各算各的（profile 挂在机器上，count 挂在 env 上）。
