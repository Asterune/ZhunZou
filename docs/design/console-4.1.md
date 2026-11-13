# Step 4.1 设计：决策收件箱 · 设备矩阵 · 快速派单

蓝图出处：`PLAN.md:74`。目标一句话——**把"需要人看一眼"的东西收到一屏里，并且这一屏不需要发明任何新的写路径。**

## 1. 现状核实（逐条可验证）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 控制台是单页 + `activeTab` 切换，没有 vue-router；`?tab=` 写进 URL，`watch(activeTab)` 里按需 `loadRules/loadAgents` | `web/src/App.vue:43,52-64,230-253` |
| 2 | 数据只来自一个快照：`syncSnapshot()` 每 200 条取 tickets/tasks，`store.applySnapshot()` 整体替换；节点画像**已经在** `devices[].profile` 里随快照下发 | `server/src/app.ts:321-331`、`web/src/stores/hub.ts:445-455`、`shared/src/schemas.ts:260-277` |
| 3 | web 的 7 个测试文件**没有一个挂载 .vue 组件**（devDeps 里没有 `@vue/test-utils`/jsdom/happy-dom）；被测面全是 `src/lib/*.ts` 纯函数与 `createHubStore(fakeApi)` | `web/package.json:21-29`、`web/test/devices.test.ts:32-61` |
| 4 | 任务状态文案与配色**已经认识** `BLOCKED/HEALING`（Step 1.1 就落了），`isActiveTask` 把 HEALING 算活跃 | `web/src/lib/format.ts:34-56`、`web/src/lib/i18n.ts:126-127` |
| 5 | 管家的"一句话诊断"住在 `task_logs.diagnosis`，3.3 刻意**没有**把它写进任务行（`result` 必须是引擎原话） | `server/src/db/schema.ts:311-312`、`server/src/app.ts:847,862,876,891`、`PLAN.md` 3.3 §落地说明 |
| 6 | `listTaskLogs` 只有 `after` 游标 + 升序，**没有取尾部的能力**；`collectEvidence` 因此一次读 500 行 | `server/src/repository.ts:2142-2152` |
| 7 | `syncFingerprint()` 覆盖 `agent_tasks.updated_at`，**不覆盖 `task_logs`**；纯日志写入（3.3 的 APPROVE 分支）不会推进 `rev` | `server/src/repository.ts:4136-4157` |
| 8 | 服务端 `agent_tasks` 行 4 处测试用 `toEqual({...})` 精确比对——**给任务视图加字段会直接撞红** | `grep -rn "toEqual({" packages/server/test/task*.test.ts` 命中 4 |
| 9 | wip 分支名是端侧内联拼的字符串，出现两次，没有单一来源 | `bridge/src/git/worktree.ts:160,326` |
| 10 | 派单有两条路：`POST /api/tasks`（人指定 env，TaskBoard 现在用这条）与 `POST /api/tasks/dispatch`（按 `repoName`/`tags`/`engine` 交给调度器，409 里带每台候选机被排除的原因）。**web 一次也没调过 dispatch** | `server/src/app.ts:1703-1733`、`shared/src/schemas.ts:500-514`、`web/src/lib/api.ts`（无 dispatchTask） |
| 11 | `api.ts` 里 `retryTask`（3.3 的 `POST /tasks/:id/retry`）与 `takeover`（2.3）都不存在；`getTaskLogs` 已有 | `web/src/lib/api.ts:76-270` |
| 12 | 工单被人工批准时服务端**已经**会蒸馏规则候选，候选有独立的 accept/dismiss 路由，store 也已有 `loadRuleCandidates/acceptRuleCandidate`——"批准并记住规则"缺的只是把两者连起来的那颗按钮 | `server/src/app.ts:1610,3158-3194`、`web/src/stores/hub.ts:1356-1360` |
| 13 | `fleetWorkspaces` 是"期望工作区登记表"（host/path/status/error），与 Step 2.1 的任务级 worktree **不是同一回事**，不能拿来当 Worktree 数 | `shared/src/schemas.ts:918-929` |
| 14 | 弹窗范式已存在：`props.open` + `emit('close')` + `fixed inset-0 z-50` + `role="dialog" aria-modal` + `@click.self` + 二次确认倒计时；不需要 Teleport | `web/src/components/BatchApproveDialog.vue:17-21,99-108,167-190` |
| 15 | AgentPanel 的 `nodes` computed 按 host 聚合 device+agent，重名时把 device id 前缀拼进标题，未归属 agent 落到 `ungrouped:` 桶——这套语义要原样保住 | `web/src/components/AgentPanel.vue:83-152` |
| 16 | 节点没有"执行命令"的通道：`realtime-client` 只把 `task.assigned`/`ticket.resolved` 当唤醒提示 | `bridge/src/realtime-client.ts:194,211` |

## 2. 落点

### 2.1 server：只读一块收件箱视图，不新增写路径

- 新增 `GET /api/supervisor/inbox?limit=`（`requireAdmin`），返回 `{ items: SupervisorInboxItem[] }`。
- `SupervisorInboxItem = { task: AgentTask, diagnosis?, diagnosisAt?, errorSignature?, branch? }`——**`task` 原样复用 `agentTaskSchema`，一个字段都不加**（事实 8）。诊断是"最近一行 `diagnosis IS NOT NULL`"，错误名是"最近一行 `error_signature IS NOT NULL`"，都由仓储一条批量查询取回（`id in (select max(id) ... group by task_id)` 形状），不靠翻 500 行日志（事实 6）。
- 收录状态固定为 `BLOCKED` + `DONE`（蓝图原话"仅 BLOCKED/DONE"），排序 = BLOCKED 先、各自 `updatedAt` 倒序，`limit` 在合并**之后**截断（默认 20，上限 50），保证 BLOCKED 永不被 DONE 挤掉。
- `branch` 只在 `task.workspacePath` 存在时给出（没开过隔离的任务不该长得像有分支）。分支名不再由 Hub 拼字符串，改为 `shared` 的 `wipBranchName(taskId)`，bridge 两处内联同时改为引用它（事实 9）——**同一个字符串，行为零变化**，只是从此只有一个来源。
- **不动 `syncFingerprint`**（事实 7）：收件箱不在快照里，走"进页面加载 + `rev` 变化时重载"，代价是多一次 REST 读，收益是不碰任何既有测试。

### 2.2 web：派生逻辑住 lib，store 只多三个动作，组件只渲染

- `src/lib/inbox.ts`（纯函数）：`sortInbox`、`blockedCount`、`mergeInfoFor`、`deviceForTask`（env → device，复用现有 `devices[].envs` 口径）。
- `src/lib/matrix.ts`（纯函数）：`buildNodeMatrix(devices, agents, tasks, { unknownHost })`——把事实 15 的那段 computed **原样搬进来**并补画像：`role`/`tags`/`freeMemoryMB`/`maxConcurrency`/`repos.length`/`activeCount`/`isolatedCount`。AgentPanel 改为调用它（形状兼容，行为不变；`unknownHost` 由组件传 `t('agents.unknownHost')`，lib 不碰文案）。
- `src/lib/api.ts`：`getInbox` / `retryTask` / `takeoverTask` / `dispatchTask` 四个方法（全部指向已存在的 server 路由，事实 10/11）。
- `src/lib/history.ts`：加一个纯函数 `candidateForTicket(candidates, ticketId)`——"这条已决有没有对应的候选规则"是判断，不是渲染，得能被测试问到。
- `src/stores/hub.ts`：`inbox` + `inboxLoading` + `loadInbox()`；`retryTask(id, reason)`、`takeoverTask(id)`、`dispatchTask(input)` 三个动作沿用既有 `createTask/cancelTask` 的 toast + `refresh()` 口径；`dispatchTask` 失败时把 409 的 `message`（排除原因）原样抛给 UI，不翻译不截短。
- 组件：`InboxPanel.vue`（新 tab）、`QuickDispatchDialog.vue`（两种模式：指定机器＝既有 `createTask` 语义；按仓库派单＝`dispatchTask`）、AgentPanel 的节点卡升级为矩阵、`HistoryList.vue` 的已决条目加"记住规则"（仅当该工单已有候选，事实 12）。
- **动作失败走 toast，不走 `lastError`**：`fail()` 是 store 里 `loadAgents/loadRules/resolveTicket` 共同的口径（只 toast，401 才登出）；`lastError` 专门表示 sync 的健康状态，收件箱读失败去改它会把"同步中断"横幅点亮成假信号。
- **"记住规则"不放在 TicketCard**：TicketCard 的两个调用点（`App.vue` 御览页、`ChatPanel.vue` 会话页）只渲染**待批**工单，而规则候选在工单**决议之后**才由服务端蒸馏出来（事实 12）——按钮长在 TicketCard 上永远不会出现。落点因此是历史决策页：进入时 `loadRuleCandidates()`，条目有候选才画 chip。
- **托管是按钮不是开关**：2.3 的 takeover 是单向、只允许 CLAIMED（`PLAN.md` 2.3 §落地说明），所以 UI 上是「交给管家」，置位后消失；没有反向路由就不画反向开关。

## 3. 明确不做

- 不做真合并（用户决定）：卡片给 `workspacePath` + `wip 分支名` + 一句"发布动作仍在节点上做"，不出现任何 Hub 驱动 git 的假把手（事实 16）。
- 不改 `agentTaskSchema`/`syncStateSchema`/`syncFingerprint`/`task_logs` 索引（事实 2/7/8）。
- 不给 `DONE` 造"一句话诊断"：DONE 没有处置记录是**正确**的，卡片显示引擎的 `result`。
- 不做组件渲染测试（事实 3）：可断言的东西全留在 lib 与 store；组件只做渲染与传参，`pnpm -r typecheck` 用 vue-tsc 兜形状。
- 不做移动端推送卡片与审批链接（Step 4.2）；不做规则候选的自动学习。

## 4. 测试矩阵

### A. `shared`（`test/supervisor-inbox.test.ts`）

| id | 输入 | 期望 |
|---|---|---|
| S1 | `wipBranchName(41)` | `wip/zz-41`（与 bridge 旧内联逐字节一致） |
| S2 | `wipBranchName('a/b')` / 超长 | 仍只拼前缀，不猜语义；不抛 |
| S3 | `supervisorInboxItemSchema` 解析 `{task}` | 通过；三个可选键缺席时**不注入 undefined** |
| S4 | `task` 内多一个未知键 | 被剥掉（对象不是 passthrough） |
| S5 | `limit` 查询 0/51 | 拒绝；缺省 20 |

### R. `server`（`test/db-inbox.test.ts` 仓储层）

| id | 场景 | 期望 |
|---|---|---|
| R1 | 一个 BLOCKED 有两条处置行 | 取**最后**一条 diagnosis 与其 `createdAt` |
| R2 | BLOCKED + DONE 混合 | BLOCKED 在前，各自时间倒序 |
| R3 | 40 个 DONE + 1 个 BLOCKED，limit 20 | BLOCKED 必在结果里（截断在合并之后） |
| R4 | FAILED/CLAIMED 任务 | 不出现在收件箱 |
| R5 | DONE 无处置行 | `diagnosis` 键整个缺席 |
| R6 | 任务带 `workspacePath` | 给 `branch`；不带则整个缺席 |
| R7 | `error_signature` 有多行 | 取最新一行的签名 |
| R8 | 旧库（无 `diagnosis`/`error_signature` 列的 `task_logs`） | 3.3 的升级路径下不报错，诊断为空 |

### H. `server`（`test/api-inbox.test.ts` 路由）

| id | 场景 | 期望 |
|---|---|---|
| H1 | Agent token 调 `GET /api/supervisor/inbox` | 403（收件箱是 admin 视角） |
| H2 | BLOCKED 经 3.3 熔断后调路由 | 返回该项，`diagnosis` 是熔断句 |
| H3 | `?limit=abc` / `?limit=999` / `?limit=0` | 400 |
| H4 | 空库 | `{ items: [] }` |
| H5 | 同一任务连续两次熔断 | 只出现一次，diagnosis 是第二次 |
| H6 | DONE 经路由 | 出现，且除 `task` 外不注入任何键 |

### I. `web`（`test/inbox.test.ts`，纯函数 + store）

| id | 场景 | 期望 |
|---|---|---|
| I1 | `sortInbox` 打乱输入 | BLOCKED 先、`updatedAt` 倒序，**不截断**（截断是服务端的事） |
| I2 | `blockedCount` | 只数 BLOCKED |
| I3 | `mergeInfoFor` 有/无 `workspacePath` | 有 → `{branch:'wip/zz-<id>', path}`；无 → `undefined` |
| I4 | `deviceForTask` | env 命中 `device.envs` 才算；无 device 返回 undefined |
| I5 | `loadInbox` 期间再触发 | 不并发（`inboxLoading` 守卫）；失败只 toast（`fail()` 口径），已在屏上的卡片不动 |
| I6 | `retryTask` 成功 | 调了对应路径、`refresh()` 被叫、项从队列里消失 |
| I7 | `retryTask` 409 | 不动本地状态，错误原文进 toast |
| I8 | `dispatchTask` 409 `NO_ROUTE_TARGET` | `message` 原样透出（排除原因是产品价值，不是日志） |

### M. `web`（`test/matrix.test.ts`）

| id | 场景 | 期望 |
|---|---|---|
| M1 | 事实 15 的既有语义 | 同 host 多机加 device id 前缀；未归属 agent 进 `ungrouped`；排序 = 在线数→总数→host |
| M2 | `profile` 缺席（老 bridge） | role 显示 `worker`、tags `[]`、内存显示 `—`，**不报错不遮行** |
| M3 | `activeCount` | 只数 PENDING/CLAIMED/HEALING（与 1.3 占位口径一致），BLOCKED 不占 |
| M4 | `isolatedCount` | 带 `workspacePath` 的任务数，注释写明"按完成回报统计"的口径 |
| M5 | `memoryRatio` | `freeMemoryMB / totalMemBytes`，缺任一 → `undefined`（画不出条就不画） |

### T. `web`（`test/tickets.test.ts`，记住规则那颗按钮）

| id | 场景 | 期望 |
|---|---|---|
| T1 | 已决条目有对应候选 | `candidateForTicket` 命中，chip 可用 |
| T2 | 没有候选（蒸馏还没跑完/无模型） | 返回 undefined，按钮**不出现**——不发明没有把手的按钮 |
| T3 | accept 后 | 候选离开 `pendingRuleCandidates`（store 就地改写，不重拉），同页其它条目的把手不受影响 |

### 全仓验收线

- `pnpm -r typecheck` 与 `pnpm test` 双绿；`web` 测试文件数从 7 增长，**既有 7 个文件一条断言不改**。
- server 既有 `tasks`/`task-logs`/`api-supervisor`/`sync`/`stale-tasks` 用例一条断言不改（事实 8 是这条纪律的直接原因）。
- bridge 的 `git-worktree*.test.ts` 一条断言不改——`wipBranchName` 重构必须逐字节同串。
- `grep -rn "wip/zz" packages/*/src` 只命中 `shared/src/constants.ts`。
- 没有任何新的 `agent_tasks.status` 写入方，也没有新的 git 写操作。

## 5. 已知取舍

- **收件箱走 REST，不进快照**：代价是 BLOCKED 出现到卡片渲染之间多一次请求（进页面即取，`rev` 变化再取）；收益是不动 `syncFingerprint` 的字符串（事实 7）——那是十几个 sync 用例共同依赖的东西。
- **Worktree 数是"按完成回报统计"**：`workspace_path` 只在完成回报时写入（Step 2.1），运行中的隔离任务在 Hub 侧不可见。宁可标口径，也不在矩阵里显示一个看起来实时其实滞后的数字。
- **诊断文本可能滞后于最新一次尝试**：卡片取"最近一条处置行"，而 APPROVE 分支只写日志不改任务（3.3 §7）；这条滞后是设计要的表达方式——管家说过的最后一句话，而不是"当前状态的保证"。
- **`branch` 是约定推导，不是节点申报**：wip 分支名由 taskId 决定，Hub 与节点共享同一个 `wipBranchName()`；若哪天端侧改了命名，这里会一起改，不会各说各话。`base`/`commit` 没有持久化（2.1 只在返回值里给），所以卡片不显示 sha——不猜。
- **没有"托管开关"**：2.3 把 takeover 定成单向置位，仪表盘上画一个能关掉的开关就是在撒谎。
- **规则候选是异步产物**：`distillRule` 在批准之后才跑（还需要模型），所以"批准并记住规则"天然是两颗按钮、两次点击。合成一键要么等待模型要么把按钮变灰，都不如现在诚实。
