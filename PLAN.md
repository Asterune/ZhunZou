# 准奏 (ZhunZou) 架构演进蓝图 v2.0 — 仓库执行版

> 本文件由 `~/Desktop/zhunzou_ai.md` 落库而来，并按 Phase 0 盘点结果与用户决策做了**存量对齐修订**。
> 后续 AI/人类实施者以本文件为唯一执行契约；进度记录见文末第 5 节。

## 1. 项目定位与核心哲学

准奏是面向个人开发者的**跨设备异步 AI 研发指挥中心与分布式管家系统（Control Plane & Supervisor Agent）**，解决多台设备并发运行 Cursor CLI / OpenCode / Qoder 等工具时的心智负担（Context Switching）与静默阻塞（Silent Blocking）。

核心设计原则（保持蓝图原意）：

1. **双向无缝纳管（Bidirectional Handover）**：Web 控制台向远端派发任务；同时在任意机器本地用 `zz run` 拉起引擎，用户离开或无交互时自动切入管家托管。
2. **极简零基础设施依赖（Zero-Infra）**：不引入 Redis / PostgreSQL / Docker / RabbitMQ。控制面为单进程 Node + 内置 SQLite（WAL）+ 静态 Web 资源；边缘节点主动 Outbound 长连接注册，内网零配置穿透。
3. **低成本高可靠自治（Human-in-the-Loop）**：L1 确定性护栏（0ms / 0 Token）→ L2 轻量 LLM 结构化诊断 + 基于 Git Checkpoint 的重试 → 熔断升级人工；挂起时保存引擎原生 `sessionId`，审批后原地断点续跑。
4. **工作区并发隔离**：任务执行前创建 `.zhunzou/wt/<taskId>` 独立 Git Worktree 与 `wip/zz-<taskId>` 临时分支，杜绝多 Agent 并发踩踏同一工作区。

## 2. 目标架构与存量包映射

蓝图使用 `protocol / hub-server / cli-node / web-ui` 四个逻辑层命名；仓库已有等价实现，**沿用现有包名，不重命名、不新建第六个包**（`zhunzou-bridge` 已发布 npm 且有 CI 发布链路）。

| 蓝图逻辑层 | 现有包 | 承载内容 | 本次缺口 |
|---|---|---|---|
| `protocol` 契约层 | `@zhunzou/shared` | `src/schemas.ts`（agent/device/task/ticket/chat）、`src/realtime.ts`（WS 帧信封）、`src/device.ts`（capabilities/stats）、`src/constants.ts`（状态机） | 节点画像 `role/tags/freeMemoryMB/maxConcurrency/repos`；任务 `engine/origin/sessionId/managedBySupervisor/retryCount`；`SUPERVISOR_DECISION`、`PERMISSION_REQUEST` 语义 |
| `hub-server` 控制面 | `@zhunzou/server` | Fastify 5 + better-sqlite3(WAL) + Drizzle；`src/db/schema.ts`（tickets/agents/devices/agent_tasks/task_logs…）、`src/realtime/gateway.ts` + `device-router.ts`（WS + 心跳 + 长轮询）、`src/app.ts`（REST）、`src/meta-agent.ts` + `decision-policy.ts`（预审批）、`src/notifications.ts`（飞书/Bark/Slack/Discord/ntfy/Telegram/Webhook）、`src/rule-distiller.ts` + `rules-store.ts` | `learned_rules` 落地为可执行匹配表；资源感知调度（role + 空闲内存水位 + 仓库就绪度）；L1 护栏引擎、L2 诊断器与熔断器 |
| `cli-node` 边缘面 | `zhunzou-bridge`（`packages/bridge`）+ `@zhunzou/device`（`packages/device`） | `bridge/src/wake/adapters.ts`（opencode/claude/qoder/cursor-agent 适配）、`hub-client.ts`、`realtime-client.ts`、`workspaces.ts`、`wait-command.ts`、`cli.ts`（commander）、`service.ts`；`device/src/capabilities.ts`（`freemem`/cpus/loadavg）、`pty/`、`connection.ts` | Git Worktree 隔离器 + Checkpoint + Squash&Rebase；`zz hub` / `zz join` 命令；`zz run` 本地伴随与空闲托管；终端 `LogSanitizer`；Session 断点续跑 |
| `web-ui` 视图层 | `@zhunzou/web` | Vue 3 + Vite + Tailwind 4 + xterm；`src/components/`（TaskBoard/ChatPanel/TerminalPanel/RulesEditor/BatchApproveDialog…）、`src/stores/hub.ts` | 决策收件箱（仅 BLOCKED/DONE）、设备矩阵内存水位视图、快速派单弹窗（Phase 4，本次范围外） |

目录约定（在现有结构上补齐边缘面模块）：

```text
packages/
├── shared/src/{schemas,realtime,device,constants}.ts   # [契约层]
├── server/src/
│   ├── db/{schema,client}.ts                            # nodes/devices/tasks/task_logs/learned_rules
│   ├── realtime/{gateway,device-router}.ts              # [调度] repoName + 空闲内存 + 并发余量
│   └── supervisor/                                      # [管家] guard.ts(L1) + healer.ts(L2) + 熔断
├── bridge/src/
│   ├── cli.ts                                           # zz hub / zz join / zz run
│   ├── adapters|git|sanitizer|wrappers/                 # 本次新增子目录
│   └── wake/                                            # 已有引擎适配与守护
├── device/src/                                          # 已有 daemon / capabilities / pty
└── web/src/                                             # 已有 Vue 控制台
```

## 3. 实施铁律

1. **严禁推倒重来**：先盘点（Phase 0 已完成），已有能力重构/扩展，不做平行重写；框架保留 Fastify 5 + Vue 3。
2. **测试先行**：契约校验、L1 规则引擎、日志降噪器、Worktree 生命周期等核心函数必须有 Vitest 单测，`pnpm test` 100% 通过。
3. **规范提交**：每完成一个 Step 产生一条 Conventional Commits 提交（如 `feat(bridge): implement git worktree manager`）。

## 4. 分阶段路线图

### Phase 0 — 存量盘点与基建对齐
- [x] Step 0.1 存量代码盘点：结果见第 2 节映射表与第 5 节记录。
- [x] Step 0.2 Monorepo 基建：`pnpm-workspace.yaml`（`packages/*`）与 `tsconfig.base.json`（`strict` + NodeNext）已存在；新增根级 `vitest.workspace.ts`，`pnpm test`（`pnpm -r test`）保持逐包运行，`npx vitest run` 单进程跑全仓。

### Phase 1 — 契约层、零依赖 Hub 与资源感知节点注册
- [x] **Step 1.1 (`shared`)** Zod 契约：`NodeProfile{nodeId,hostname,role:'portal'|'worker'|'hybrid',tags,freeMemoryMB,maxConcurrency,repos}`；`TaskRecord{id,title,repoName,engine:'cursor'|'opencode',origin:'HUB_DISPATCH'|'LOCAL_WRAP',sessionId,managedBySupervisor,status:'QUEUED'|'RUNNING'|'BLOCKED'|'HEALING'|'DONE'|'FAILED',retryCount}`；`WsMessage` 覆盖 `NODE_REGISTER/NODE_HEARTBEAT/TASK_DISPATCH/TASK_LOG_STREAM/PERMISSION_REQUEST/SUPERVISOR_DECISION`。
- [x] **Step 1.2 (`server/src/db`)** better-sqlite3(WAL) 建表与自动升级：`nodes`（在线状态/画像/最后心跳，扩展现有 `devices`）、`tasks`（元数据/状态机/关联节点/sessionId，扩展现有 `agent_tasks`）、`task_logs`（已有）、`learned_rules`（用户手动授权的命令匹配白名单）。
- [x] **Step 1.3 (`server`)** REST `/api/nodes`、`/api/tasks`、`/api/tasks/dispatch`；WS Token 校验 + 30s 心跳超时置 offline；智能调度器按 `repoName` 匹配度 + `role!=='portal'` + `freeMemoryMB>2048` 分配算力节点。
- [x] **Step 1.4 (`bridge`)** `zz hub --port 8765 --token <secret>` 一键拉起控制面；`zz join <hub-url> --token --role --tags --scan-dir`：递归扫描 Git 仓库、每 15s 上报 `os.freemem()` 与心跳。

### Phase 2 — 双向适配器、Session 断点续跑、Worktree 隔离
- [x] **Step 2.1 (`bridge/src/git`)** `WorktreeManager`：`createWorktree(taskId,repoPath,targetBranch)` → `.zhunzou/wt/<taskId>` + `wip/zz-<taskId>`；`createCheckpoint(taskId,label)` 保存现场（落地改为 wip 分支上的 checkpoint 提交，见 §5 说明，`git stash create` 收不到未跟踪文件）；`squashAndRebase(taskId,mainBranch,commitMessage)`。
- [x] **Step 2.2 (`bridge/src/adapters`)** 引擎事件归一化与 Session 断点续跑：从 `--output-format stream-json` 提取 `tool_call`/`permission_required`/`sessionId`（落地为"一个解析器 + 每引擎 profile"，不新建 `CursorAdapter`/`OpenCodeAdapter` 两个类，见 §5 说明）；挂起时记录 `sessionId` 并释放子进程（ticket + `releaseTask(requeue)`），下次 claim 用 `--resume <sessionId>` 原地续跑。
- [ ] **Step 2.3 (`bridge/src/wrappers`)** `zz run <cursor|opencode> [args...]`：本地交互 + 注册 `origin:'LOCAL_WRAP'` 任务；监听 stdin 活动，连续 5 分钟无操作且卡在确认/报错时置 `managedBySupervisor=true` 触发 Hub 接管。

### Phase 3 — Supervisor Agent（降噪、分级风控、自愈、自学习）
- [ ] **Step 3.1 (`bridge/src/sanitizer`)** `LogSanitizer`：剥离 ANSI；折叠重复进度条/构建输出；提炼 `Error:`、TS 错误码、单测断言与堆栈，输出 ≤2000 字符高密度诊断。
- [ ] **Step 3.2 (`server/src/supervisor/guard.ts`)** L1 确定性风控：只读命令/单测编译/工作区内源码变更 0ms 放行；`rm -rf`、跨工作区、`.env*` 与 `~/.ssh/*`、`git push -f`、`git reset --hard` 0ms 拦截挂起；查 `learned_rules` 正则/通配命中自动放行。
- [ ] **Step 3.3 (`server/src/supervisor/healer.ts`)** L2 轻量 LLM 结构化诊断（`decision:'APPROVE'|'RETRY_WITH_FIX'|'ESCALATE_TO_HUMAN'` + `diagnosisSummary`≤50 字 + `fixPrompt`）；熔断：`retryCount>=3`、连续两次报错相似度 >85% 或 Git diff hash 无变动 → `BLOCKED`。

### Phase 4 — 上帝视角控制台与移动端闭环（本次范围外，待后续）
- [ ] **Step 4.1 (`web`)** 决策收件箱（仅 BLOCKED/DONE，设备标签 + 管家一句话诊断 + Git 变更摘要 + 审批按钮组）、设备矩阵（在线/空闲内存/Worktree 数/托管开关）、快速派单弹窗。
- [ ] **Step 4.2 (`server/src/notify`)** 飞书/企微交互卡片 + 通用 Webhook；`BLOCKED`/`DONE` 推送带 `[批准继续]` `[批准并记住规则]` `[一键 Squash 变基合并]`。

## 5. 实施进度记录（AI 自动维护）

### Phase 0 盘点结论（2026-11-13）

- 仓库已是可用 pnpm monorepo，5 个包全部 `vitest run` 通过（基线 33 files / 259 tests 全绿），无需结构重建。
- 存量能力覆盖度评估：
  - **契约层**约 70% 就绪：WS 帧信封、设备画像、任务/ticket 状态机已有，缺蓝图要求的 role/tags/内存水位/并发上限/repos 与 `origin`/`sessionId`/`retryCount` 字段。
  - **控制面**约 60% 就绪：DB(WAL)、REST、WS 网关、心跳、通知渠道（含飞书）、规则蒸馏已存在；缺资源感知调度、`learned_rules` 执行、L1/L2 管家与熔断。
  - **边缘面**约 40% 就绪：4 类 CLI 引擎适配、心跳、node-pty 终端、worktree **识别**已存在；缺 worktree **创建/快照/合并**、`zz hub`/`zz join`/`zz run`、日志降噪器、Session 断点续跑。
  - **视图层**已有控制台，本次不改动（Phase 4）。
- 决策（用户确认）：保留 Fastify 5 + Vue 3；边缘新能力以子目录形式增量落在 `bridge`/`server`，不新建 `cli-node` 包；本次执行范围为 Phase 1 → Phase 3。
- 待补基建：根 `vitest.workspace.ts`（新增）、`.gitignore` 已忽略 `data/`、`release/`；`.cursor/mcp.json` 含 Token，禁止提交。

### Step 记录

| Step | 状态 | 提交 | 备注 |
|---|---|---|---|
| 0.1 存量盘点 | 完成 | `docs(plan)` | 见上表与第 2 节 |
| 0.2 Monorepo 基建 | 完成 | `test(repo)` | 全仓 555 tests / 66 files 双链路（`pnpm test`、`npx vitest run`）通过 |
| 1.1 契约层 | 完成 | `feat(shared)` | `shared/src/{node,supervisor}.ts` 新增；`constants/realtime/schemas` 扩写；tasks 新字段落库并带旧库升级迁移 |
| 1.2 数据层 | 完成 | `feat(server)` | `devices` 加画像列、`task_logs` 加诊断列、新增 `learned_rules` 表；全仓 74 files / 617 tests 通过 |
| 1.3 调度器与 API | 完成 | `feat(server)` | `server/src/scheduler.ts` 新增；`/api/nodes`、`/api/tasks/dispatch` 上线；全仓 76 files / 642 tests 通过 |
| 1.4 节点接入 CLI | 完成 | `feat(cli)` | `zhunzou-device join` + `main.js hub --port --token`；画像随 hello/heartbeat 上报，心跳默认 15s；全仓 81 files / 676 tests 通过 |
| 2.1 Worktree 隔离 | 完成 | `feat(bridge)` | `bridge/src/git/worktree.ts` + wake 循环 `ZHUNZOU_WORKTREES=1`（默认关）；`agent_tasks.workspace_path` 落库；全仓 85 files / 714 tests 通过 |
| 2.2 引擎事件与续跑 | 完成 | `feat(bridge)` | `wake/events.ts` + `wake/event-sink.ts` + `task_events` 表与两条路由；park 走 ticket + 重排；`shared` 越界判定改为只能收紧；全仓 91 files / 782 tests 通过 |
| 2.3 | 未开始 | — | — |
| 3.1–3.3 | 未开始 | — | — |

**Step 1.1 落地说明（与蓝图的差异）**

- 契约不新造实体，扩写现有 `device` / `agent_tasks` / realtime 帧信封：`nodeProfileSchema` 挂在 `hello`/`heartbeat` 帧上，`permission.request`(PERMISSION_REQUEST) 与 `supervisor.decision`(SUPERVISOR_DECISION) 为新增帧。
- `WS_EVENTS` 常量把蓝图六个事件名映射到实际帧名（`NODE_REGISTER→hello`、`TASK_DISPATCH→task.assigned`、`TASK_LOG_STREAM→task.log`），避免两套协议。
- 状态机沿用 `PENDING/CLAIMED` 并新增 `BLOCKED/HEALING`；`TASK_STATUS_ALIASES` 记录与蓝图 `QUEUED/RUNNING` 的对应关系。
- 引擎字段取 `AGENT_KINDS` 超集（含 cursor/opencode/claude-code/qoder 等），因为边缘已适配四种 CLI。

**Step 1.2 落地说明（与蓝图的差异）**

- 不新建 `nodes` 表：节点卡片就是 `devices`，画像以独立列落库（`role`/`tags`/`max_concurrency`/`free_memory_mb`/`repos`）而不是 JSON 大字段，调度器排序无需解析整张卡。列为 NULL 表示"从未上报"，读回时按协议默认值（worker / `[]` / 并发 1）合成 `profile`，`nodeId` 由 Hub 拥有（等于 device id，客户端自称的名字一律丢弃）。
- 没有画像的 hello/heartbeat 不会擦掉上一次上报的画像，只覆盖本轮带来的字段；`free_memory_mb` 优先取节点自报，否则由 `deviceStats.freeMemBytes` 折算 MiB。
- `tasks` 沿用 `agent_tasks`（Step 1.1 已扩列）；本步只补 `task_logs` 的三列诊断（`error_signature`/`diagnosis`/`diff_hash`），因为熔断比较的是日志行而不是任务行。
- `learned_rules` 是新表，与已有的 `rule_candidates`（规则蒸馏候选）并存：候选是人审阅的草稿，`learned_rules` 是已生效的放行/拒绝决定，L1 引擎只读后者。`(pattern, action)` 唯一索引让重复批准更新同一行，避免白名单越长越大。
- 迁移沿用本仓库既有约定：`DDL` 里只建表，所有依赖新列的索引都在 `ensureColumn()` 之后单独创建，否则从旧库升级会在缺失列上中断整次升级。
- 测试：`test/db-nodes.test.ts`（画像持久化/单卡修订/无画像不擦除/旧 `devices`+`agents` 升级）、`test/db-learned-rules.test.ts`（增删改查/去重/计数/正则拒绝/旧库建表）、`test/db-task-diagnostics.test.ts`（诊断回读/普通行不留痕/旧 `task_logs` 升级保数据）。

**Step 1.3 落地说明（与蓝图的差异）**

设计先行，见 `docs/design/scheduler-1.3.md`（含现状核实、规则表、测试矩阵与三个待定问题）。

- **只新增，不改现有语义**：`POST /api/tasks`（人指定 env）与 `claimNextTask` 完全不动；调度只挂在新的 `POST /api/tasks/dispatch`。原计划里"claim 时校验 repo 匹配"被否决——`ListTasksQuery` 没有 `repoName` 维度，加进去会改动所有 bridge 的取任务路径。
- 调度对象是 **env（identity）而不是机器**：dispatch 的结果仍然写进 `agent_tasks.env`，因此老的长轮询 `GET /api/tasks/next?env=` 天然能取到派单结果，无需新增推送路径。
- `repoName` 是**硬过滤**而非加分项：节点没上报该 checkout 就派不过去，返回 409 并附每台候选机被排除的原因（`assessed[]`），比让任务在第一条命令上失败更诚实。
- 从未上报内存的遗留 bridge 不因 `freeMemoryMB` 缺失被淘汰（只是没测，不是没内存），但排在健康节点之后；`role==='portal'`、心跳超 30s、`activeCount>=maxConcurrency`、缺 tag、引擎不符一律淘汰。
- 30s 心跳窗口只用于节点视图与调度（`GET /api/nodes` 的 `online`），`/api/devices` 与 `/api/agents` 的 90s 显示窗口保持不变，避免已部署控制台上的设备卡片闪烁离线。
- `maxConcurrency` 只在 dispatch 决策时生效（占位计数为 `PENDING/CLAIMED/HEALING`；`BLOCKED` 等人期间不占额度）；claim 侧不做容量检查，容量由节点自己决定。
- 本步**不落 `repoPath`/`workspacePath`**：worktree 还不存在（Step 2.1），且 `repos[].path` 是节点本机绝对路径，Hub 无法推导，写进去只会被误当本地路径。落地方式已在设计文档 §6 写给 Step 2.1 遵循。
- 测试：`test/scheduler.test.ts`（17 项：过滤原因、边界值 2048/2049 与 30s、内存缺失仍候选、空闲优先、同分按 env 字典序、原因汇总、`toRouteCandidates` 默认值与心跳折算）、`test/nodes-api.test.ts`（8 项：节点视图鉴权与画像、按仓库选节点并能被该节点 claim、无候选 409 说明原因、显式 env 直派且不调度、派给未注册 env 被拒、缺 repo/env 校验 400、满载节点不再接单）。

**Step 1.4 落地说明（与蓝图的差异）**

- 蓝图里的 `zz` 可执行文件在本仓库不存在，也没有必要新造：`zz hub` 落在 `@zhunzou/server` 的既有入口（`node dist/main.js hub --port 8765 --token <secret> [--host --db]`），`zz join` 落在已经持有 `/ws/device` 反连守护进程的 `@zhunzou/device`（`zhunzou-device join <hub-url> --token --env --role --tags --scan-dir --max-concurrency`）。blueprint 把这两件事写在 `bridge` 包里，但 `zhunzou-bridge` 是已发布的 npm 包，用 esbuild 打独立 bundle（`dist-standalone/cli.mjs`），不能依赖带原生 better-sqlite3 的 server，也不拥有设备身份，故按依赖事实重新归位；`run`/`capabilities` 等既有命令与参数一字未改。
- `hub` 的 flag 不引入第二套配置：`packages/server/src/hub-cli.ts` 只做 `--port/--host/--token/--db → PORT/HOST/HUB_SECRET_TOKEN/DATABASE_PATH` 的翻译，默认值仍然只住在 `loadConfig()` 一处；非法端口直接报错退出（2），不静默回落到 8787。命令行 token 会进 `ps`，启动时用 `app.log.warn` 提示优先用环境变量。
- `join` 与 `run` 的区别只有一件：join 必须以位置参数给出 hub URL，并把 `--role/--tags/--scan-dir/--max-concurrency` 折成 `ZHUNZOU_NODE_*` 环境变量后交给同一个 `loadDeviceConfig()`。`~/code` 按 shell 语义展开。
- 仓库盘点住在 `packages/device/src/profile.ts`：`scanRepos()` 是**有界**遍历（默认 3 层、最多 50 个、跳过 `node_modules` 与点目录、按名去重取第一次命中、读 `.git/HEAD` 得 `defaultBranch`，`.git` 是文件即 linked worktree 也算），目录读不到就跳过而不是中断整次扫描。默认不扫描任何目录——只有 `--scan-dir`/`ZHUNZOU_SCAN_DIRS` 显式给出才落盘遍历，且 50 个上限同时是 `nodeProfileSchema.repos.max(50)` 和单帧 64 KiB 预算的保证。
- 画像随 hello 上报，并在**每个** heartbeat 重发：仓库清单是昂贵部分，按连接（含重连）重建一次；`freeMemoryMB` 每次由 `stats.freeMemBytes` 折算，因此调度器看到的内存总是新鲜的。没有 `node` 配置的机器（如既有 `run` 部署、测试）保持原样：只报 capabilities/stats，帧里不出现 `profile`。
- 心跳默认从 30s 改为 15s（`NODE_HEARTBEAT_REPORT_MS`），server 的 `REALTIME_HEARTBEAT_MS` 同步跟上。这不是口味问题：调度器的节点新鲜度窗口是 30s，30s 一跳等于让健康节点一半时间被判离线。两个值仍可分别用 `ZHUNZOU_HEARTBEAT_INTERVAL_MS` / `REALTIME_HEARTBEAT_MS` 覆盖，Hub 的 `ready.heartbeatMs` 依旧优先。
- 端到端实测（临时 hub + 真 clone）：`join` 后 `/api/nodes` 报出 `role/tags/repos/maxConcurrency/freeMemoryMB/online`，`POST /api/tasks/dispatch {"repoName":"demo-repo"}` 选中内存达标的节点（`score 1555`）并把内存不足的机器以 `MEMORY` 原因排除，派单后该节点 `activeCount` 立即 +1。
- 测试：`packages/device/test/profile.test.ts`（12 项：层级/深度边界、linked worktree、跳过 vendored 目录、同名去重、50 上限、坏目录容忍、默认画像与 nodeId、内存折算）、`test/config.test.ts`（7 项：15s 默认、worker 默认画像、env 解析、非法 role 回落、边界钳制、遗留 `AGENT_ENV`、缺 token 报错）、`test/node-profile.test.ts`（3 项：hello 带画像与清单、heartbeat 刷新内存、无 node 配置不报画像）、`test/join.test.ts`（4 项：位置参数 hub、flag → 环境、帮助文本、`run` 不变）、`packages/server/test/hub-cli.test.ts`（8 项：命令词与裸 flag、env 直通 `loadConfig`、无 flag 不改环境、端口校验、缺值拒绝、token 泄露告警、帮助）。

**Step 2.1 落地说明（与蓝图的差异）**

设计先行，见 `docs/design/worktree-2.1.md`（含现状核实、路径与命名规则、三个方法的语义边界与测试矩阵）。

- 蓝图把这块画在 `packages/cli-node/src/git`，本仓库没有 cli-node；真正执行任务的是 bridge 的 wake 循环，所以模块落在 `packages/bridge/src/git/worktree.ts`，目录名保留蓝图的 `git/`。
- **`createCheckpoint` 没有按蓝图用 `git stash create`**：真实 git 测试直接证伪——`stash create` 看不见未跟踪文件（Apple Git 2.37 上 `-u/--include-untracked` 被静默忽略，只有新文件的工作树返回空 hash 且不报错），而 agent 的产出大多是新文件，蓝图原写法会"快照成功但什么都没存"。落地改为在一次性的 `wip/zz-<taskId>` 分支上 `git add -A --` + `git commit -m "zhunzou:<id> checkpoint: <label>"`：对象因被分支 ref 引用天然可达（不需要 `stash store`），不破坏现场，回滚是 `git checkout <hash> -- .`。
- `squashAndRebase` **不动 `mainBranch`**：合并进主干是"发布"，蓝图自己把它留给 Phase 4 的一键审批按钮；库默认改共享分支等于把不可逆操作藏进一次调用。返回 `{base, commit, mainBranch, workspacePath, branch}`，调用方要发布只需对返回的 commit 做一次 `merge --ff-only`。脏树直接抛 `WORKTREE_DIRTY` 而不是替用户提交未知文件；写步失败按 `rebase --abort` + `reset --hard <原 HEAD>` 还原后再报错。
- 所有 git 调用都是 `spawn('git', [...])` 数组 argv，永不 `shell:true`；`taskId` 必须匹配 `^[A-Za-z0-9._-]{1,64}$`、分支名不得以 `-` 开头或含 `..`，提交信息用融合 `-m<text>` 传递，避免把任意文本变成 git 选项。
- worktree 建在仓库内部会让主检出 `git status` 多出 `?? .zhunzou/`（git 自己不会忽略它，实测确认），首次创建前把 `/.zhunzou/` 追加进 `.git/info/exclude`——本机生效、不会被提交，否则主检出里的 `git add -A` 会把别人的任务工作区一起暂存。写失败不影响隔离，静默跳过。
- 调用方是 wake 循环里的 `resolveWorkspace()`（`bridge/src/wake/isolation.ts`）：`ZHUNZOU_WORKTREES=1` 才开，默认关闭且此时**任何注入都不隔离**（回归保护）；任务带 `repoName` 时先比对 cwd 所在仓库目录名，对不上就照原目录执行并记日志；建 worktree 失败也只记日志、按原目录执行——丢任务比不隔离更糟。隔离成功时 `adapter.wake` 的 cwd 换成 worktree 路径，完成回报带上绝对 `workspacePath`。
- Hub 侧只多一列 `agent_tasks.workspace_path`（`ensureColumn` 升级，索引留待有查询需求）；`completeTaskSchema.workspacePath` 用正则强制绝对路径（POSIX 或 `C:\`），Hub 存字符串不做任何推导——这与 Step 1.3 §6 的约定一致。UI 未加字段（数据层先留位）。
- 测试：`packages/bridge/test/git-worktree.test.ts`（18 项，fake runner 断 argv 序列与状态机：幂等复用、`-b` 取舍、非法 id/ref 在任何 git 调用之前拒绝、checkpoint 只 add+commit、脏树零写操作、rebase 失败还原、只写一次 exclude）、`test/git-worktree-repo.test.ts`（8 项，真实 git，缺 git 时整文件 skip：分支与目录、主检出不受污染、未跟踪文件进快照且可取回、squash 后主干不变而 WIP 成一条、脏树拒绝）、`test/wake-worktrees.test.ts`（7 项：`ZHUNZOU_WORKTREES` 解析与开关默认关、关闭时原 cwd 回归、开启时 cwd 与回报路径、repoName 不匹配、匹配、失败回落、用 daemon 自建的真实 manager 建出 worktree）、`packages/shared/test/schemas.test.ts` 补绝对/相对路径判定、`packages/server/test/task-workspace.test.ts`（4 项：落库回读、不传保持 NULL、相对路径 400、旧库升级后可写）。

**Step 2.2 落地说明（与蓝图的差异）**

设计先行，见 `docs/design/adapters-2.2.md`（含现状核实事实表、事件契约、解析器四条不可让步规则、profile 表与"本机没装这些 CLI"的诚实标注、续跑写侧/读侧/argv、park 语义、`task_events` DDL 与测试矩阵）。

- **没有新增 `CursorAdapter`/`OpenCodeAdapter` 两个类**：本仓适配器早就是 `PRESETS` 表 + `createPresetAdapter`/`createCommandAdapter` 工厂，再造两个类等于把超时、截断、回退逻辑抄第二遍。落地改为**一个纯函数解析器 + 每引擎一份 profile**（`bridge/src/wake/events.ts`），适配器工厂只多接一根管道。profile 三档：`stream-json`（claude/qoder/cursor-agent/opencode-run/command）、`opencode`、`none`（aider/goose/amp/codex/gemini/notify）——`none` 是决定不是缺口：形状没在本仓验证过的引擎就是不做归一化，与这一步之前行为一致。
- **顺手修了一个越界判定的漏洞**：`permissionActionSchema` 原实现里 `outsideWorkspace` 是端侧报什么 Hub 就信什么（`.transform` 只在字段缺失时才重导），被攻破的节点只要报 `false` 就能把自己写在工作区外的操作说成内的。改为**只能收紧**：`action.outsideWorkspace || escapes(...)`，端侧的声明最多让判定更严，永远不会更松。既有"更严格声明仍生效"的断言不变。
- 事件契约里**删掉了蓝图式的 `at`**：Hub 落库时盖 `created_at`，端侧再报一个时间戳等于两个时钟要对齐。同理引擎自己结束时输出的 `result`/`error` 不进事件契约——完成回报走 `completeTask`，输出走 `task_logs`，抄第三份就有三个真值。
- **类型分两个名字不是冗余**：`EngineEvent = z.infer`（Hub 存/读，`outsideWorkspace` 必已判定）与 `EngineEventInput = z.input`（端侧上报，该字段可选，同仓先例 `CreateLearnedRuleInput`）。端侧解析器因此**根本不产这个字段**，判定只在 Hub 重导一次。
- `agent_tasks.session_id` 的唯一写入方是 `POST /api/tasks/:id/events` 里 `kind:'session'` 那条（同一"事务"里插事件行 + 更新该列，无 `sessionId` 的事件不动这一列）。**没有为此加 `PATCH /api/tasks/:id`**：列在 Step 1.1 就已进契约、Step 1.2 就已建，缺的从来是写入方；而挂起的那次运行往往没有 complete 回报，只有事件路径能在释放子进程前把凭证存下来。读侧靠 claim 天然带回，park 走 `releaseTask(requeue:true)` 只改状态不动该列 → 下一次任何 bridge 领到它都拿得到同一个 `sessionId`，续跑不需要"谁挂起谁恢复"的隐性绑定。
- argv 安全是**三道闸共用一个字符集**（`^[A-Za-z0-9._-]{1,128}$` 且不以 `-` 开头）：解析器先筛掉不合格 id（不产 session 事件，因此一个坏 id 不会把整批上报 400），契约层 `engineSessionIdSchema` 兜住库与响应，适配器拼 argv 前本地再校验一次（任务行可能是旧数据），不合格就跳过续跑并记日志。`resumeArgs` 只给本仓已验证过形状的 preset：claude/qoder/cursor-agent → `--resume <id>`、opencode-run → `--session <id>`，其余 preset 不设——有 id 也只是忽略，不猜各家语法。位置在 prompt 之前、`extraArgs` 之后，与 `session.ts:buildChatRun` 一致。
- 事件是**旁路不是替换**：子进程字节仍逐字节进 `log-sink`（测试用 fake CLI 断原文与脚本 `FAKE_STDOUT` 完全相等），解析只从 stdout 分流结构，stderr 语义不变；未识别的行代价是"少一条事件"，永不包括"丢输出"。上报失败与 dashboard 同性质：瞬时错误留队列、永久错误（含任务已离开 CLAIMED 的 409）丢弃、只告警一次，任务照样跑完。
- **park 没有引入 `BLOCKED` 写入方，也没有就地 `wait`**：状态机维持 PENDING→CLAIMED→DONE/FAILED/CANCELLED，挂起走现网已有的 CLAIMED→PENDING 重排。就地等待答案会让任务挂在 CLAIMED 上占住该 env 的一个 `maxConcurrency` 槽（Step 1.3 把 PENDING/CLAIMED/HEALING 记为占用），而审批是人的事、可能几分钟也可能明天。ticket 的两个选项是 批准续跑/拒绝、`recommendedOption` 指向拒绝，`blockerQuestion` 带工具名与命令原文、`nextStepPlan` 带 resume 凭证；**建 ticket 失败也照常 release**（降级为日志），事件流水里人还看得到。顺序上先 `eventSink.close()` 再 release/complete，否则 409 会把 session 凭证永久丢掉。
- Hub 侧新表 `task_events`（DDL + 索引，老库 `CREATE TABLE IF NOT EXISTS` 即升级路径，已用只建过 `agent_tasks` 的旧库实测）；每任务保留最近 **500 条**（按条数而非字节，事件是定长小行）。`GET /api/tasks/:id/events` 与 logs 同形（`nextAfter`/`truncated`），本步 web 不渲染（延续"数据层留字段、UI 不先动"）。
- 测试：`packages/shared/test/engine-events.test.ts`（15 项：kind 决定必填、engine 与 `AGENT_KINDS` 同源、`reportTaskEventsSchema` 0/51 拒绝、字符集正反例含路径形状 id）、`packages/bridge/test/wake-events.test.ts`（25 项，纯 fixture：跨 chunk 半行、`end()` 冲尾行、超长行丢弃后仍能续读、一行两 `tool_use`、`control_request/can_use_tool`、顶层直白形状、opencode camel 别名、`none` 恒空）、`test/wake-event-sink.test.ts`（8 项：攒批/定时/瞬时重试/永久丢弃/溢出只告警一次/close 冲净）、`test/wake-adapters-events.test.ts`（7 项，脚本化 fake CLI：原文逐字节、`--resume` 落在 prompt 之前、坏 id 不上命令行、`{sessionId}` 占位不展开成空、`ZHUNZOU_SESSION_ID`、批准请求即终止子进程（脚本故意挂 5s，断言 3s 内返回且无 completion）、超时/FAILED 分支回归）、`test/wake-park.test.ts`（4 项：ticket+release 且不调 complete、ticket 失败仍 release、非 parked 不建 ticket、心跳不受影响）、`packages/server/test/task-events.test.ts`（8 项：落库回读与分页、**§6 端到端闭环**（session 事件→release→再次 claim 带回 `sessionId`）、无 session 事件不清空、409/404/403、坏批 400、Hub 重导 `outsideWorkspace`、600 条只剩 500、旧库升级）、`packages/shared/test/supervisor.test.ts` 补 1 项（端侧报 `outsideWorkspace:false` 不能把越界路径说成内的）。全仓 91 files / 782 tests（本步 +6 files / +68 tests）与 `pnpm typecheck` 全绿。

