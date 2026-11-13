# Step 2.3 设计：`zz run` 本地伴随与空闲自动托管

蓝图条目（`zhunzou_ai.md:129-131`）：`zz run <cursor|opencode> [args...]` 启动本地交互终端，同时向 Hub 注册 `origin:'LOCAL_WRAP'` 任务；监听 stdin 活动，用户连续 5 分钟无操作**且**终端卡在等待确认/报错时，自动把 `managedBySupervisor` 置 `true`，触发 Hub 管家接管。

本文先核实现状，再定语义、落点与测试矩阵。**实现前本文为准，实现后与设计不符处在 PLAN.md §5「Step 2.3 落地说明」记录。**

---

## 1. 现状核实（2026-11-13）

| 事实 | 位置 | 对本步的意义 |
| --- | --- | --- |
| `agentTaskSchema.origin`（默认 `HUB_DISPATCH`）与 `managedBySupervisor`（默认 `false`）都在契约里；列也已建（`ensureColumn`） | `shared/src/schemas.ts:434,438`、`db/client.ts:152,393`、`repository.ts:349` | Step 1.1 只给了**字段**，`grep` 确认端侧没有任何写入方 |
| `POST /api/tasks` 与 `/tasks/dispatch` 都是 `requireAdmin` | `app.ts:1481-1482,1508-1510` | bridge 手里是 `zz_` 域内 token，**建不了任务**。这是本步第一个必须补的口子 |
| `createTaskSchema` 已允许 `origin`/`managedBySupervisor`，`repository.createTask` 也照写 | `schemas.ts:465-467`、`repository.ts:3279-3280` | 值语义已定，缺的只是「谁能写」 |
| `repository.createTask()` 硬编码 `status:'PENDING'`；`claimNextTask` 只取 `PENDING` | `repository.ts:3275,3331-3358` | 若 LOCAL_WRAP 也落在 PENDING，本机 wake 守护进程会把它当派单**再跑一遍** |
| `POST /api/tasks/:id/log`、`/events` 要求任务处于 `CLAIMED`，否则 409 `INVALID_TASK_STATUS`；409 在端侧按永久失败丢弃 | `app.ts:1608-1621,1640-1656`、`wake/event-sink.ts` | 本地任务**建完就是 CLAIMED**，日志与事件立刻可上报，无需放宽旧约束 |
| `POST /api/tickets` 是 `requireEnvAccess`；`GET /tickets/:id/wait` 同域可读回 `selectedOption`/`customInstruction`；`POST /tickets/:id/cancel` 也允许域内 token | `app.ts:1287-1289,1365-1398,1456-1461`、`schemas.ts:88-89` | 建票→等票→撤票三件事**今天就能用 agent token 做完**，接管闭环不需要新协议 |
| 心跳：`status !== 'Idle'` 时 `renewTaskLease(env)` 刷新该 env **所有** CLAIMED 任务的 `leaseAt` | `repository.ts:1282-1286,2081-2087` | 伴随进程只要活着心跳 `Running`，本地任务就不会被清扫器当僵尸 |
| 清扫器：env 离线且 `leaseAt` 超过 `TASK_CLAIM_TIMEOUT_MS`（默认 30min），或 `claimedAt` 超过 `TASK_HARD_TIMEOUT_MS`（默认 6h）→ `releaseTask` | `app.ts:712-761`、`config.ts:339,343` | 人关掉终端窗口/`kill -9` 时任务不会永久卡在 CLAIMED；6h 硬线是本步**已知上界**，见 §7 |
| `activeTaskCountsByEnv` 把 CLAIMED 计入占用 | `repository.ts:3466-3475` | 本地跑着的机器如实占用一个并发槽，调度器因此不会给它叠加派单——**要的就是这个效果** |
| `runProcess` 固定 `stdio:['ignore','pipe','pipe']`，且把输出全量缓存在内存（`MAX_CAPTURE 200k`） | `wake/adapters.ts:97-101,71-76` | 它服务的是「无人值守跑完拿结论」，不能拿来做交互伴随：stdin 直接 ignore，也没有回写通道 |
| `node-pty` 只存在于 `packages/device`（`optionalDependencies` + 懒加载） | `device/package.json`、`device/src/pty/runner.ts:52-60` | bridge 是发给 Cursor 一键安装的独立包，**不引入原生 pty**；见 §4 的取舍 |
| `createLogSink`/`createEventSink`/`createEventPipeline`/`profileForAdapter` 已就绪 | `wake/log-sink.ts`、`wake/event-sink.ts`、`wake/events.ts:39,258` | 事件归一化（Step 2.2）与批量上报直接复用，本步不写第二套 |
| `PRESETS` + `aliases` + `findPresetBinary` + `agentKindForAdapter` | `wake/adapters.ts:317-399,694` | `zz run cursor-agent` 找二进制、拼 argv、定 `engine` 全部复用现成表 |
| CLI 注册范式：`commander` 子命令 → `loadBridgeConfig(env,cwd)` + `loadWakeConfig(env,cwd)` + `createHubApi(hub)` + `createPresenceReporter` → `process.exitCode = await ...` | `cli-program.ts` 全文 | `run` 照此注册，不发明第二套装配 |

结论：**契约、列、票路、管道全都在**，本步缺的是四件——一个 agent token 能用的建任务入口、一个能双向中继又能观察的 spawn、一套「闲了且卡了」的判据、一个把远端决策写回终端的动作。

---

## 2. 落点与边界

新增（全部是增量文件）：

- `packages/shared/src/schemas.ts`：`createLocalTaskSchema`（`POST /api/tasks/local` 的 body）、`takeoverTaskSchema`（`POST /api/tasks/:id/takeover` 的 body）。
- `packages/bridge/src/wrappers/idle.ts`：纯判据，无 I/O。输入「最后一次 stdin 活动时间、输出尾巴、是否有未答的权限事件、当前时刻」，输出「该不该接管」。
- `packages/bridge/src/wrappers/runner.ts`：`runWrapped()`——登记任务、起子进程、双向中继、喂管道、跑判据、执行接管、回写答案、收尾。
- `packages/server`：`repository.createWrappedTask()` / `markTaskManaged()` + 两条路由。
- `packages/bridge/src/hub-client.ts`：`createLocalTask()` / `takeoverTask()`。
- `packages/bridge/src/cli-program.ts`：`zhunzou-bridge run <adapter> [args...]`。

**本步不做**：

- L1 规则引擎、谁来代判（`managedBySupervisor` 的**消费方**）→ **Step 3.2**。本步只保证这个标记有一个诚实的写入方和一条能被唤醒的通道。
- 崩溃自愈、L2 诊断、熔断 → **Step 3.3**。
- 看板上的「管家托管开关」UI（蓝图 `:164`，Phase 4）：只留数据位，不加界面。
- 全屏 TUI（`opencode` TUI、`claude` 无 `-p` 的 REPL）：见 §4，明确不支持并说清为什么。

蓝图把这节写在 `packages/cli-node/src/wrappers`；本仓没有 cli-node，本地执行器就是 bridge 的 wake 家族，故落在 `packages/bridge/src/wrappers/`，目录名保留蓝图的 `wrappers`。

---

## 3. 注册：LOCAL_WRAP 怎么和现有状态机共存

**一句话：新建即 CLAIMED，不经过 PENDING。**

- 新路由 `POST /api/tasks/local`，`requireEnvAccess`（admin 亦可）。body 走 `createLocalTaskSchema`：`env / projectName? / title / instruction / repoName? / engine? / sessionId? / workspacePath?`。
- Hub 侧强制：`origin='LOCAL_WRAP'`、`status='CLAIMED'`、`claimedAt=leaseAt=createdAt=updatedAt=now`、`attempts=1`、`managedBySupervisor=false`。**`origin` 不接受客户端申报**——它是「谁建的单」的凭据，端侧能自填就等于端侧能伪造 Hub 派单。
- 为什么 `attempts=1`：`taskMaxAttempts` 的语义是「被几个执行者碰过」，本地这一次就是第一次。将来若被清扫器回落成 PENDING 再被 wake 循环领取，计数继续走，重试语义不被打穿。
- 为什么不 PENDING：`claimNextTask` 只看 `(env, PENDING)`（`repository.ts:3336`）。本机 fleet 守护进程正在同一个 env 上长轮询，PENDING 落地就会被它抢去、用**非交互** argv 再跑一遍同一条命令——这是最容易被忽略的双跑风险。CLAIMED 直接把它挡在门外。
- 状态机不新增任何边：`CLAIMED → DONE/FAILED`（`completeTask`）与既有的 `CLAIMED → PENDING`（清扫器/`releaseTask`）足够。`HEALING/BLOCKED` 本轮仍然没有写入方，与 1.3/2.1/2.2 的口径一致。
- `workspacePath` 沿用 Step 2.1 的列：伴随进程把**自己 spawn 的绝对目录**报上去，Hub 只存字符串不推导。开了 `ZHUNZOU_WORKTREES` 也不在本地建 worktree——伴随的语义就是「在我眼前这个检出里跑」。
- 回读校验：任务建好，本地立刻 `heartbeat('Running')`，之后按 `heartbeatIntervalMs` 续租（复用 `createPresenceReporter`，它本就为「没有任务也要证明在线」而写）。

登记失败怎么办：**照常跑用户的命令**。`HubApiError` 记一行 `[zhunzou] 任务未登记：<原因>，本地继续执行`，进入「未登记模式」——不报错、不退出、后续所有上报变成 no-op。理由：`zz run` 首先是「帮我起一个 CLI」，Hub 不可达时它必须还能用；静默失败比拒绝服务好，但必须在终端说清楚。

---

## 4. 交互中继：为什么不用 pty，边界在哪

`spawn(binary, args, { stdio: ['pipe','pipe','pipe'] })`，wrapper 做**只观察不改写**的双向中继：

- `process.stdin` → `child.stdin`（同时刷新 `lastActivityAt`）
- `child.stdout` → `process.stdout` **原字节**；同一 chunk 喂 `createEventPipeline`（`forward` 落 `logSink`，`onEvent` 落 `eventSink`，`onPermission` 置 `pendingPermission`）
- `child.stderr` → `process.stderr` 原字节；同样进管道（只 forward，不解析）

不用 `node-pty` 的三条理由，写下来免得下次再争：

1. bridge 是发布给最终用户独立安装的包（`dist-standalone` + 一键脚本），加原生依赖等于给每个平台的安装链路加一个编译期失败点；`packages/device` 把它做成 optional 是有意的。
2. pty 会改变子进程看到的 TTY 语义，等于把「中继」变成「重造终端」，回归面远超本步需要。
3. 本步要的是**能读懂输出**，不是能跑 TUI。

由此产生的**已知限制**（必须印在帮助文本里）：子进程的 stdout 是管道，`isTTY=false`，所以只有 **print/stream 模式**（`claude -p`、`cursor-agent -p`、`opencode run`、`qoder -p`…，即 Step 2.2 里 profile 为 `stream-json`/`opencode` 的那些）适用。全屏 TUI 会自己降级或拒绝启动；单键选择（raw-mode）拿不到，因为终端仍归 wrapper 进程、保持规范模式。行式 `y/n` 提示可用：人在自己终端打的字经包装进程中继给子进程，行缓冲即可。

`Ctrl-C`：终端把 SIGINT 发给整个前台进程组，子进程和自己同时收到。子进程在 `-p` 模式下通常中断当前生成而不退出，包装进程若第一次 SIGINT 就跑路反而丢了观察。策略：**第一次 SIGINT 忽略**（交子进程处理），**第二次 SIGINT 或 SIGTERM** 给子进程发一次 SIGTERM（2s 后 SIGKILL，沿用 `runProcess` 的收尸节奏），等子进程 close 后收尾退出。

引擎与 argv：`zz run <name> [args...]`，`<name>` 先过友好别名 `cursor → cursor-agent`、`opencode → opencode-run`（别名优先于同名 adapter：`opencode` 是仪表盘注入型，只有 `opencode-run` 是可挂在终端上的 CLI），再按 `PRESETS` 找二进制（含 `aliases`）。`auto/command/notify` 一律拒绝——伴随模式必须知道自己在包装谁。名字之后的**所有**参数原样进 argv（commander `enablePositionalOptions()` 在 program 上、`passThroughOptions()` 在 `run` 上，未知选项归子进程；实测：program 的开关必须在 `run` 创建时已打开且在 parse 时仍开着，所以 `run` 注册在 `createProgram()` 的**最后**，其它命令的解析语义不变），包装器自己的选项必须写在 `<name>` 之前。开头那一个 `--` 分隔符剥掉。子进程 argv 不进 shell。

`title` / `instruction` 从被包装的命令行推导：`title = "<binary> <args...>"` 截 200；`instruction` 同串（`shellQuote` 后单行，截 `longTextSchema` 上界），并允许 `--title/--instruction` 覆盖。用途：看板和将来 L2 都靠它读懂「这次本地到底跑了什么」，不是给人看的散文。

---

## 5. 空闲判定与接管（Auto-Handover）

两个条件**同时**成立才触发，逐条都可测：

1. **无人操作**：`now - lastStdinActivityAt >= idleMs`（默认 5min；`ZHUNZOU_WRAP_IDLE_MS` 覆盖，钳到 30s..2h）。计时原点还包括「进程刚起来」，所以人不碰键盘也不会一上来就判空闲。
2. **确实卡住**，三选一：
   - `pendingPermission`：Step 2.2 的管道报过 `permission_required` 且此后既没有新 stdin 活动、也没有新输出——事件驱动，最可靠。
   - 输出尾巴命中确认提示：`[y/n]`、`(y/n)`、`yes/no`、`Do you want to`、`Allow ...?`、`Press Enter to continue`（大小写不敏感，只看尾部 4KB）。
   - 输出尾巴命中报错且**已静默**：`error:`、`Traceback`、`fatal:`、`Failed to`… 且尾部 15s 内没有新输出（跑着的东西不算卡住）。
   尾巴只看**最后一个 chunk 落点**，不看历史，避免把早就答完的提示重复当真。
3. 子进程仍在运行（已退出是「结束」，不是「卡住」）。

触发动作，顺序固定且每步都可降级：

1. `createTicket`：`doneSummary`「本地终端 #id 停在需要确认的一步」，`blockerQuestion` = 卡住原因 + 尾部原文摘录（截断），`nextStepPlan` 说明「批准后会把选项写回终端」；`options = [{key:'y',label:'批准：向终端回写 y'},{key:'n',label:'拒绝：向终端回写 n'}]`，`recommendedOption:'n'`。
2. `takeoverTask(taskId, {reason})`：把 `managedBySupervisor` 置 `true`。这是 Step 1.1 那个列的**第一个写入方**。
3. 起一个与中继并发的长轮询 `wait(ticketId, pollMs)` 循环等答复。

任一步失败都不影响本地进程，也不互相牵连：**建票失败**（永久失败；瞬态只重试一次）→ 记日志，仍然执行第 2 步（人不在了这个事实与票无关），但跳过第 3 步（没有可等的对象）；**置位失败** → 记日志，仍然执行第 3 步，人照样能在看板上答这张票。两条降级路径合起来就是「拿不到托管，至少还能等人」。

回写（这是「接管」在本地真正落地的部分，否则票只是装饰）：

- 收到 `resolved` → 取 `customInstruction`（人在看板上自己写的话）优先，否则取 `selectedOption` 的**键**（`y`/`n`），加一个 `\n` 写进 `child.stdin`。不走 shell、不拼命令。
- 写之前重查现场：若人在本地已经答过（自接管后有 stdin 活动或有新输出），**放弃回写**并 `cancelTicket`，日志「本地已应答，忽略远端决策」。这是双头应答唯一正确的解。
- 写什么都在 `task_logs` 留一条 `system` 记录，审计看得见。
- 回写失败（子进程已退出/管道断了）→ 记日志，继续等子进程收尾，不强杀。
- 每一轮接管之间重新武装判据（`pendingPermission` 清掉、尾巴重新采）；**单次 `zz run` 最多接管 3 次**，超过就只记日志不再建票，免得端上一直卡而看板被刷屏。
- 子进程退出时，未决的票 `cancel`，事件/日志 sink 先 flush 再 `completeTask`（顺序与 2.2 的不变量一致：先落凭证，再动状态）。

---

## 6. 安全边界

- `origin` 由 Hub 写死，不接受端侧申报；`managedBySupervisor` 只能 `false → true`、且只能对**自己 env 的 CLAIMED 任务**置位（路由内 `requireEnvAccess` + 状态检查），置位动作把 `reason` 写进 `task_logs` 留痕。已为 `true` 时幂等返回，不重复留痕。
- 回写进 stdin 的字节长度上界即 `customInstruction` 的 2000，且只追加单个 `\n`；`selectedOption` 只取本包装器自己建票时用过的键集合，不认识的答案不回写。
- 尾巴里的原文会进 `blockerQuestion`：截断到 600 字符，且 Step 3.1 的降噪器上线后统一脱敏（本步先只做长度钳制，不重复实现 sanitizer）。
- argv 全部数组传递；`<adapter>` 必须是 `WAKE_ADAPTERS` 成员，不拼字符串。

## 7. 已知取舍

- 硬超时 6h（`TASK_HARD_TIMEOUT_MS`）：跨天的本地长任务会被清扫器判失败。伴随进程活着会一直续租 `leaseAt`，但 `claimedAt` 不动——这条线是**故意的**，它同时兜住派单任务。今天不放宽；真需要长任务时该改的是这一处配置，不是加特例。
- 心跳 `Running` 会刷新该 env **所有** CLAIMED 任务的租约（既有实现）。伴随进程和 fleet 守护进程同在一台机器时，前者可能替后者的僵尸任务续租。影响是「离线判定晚 30 分钟」，不改。
- 不建 worktree（§3）、不加 UI 字段、不做 TUI。

---

## 8. 测试矩阵

### `packages/shared/test/schemas.test.ts`（追加）

| # | 用例 | 断言 |
| --- | --- | --- |
| S1 | 本地登记最小 body | 解析通过，可选字段不注入 undefined |
| S2 | 空 title / 相对 `workspacePath` / 未知 engine | 400 语义（`safeParse` 失败） |
| S3 | `takeoverTaskSchema` 空 reason | 拒绝 |
| S4 | reason 超 500 字符 | 拒绝 |

### `packages/server/test/task-local.test.ts`（新）

| # | 用例 | 断言 |
| --- | --- | --- |
| L1 | agent token `POST /api/tasks/local` | 201，`origin=LOCAL_WRAP`、`status=CLAIMED`、`attempts=1`、`managedBySupervisor=false`、`claimedAt/leaseAt` 非空、`workspacePath` 落库 |
| L2 | 建完立刻 `GET /api/tasks/next?env=…` | `task=null`（同 env 的 wake 循环抢不走） |
| L3 | 本地任务 `POST /tasks/:id/log`、`/events` | 不 409（CLAIMED 即可上报） |
| L4 | 带 `origin`/`managedBySupervisor`/`status` 申报 | 申报值一律无效，Hub 写死 LOCAL_WRAP/CLAIMED/false |
| L5 | agent token 建**别人 env** 的任务 | 403 `ENV_FORBIDDEN` |
| L6 | `POST /tasks/:id/takeover` on CLAIMED | `managedBySupervisor=true`，`task_logs` 多一条含 reason 的 system 记录 |
| L7 | 再次 takeover | 200 幂等，不重复留痕 |
| L8 | 对 DONE/CANCELLED 任务 takeover | 409 `ALREADY_FINALIZED` |
| L9 | 未知 id | 404 |
| L10 | 旧库（无 `managed_by_supervisor`/`origin` 列）升级后 takeover | 可用，`sqlite_master` 有列 |

### `packages/bridge/test/wrappers-idle.test.ts`（新，纯函数）

| # | 用例 | 断言 |
| --- | --- | --- |
| I1 | 空闲 4min59s | 不触发 |
| I2 | 空闲 5min、无卡住信号 | 不触发 |
| I3 | 空闲 5min + `pendingPermission` | 触发，reason 带 tool/command 摘要 |
| I4 | 空闲 + 尾巴含 `[y/n]`/`Do you want to`/`Press Enter to continue` | 各触发 |
| I5 | 空闲 + 尾巴 `error:` 且静默超过静默窗 | 触发 |
| I6 | 空闲 + 尾巴 `error:` 但仍在产出 | 不触发 |
| I7 | 有新 stdin 活动 | `pendingPermission` 清除、不触发 |
| I8 | 子进程已退出 | 不触发 |
| I9 | 只看尾部 4KB（前文有提示、尾部干净） | 不触发；提示在尾部则触发 |
| I10 | idleMs 边界与钳制（10s → 30s；8h → 2h） | 解析结果符合 |
| I11 | 触发后重新武装 | 第二次同样条件仍可再触发，`handoffs` 计数 +1；到 3 次不再触发 |

### `packages/bridge/test/wrappers-runner.test.ts`（新，注入 fake client + fake spawner）

| # | 用例 | 断言 |
| --- | --- | --- |
| R1 | 正常跑完（exit 0） | `createLocalTask` 被调且 argv/binary 来自 PRESETS；stdout 原字节落到 `process.stdout`；`completeTask DONE`，`result` 取尾部；sink 先 flush |
| R2 | 非零退出 | `completeTask FAILED`，`result` 取 stderr |
| R3 | 登记失败（HubApiError 404 老服务端） | 子进程照跑、退出码透传、日志含「未登记」、上报全 no-op、不抛 |
| R4 | 中继 | 写进 fake stdin 的字节 = `process.stdin` 收到的字节，且 `lastActivityAt` 前进 |
| R5 | 权限事件 | `reportTaskEvents` 收到 `permission_required`；`workspaceRoot` 由管道填 |
| R6 | 空闲 + 权限事件 → 接管 | 依次 `createTicket` → `takeoverTask` → `wait`；**没有** `releaseTask`、没有 `completeTask`（本地进程不能被动） |
| R7 | `wait` 返回 `resolved`+`selectedOption:'y'` | `child.stdin` 收到 `'y\n'`，`task_logs` 有 system 记录 |
| R8 | `resolved` 带 `customInstruction` | 回写自定义文本 + `\n`，优先于选项键 |
| R9 | 接管后本地自己继续了（有新输出），再收到 resolved | **不回写**，`cancelTicket` 被调，日志说明原因 |
| R9b | 接管后人按键（stdin 中继给子进程） | 立刻 `cancelTicket` 撤回工单 |
| R10 | 未知选项键 | 不回写、记日志、不抛 |
| R11 | 建票永久失败 | 仍调用 `takeoverTask`，不调 `wait`，本地进程继续跑、退出码透传 |
| R11b | 置位失败但票已建 | 仍进入 `wait` 循环，人答完照样回写 |
| R12 | 子进程退出时有未决票 | `cancelTicket` 被调 |
| R13 | 两次 SIGINT | 第一次不杀；第二次 SIGTERM→（2s）SIGKILL，收尾 `completeTask` |
| R14 | 心跳 | 运行期至少一次 `Running`，退出后停止 |
| R15 | `cursor`/`opencode` 别名 | 解析到 `cursor-agent`/`opencode-run` 二进制 |
| R16 | `auto`/`command`/`notify`/未知名 | 拒绝并列出可选，不 spawn |
| R17 | 找不到二进制 | 报错退出码 1，不建任务 |
| R18 | 3 次接管后仍卡住 | 不再建票，日志说明已停止托管 |

### `packages/bridge/test/cli-run.test.ts`（新）

| # | 用例 | 断言 |
| --- | --- | --- |
| C1 | `run claude -p "hi" --idle-timeout 1000` 的顺序 | `--idle-timeout` 归包装器（必须在 name 前），`-p`、`"hi"` 原样进 argv |
| C2 | `run --help` | 出现「print/stream 模式」「不支持全屏 TUI」的说明 |
| C3 | 缺 `<name>` | commander 报错退出 |
| C4 | `--` 分隔符 | 去掉后不误入 argv |

### 回归

`pnpm test` 现有 782 项必须全绿（尤其 `wake-adapters-events`、`wake-park`、`task-events`——本步只加不改它们）；`pnpm typecheck` 全绿。

---

## 9. 验收

1. `zhunzou-bridge run cursor-agent -p "..."`：本地输出逐字节可见、可键盘应答；看板出现一条 `LOCAL_WRAP / CLAIMED` 任务，日志与事件在长。
2. 人走开 5 分钟且引擎停在 `[y/n]`：看板多一张票，任务 `managedBySupervisor=true`；在看板点「批准」→ 本地终端收到 `y\n` 并继续。
3. 回到本地自己敲 `y`：远端未决票被撤，`resolved` 到达时**不再**回写。
4. Hub 挂了照样能把 CLI 跑起来（登记失败有明确一行提示，退出码仍是 CLI 的）。
5. `HEALING/BLOCKED` 仍无写入方；web 未改动。
