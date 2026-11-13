# Step 2.2 设计：引擎事件归一化与 Session 断点续跑

蓝图条目：`CursorAdapter`（`--output-format stream-json` 提取 `tool_call` / `permission_required` / `sessionId`）与 `OpenCodeAdapter`（ACP 归一化）；挂起时记录 `sessionId` 并释放子进程，恢复决策后 `--resume <sessionId>` 原地续跑。

本文先核实现状，再定语义、落点与测试矩阵。**实现前本文为准，实现后与设计不符处在 PLAN.md §5「Step 2.2 落地说明」记录。**

---

## 1. 现状核实（2026-11-13）

| 事实 | 位置 | 对本步的意义 |
| --- | --- | --- |
| `agentTaskSchema.sessionId` 已在契约里（Step 1.1） | `packages/shared/src/schemas.ts:436` | 不需要新增字段，缺的是**写入方** |
| `agent_tasks.session_id` 列已建、`toTask` 已映射 | `db/client.ts:151`、`db/schema.ts:270` | 无需迁移 |
| 全仓没有任何地方给它写过值（`grep sessionId` 只命中读侧与 chat 表） | `repository.ts` | 本步要补唯一写入方 |
| `task_logs` 已有 `error_signature/diagnosis/diff_hash` 三列 | `db/schema.ts:298-315` | 事件**不**塞进日志表；两张表各管一件事 |
| `TASK_LOG_STREAMS = ['stdout','stderr','system']`，web 端按这三档渲染 | `constants.ts:83` | 加第四档是改**活的**枚举，代价大于建新表 |
| `POST /api/tasks/:id/log` 要求任务处于 `CLAIMED`，否则 409 `INVALID_TASK_STATUS` | `app.ts:1606-1621` | 事件路由照抄这个约束；客户端把 409 当永久失败 |
| `runProcess(..., { onOutput })` 按**任意字节块**回调，不是按行 | `wake/adapters.ts:76-110` | NDJSON 解析必须自带行缓冲，不能一行一 chunk |
| `session.ts:buildChatRun` 已经会给 cursor-agent/claude/qoder 拼 `--resume <externalId>`、给 opencode 拼 `--session <id>` | `session.ts:104-196` | 续跑 argv 的**形状**在本仓已被验证，任务侧只是复用同一形状 |
| `parseChatOutput` 从单个 JSON 取 `session_id`/`sessionId` | `session.ts:207-238` | 会话（chat）路径保持原样，本步不动它 |
| `permissionActionSchema` / `supervisorDecisionSchema` / WS `permission.request`、`supervisor.decision` 帧都已存在 | `shared/src/supervisor.ts`、`shared/src/realtime.ts` | 只有**契约**，没有消费者：`device-router.ts` 的 `handle()` 没有 `permission.request` 分支，落 `default: break` |
| 可用的挂起通道是 HTTP：`client.createTicket(...)` → `POST /api/tickets`，`client.decide(...)` → `POST /api/decisions`，MCP `agent_hub_escalate/wait` 走的即此路 | `hub-client.ts:193-242` | 本步的 park 用**已跑通的路**，不等新协议接线 |
| `releaseTask(taskId,{requeue,reason})` 存在，CLAIMED→PENDING | `app.ts:2144`、`repository.ts` | 挂起即释放，槽位还给调度器 |

结论：**协议不缺字段，缺的是三件实现**——把引擎输出读懂、把 `sessionId` 落库、把高危请求变成人能看到的东西。

---

## 2. 落点与本步边界

新增：

- `packages/shared/src/engine-events.ts`：归一化事件契约（单一真源，端侧与 Hub 共用）。
- `packages/bridge/src/wake/events.ts`：纯函数解析器（无 I/O、无 spawn）。
- `packages/bridge/src/wake/event-sink.ts`：事件批量上报（与 `log-sink.ts` 同族、同失败策略）。
- `task_events` 表 + `POST/GET /api/tasks/:id/events`。

改动（均为增量）：`wake/adapters.ts`（preset 加 `resumeArgs`、run 适配器接管道）、`wake/daemon.ts`（`reportEvent` 注入 + `parked` 处理）、`hub-client.ts`（`reportTaskEvents`）、`repository.ts`/`app.ts`/`db/*`。

**本步不做**（往后各归其位，避免同一件事写两遍）：

- WS `permission.request → supervisor.decision` 的消费者与 L1 规则引擎 → **Step 3.2**。本步只把事件变成 ticket，让**人**来判；Hub 不代判。
- 审批通过后的自动 `--resume` 续跑闭环（谁在等这个 ticket、决策到达后唤醒哪个 runner）→ **Step 3.3**。本步只保证「续跑需要的 `sessionId` 已经躺在任务上，下次 claim 一定带得走」。
- `zz run` 本地包壳 → **Step 2.3**。

蓝图把这一节写成两个新类 `CursorAdapter`/`OpenCodeAdapter`。本仓的适配器早已是 `PRESETS` 表 + `createPresetAdapter` 工厂（`wake/adapters.ts:215-330`），再造两个类就是同一件事两份实现，且要重写超时/截断/回退逻辑。**落地改为：一个解析器 + 每引擎一份 profile**，适配器工厂不动。这是有意的偏离，见 §5。

---

## 3. 事件契约（shared）

```ts
ENGINE_EVENT_KINDS = ['tool_call', 'permission_required', 'session']
```

三种，各自只有一个消费者，多一种就多一张要维护的表：

- `tool_call` —— 审计/上下文（Phase 3 的 L2 诊断读它）。
- `permission_required` —— 挂起触发器（本步建 ticket）。
- `session` —— 续跑凭证（本步落 `agent_tasks.session_id`）。

引擎自己结束时的 `result`/`error` 不进这个契约：完成回报走 `completeTask`，输出走 `task_logs`，再抄一份就有两个真值。

```ts
engineEventSchema = z.object({
  kind: z.enum(ENGINE_EVENT_KINDS),
  engine: z.enum(AGENT_KINDS).optional(),      // 谁产的，决定 resume 用什么 argv
  tool: z.string().trim().min(1).max(120).optional(), // tool_call / permission_required 的工具名
  sessionId: engineSessionIdSchema.optional(),  // 字符集即 argv 安全集，见 §6
  action: permissionActionSchema.optional(),   // 复用已有契约，不另造「要批准什么」的结构
})
  .superRefine(...)  // kind 决定必填：session→sessionId；tool_call→tool；permission_required→action 或 tool
```

**没有 `at`**：时间由 Hub 落库时盖 `created_at`，端侧再报一个就是两个时钟要对齐。

两个导出的类型名不是一回事，也不是冗余：`EngineEvent = z.infer`（Hub 存/读，`outsideWorkspace` 必为已判定）与 `EngineEventInput = z.input`（端侧上报，该字段可选）。同仓先例是 `CreateLearnedRuleInput = z.input<...>`。端侧永不声明自己是否越界——这个判定只在 Hub 重导一次。


`reportTaskEventsSchema = { events: engineEventSchema.array().min(1).max(50) }`（批量、有上限，一帧 64 KiB 预算装得下）。

`taskEventSchema`（读侧）＝ 事件字段 + `id/taskId/createdAt`。

---

## 4. 解析器语义

`createEventParser(profile)` → `{ push(chunk): EngineEvent[]; end(): EngineEvent[] }`

四条不可让步的规则：

1. **行缓冲**：跨 chunk 拼行；`\n` 切分，`end()` 冲掉无换行的尾巴。残留缓冲上限 64 KiB，超限的行按未识别处理并丢弃——一个吐二进制的子进程不能把解析器变成内存泄漏。
2. **不识别即忽略**：非 JSON、缺 `type`、profile 不认的形状，一律返回空数组，**不抛错、不改变原始输出**。原始字节始终原样进 `log-sink`，所以 profile 猜错的代价只是「少一条结构化事件」，不是「丢输出」。
3. **一行可产多事件**：claude/cursor 的 `assistant` 消息里 `message.content[]` 可以有多个 `tool_use`，逐个产出。
4. **纯函数**：不 spawn、不联网、不读文件——测试只喂字符串。

profile 表（`ENGINE_PROFILES`，键为 `WakeAdapterName`）：

| profile | 匹配 | 产出 |
| --- | --- | --- |
| `stream-json`（claude / qoder / cursor-agent / opencode-run） | `type:"system",subtype:"init"` 或任意带 `session_id`/`sessionId` 的行 | `session` |
| | `type:"assistant"` + `message.content[].type:"tool_use"` | `tool_call`（带 `tool=name`） |
| | `type:"control_request"` 且 `request.subtype:"can_use_tool"` | `permission_required`（`action` 由 `request.tool_name`/`input` 构造；构造不出 `command`/`paths` 时**只带 `tool` 名**、省略 `action`——`PERMISSION_ACTION_KINDS` 没有 `other`，不为一个降级分支去动 Step 3.2 要用的活枚举） |
| | 顶层 `type:"permission_required"` / `"permission_request"`（自建/未来引擎的直白形状） | `permission_required` |
| `opencode` | `sessionID`（camel，与 `parseChatOutput` 已验证的别名一致）+ `type:"tool_use"`/`"tool"` | `session` / `tool_call` |
| `none`（aider / goose / amp / codex / gemini / notify） | 不解析 | —— |

诚实标注：`control_request/can_use_tool` 与 `tool_use` 的形状来自各家 CLI 文档与本仓 `session.ts` 已在用的字段名（`session_id`/`sessionId`），**本机没有安装这些 CLI，无法用真进程验证**。因此三处冗余：别名集合可加不可换、未识别一律忽略、原始输出永不断流。测试用 fixture 字符串而非真实子进程，正是为了把「形状假设」和「管道行为」分开验证。

---

## 5. 上报路径

```
子进程 stdout/stderr
  ├─ 原文 → log-sink → POST /api/tasks/:id/log      （现状，一字不改）
  └─ 解析 → event-sink → POST /api/tasks/:id/events  （新增，旁路）
```

`event-sink.ts` 与 `log-sink.ts` 同策略，只是不必分三档流：600ms 或攒满 20 条冲一次，队列上限 200 条（溢出丢最旧并告警一次），瞬时失败留到下次重试，`HubApiError.retryable === false`（含任务已离开 CLAIMED 的 409）直接丢。**事件上报失败绝不能让任务失败**——它与 dashboard 同性质。

装点在 `createPresetAdapter`/`createCommandAdapter` 内（它们同时持有子进程与 `context.reportLog`），不在 `daemon.ts`：daemon 只提供 `context.reportEvent`，与现有 `reportLog` 对称。

---

## 6. Session 续跑

**写侧**：Hub 是 `session_id` 的唯一写入者，且只有一个入口——`POST /api/tasks/:id/events` 里 `kind:'session'` 那条。理由：(1) 列已存在但无人写，补一个入口即可；(2) 若 `completeTask` 也能带 `sessionId`，两处写、两处要判空、两处要测；(3) 挂起时任务往往**没有** complete，只有事件路径能在挂起前把它存下来。

同一事务里插 `task_events` 行 + 更新 `agent_tasks.session_id/updated_at`；不覆盖成空串（无 `sessionId` 的事件不动那一列）。

**读侧**：`sessionId` 在 `agentTaskSchema` 上，claim 响应天然带回。**关键收益**：park 走的是 `releaseTask(requeue:true)`，状态回 PENDING，列不动 → 下一次任何 bridge claim 到它，都拿得到同一个 `sessionId`。续跑不需要「谁挂起就谁恢复」这种隐性绑定。

**argv**：preset 增 `resumeArgs?: (sessionId) => string[]`。

- `claude` / `qoder` / `cursor-agent` → `['--resume', id]`
- `opencode-run` → `['--session', id]`（`session.ts:119-127` 同形状，已被现网会话验证）
- 其余 preset 不设 → 有 `sessionId` 也只是忽略，不猜各家语法。

位置在 prompt **之前**、`extraArgs` 之后，与 `session.ts` 一致。

**安全**：`sessionId` 最终来源是子进程输出，属不可信输入，两道闸同用一个字符集 `^[A-Za-z0-9._-]{1,128}$` 且不以 `-` 开头：解析器**先**用它筛掉不合格的 id（不合格就不产 `session` 事件，因此不会让整批事件被 Hub 400），契约层 `engineSessionIdSchema` 再兜一次，保证库里与响应里都不会出现带空格的 id；适配器拼 argv 前仍本地校验一次（任务行可能是旧数据），不通过就跳过续跑并记一条 system 日志。与 Step 2.1 的 `assertRef`/`TASK_ID` 同一手法：只走 argv，绝不拼 shell 字符串。`command` 适配器给模板加 `{sessionId}` 占位，值经 `shellQuote`。

---

## 7. `permission_required` 的挂起语义

适配器侧：管道产出 `permission_required` → (1) 置 parked 标记；(2) `AbortController` 终止子进程（SIGTERM，2s 后 SIGKILL，即 `runProcess` 现有超时杀法）；(3) 返回 `{ delivery, parked:{ reason, action? } }`，**不带** `completion`。

`runProcess` 相应增 `signal?: AbortSignal`（瞬时完成，不改变既有调用者行为）。

daemon 侧：`outcome.parked` → (1) `client.createTicket({ doneSummary, blockerQuestion, nextStepPlan, options:[批准/拒绝], recommendedOption:'拒绝' })`——选项文案里带上工具名与命令，人不用登机器就能判；(2) `client.releaseTask(taskId,{ requeue:true, reason })`。

为什么不就地 `wait` 等答案：任务挂在 CLAIMED 上会占住该 env 的一个 `maxConcurrency` 槽（Step 1.3 把 PENDING/CLAIMED/HEALING 记为占用），而审批是人做的事，可能几分钟也可能明天。释放回队列、把凭证留在 `sessionId` 上，才与「释放子进程」这句蓝图要求同构。

ticket 建失败也不升级成任务失败：降级为日志 + 照常 release，人还能从事件流水里看到。

**不动状态机**：本步不引入 `BLOCKED` 写入方（蓝图里它属于熔断/托管语义，Step 3.3 再论），parked 任务走的就是现网已有的 CLAIMED→PENDING 重排。

---

## 8. Hub 侧存储

```sql
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  engine TEXT,
  tool TEXT,
  session_id TEXT,
  action TEXT,           -- permissionActionSchema 的 JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);
```

DDL 字符串 + `ensureColumn` 双写（新库靠 DDL，老库靠 `CREATE TABLE IF NOT EXISTS` 本就在 DDL 里，无需 `ensureColumn`；但 `agent_tasks.session_id` 早在 Step 1.2 已 `ensureColumn`，此处只验证其行为）。

每任务保留最近 500 条事件，超出丢最旧（同 `MAX_TASK_LOG_BYTES` 的思路，但按条数——事件是定长小行）。

读侧 `GET /api/tasks/:id/events?after&limit` 与 logs 同形（`nextAfter`/`truncated`）。本步 web 不渲染它（延续「数据层留字段、UI 不先动」的既定偏好），但数据不可达等于没存，所以读路由一起给。

---

## 9. 测试矩阵

### `packages/shared/test/engine-events.test.ts`
- `kind:'session'` 缺 `sessionId` / `tool_call` 缺 `tool` / `permission_required` 既无 `action` 又无 `tool` → 拒绝。
- `engine:'claude-code'` 接受、`engine:'foo'` 拒绝（与 `AGENT_KINDS` 同源）。
- `action` 内嵌 `permissionActionSchema` 的越界改写仍生效（`outsideWorkspace` 由 Hub 侧重导）。
- `reportTaskEventsSchema`：0 条拒绝、51 条拒绝、50 条通过。
- 未加 `sessionId` 时 `agentTaskSchema` 依然通过（不破坏既有 14 处引用）。

### `packages/bridge/test/wake-events.test.ts`（纯 fixture）
- 单行 NDJSON → 1 事件；一行两 `tool_use` → 2 事件。
- 跨 chunk 半行（`{"type":"sys` + `tem","session_id":"x"}`）→ 只有拼完整那一次产出。
- `end()` 冲掉无换行尾行。
- 非 JSON 行 / 未知 `type` / 空行 → 返回 `[]` 且不抛。
- 超长行（>64 KiB 无换行）→ 丢弃并继续解析后续行（内存有界）。
- `control_request` + `can_use_tool` → `permission_required` 且 `action.command` 落位。
- `permission_required` 顶层直白形状 → 同一 kind。
- `opencode` profile 的 `sessionID` camel 别名 → `session`。
- profile=`none`（aider 等）→ 任何输入都 `[]`。

### `packages/bridge/test/wake-event-sink.test.ts`
- 20 条攒批：一次 POST 带 20 条；600ms 定时器冲未满批。
- 瞬时失败（NETWORK）→ 留在队列，下次带上；永久失败（retryable=false）→ 丢弃且不重发。
- 队列 >200 → 丢最旧，只告警一次。
- `close()` 冲干净；`close()` 后 `push` 无效。
- 上报抛错不冒泡到调用方。

### `packages/bridge/test/wake-adapters-events.test.ts`（注入 fake runner，不 spawn）
- 引擎输出被解析后：原文仍**逐字节**进 `reportLog`，事件进 `reportEvent`（旁路不截断，§4 规则 2）。
- `task.sessionId` 存在且 profile 支持 → argv 含 `--resume <id>`，且在 prompt 之前。
- `sessionId` 为 `../../-x` 或以 `-` 开头 / 超 128 → 跳过续跑并记日志，**不注入 argv**。
- `command` 模板 `{sessionId}` → 经 `shellQuote` 展开；未设 `sessionId` 时保留原占位不炸。
- 出现 `permission_required` → 子进程被 abort、`outcome.parked` 有 reason、`outcome.completion` 为 undefined。
- 无事件 → 行为与 Step 2.1 时的适配器完全一致（回归：超时/DONE/FAILED 三分支不变）。

### `packages/bridge/test/wake-park.test.ts`（daemon 循环，stub client）
- parked → `createTicket` 一次（选项含批准/拒绝、`recommendedOption` 指向拒绝、文案含工具名）+ `releaseTask(requeue:true)`，且**不**调 `completeTask`。
- `createTicket` 抛错 → 仍 `releaseTask`，日志说明降级。
- 非 parked → 完全不建 ticket（守护现状）。
- 心跳/存在性上报不受影响。

### `packages/server/test/task-events.test.ts`
- `POST /api/tasks/:id/events`（CLAIMED）→ 201、落库、`GET /events` 读回；`after` 分页与 `truncated`。
- `kind:'session'` 事件 → `GET /api/tasks/:id` 的 `task.sessionId` 可见；随后再次 claim（`GET /tasks/next`）响应里带 `sessionId`。**这是 §6 端到端闭环**。
- 非 CLAIMED → 409 `INVALID_TASK_STATUS`；未知任务 → 404；跨 env token → 403（`requireEnvAccess`）。
- 无 `sessionId` 的事件不清空已存的 `session_id`。
- 事件带 `action` → 读回时结构保留（Hub 侧重导 `outsideWorkspace` 生效）。
- >50 条 → 400；老库升级路径：只建 `agent_tasks` 的库上 `task_events` 仍可用。
- 600 条写入 → 表内只剩 500（丢最旧）。

### 全量
`pnpm --filter @zhunzou/shared build` 后 `pnpm typecheck` + `pnpm test` 全绿；既有 714 项测试**不允许修改断言**（除构造 `WakeConfig`/fake 时补上新必填字段），改动即视为破坏既有行为，需回退。
