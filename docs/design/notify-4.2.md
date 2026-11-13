# Step 4.2 设计：BLOCKED/DONE 推送 · 飞书与企微卡片 · 签名深链

蓝图出处：`PLAN.md:75`。目标一句话——**手机上一条通知就能把卡住的任务放行、把批过的决定记成规则，但 Hub 自始至终不碰 git、不发出一个能改状态的 GET。**

## 1. 现状核实（逐条可验证）

| # | 事实 | 证据 |
|---|---|---|
| 1 | `Notifier.send(message)` 只吃 `NotificationMessage{title,text,ticket,approvalUrl?}`，而 **`ticket` 是必填**；现有 8 个渠道构造器只读 `title/text/approvalUrl` 三个字段 | `server/src/notifications.ts:10-22,31,64,102-254` |
| 2 | `notifyTicketPendingHuman` 是 fire-and-forget（`Promise.allSettled` + 失败只 `warn`），签名只收工单；5 个调用点全在**工单转人工**时。任务侧 BLOCKED/DONE **一条通知都没有** | `notifications.ts:292-323`、`app.ts:591,658,691,708,2026` |
| 3 | BLOCKED 只有两个生产点，都在 `healFailure` 里：熔断 `app.ts:846`、升级 `app.ts:861`。两处都已经 `writeHealRow` + `taskBus.publish`，唯独没 notify；诊断文本（`breakerReason` / `diagnosisSummary`）和 `evidence.lastSignature` 就在手边 | `app.ts:833-889`、`supervisor/healer.ts:36-38,109-133` |
| 4 | DONE 有两个生产点：HTTP `POST /tasks/:id/complete`（`app.ts:1791-1815`，**bridge 实际走这条**，`bridge/src/hub-client.ts:399`）与 WS `task.complete`（`realtime/device-router.ts:216-240`）。两条都直接 `repo.completeTask` 后返回，都不通知；WS 那条连 `healFailure` 都不触发 | 同上，`healFailure` 唯一调用点是 `app.ts:1802` |
| 5 | 审批 token 只签工单：`${ticketId}.${expiresAt}` + HMAC，`verifyApprovalToken` 要求**恰好 3 段**且首段匹配 `/^[1-9]\d*$/`。任何带命名空间前缀的新 token 会被这段既有校验天然拒掉 | `server/src/approval-link.ts:15-45` |
| 6 | HTML 页面族（`layout`/`escapeHtml`/`riskLabel`）是 approval-link.ts 的私有函数，两张结果页共用。任务页不放同文件就是要复制一份转义壳 | `approval-link.ts:51-116,118,181` |
| 7 | destructive 选项在页面上是 checkbox，服务端 `POST /a/:token/resolve` **二次把关**（没确认就退回重选）。所以"一条 URL 直接批准"必须放弃——它绕过的正是这道把关 | `app.ts:1277-1295`、`approval-link.ts:renderApprovalPage` 的 `confirm` 块 |
| 8 | 渠道是 `parseNotificationChannels` 从环境变量映射的 8 分支可辨识联合；`createNotifiers` 的 switch 无 default（靠 TS 穷尽）。未知渠道的报错串被 `test/config.test.ts:100` 用**宽松正则** `/unknown notification channel/` 断言——追加 `wecom` 不会撞红 | `config.ts:32-40,220-297`、`config.test.ts:100` |
| 9 | 飞书构造器**只发** `msg_type:'text'`；既有测试钉住"无按钮时仍是 text" | `notifications.ts:148-163`、`notifications.test.ts:112-116` |
| 10 | **`rulesStore` 与 `learned_rules` 是两份东西**：accept 候选只 `rulesStore.append`（人读的则例）+ `markRuleCandidate('ACCEPTED')`；L1 风控读的是 `repo.listLearnedRules`（表）。则例文件的消费者是总管预审的提示词 | `app.ts:3182-3183`、`app.ts:576`、`app.ts:629` |
| 11 | `distillRule` 在 3 个批准出口后被 `void` 调用；`createRuleDistiller` 在 `provider==='none'`、缺 key/endpoint、以及调用失败时都返回 `fallbackRule(ticket)` —— **没有 LLM 也能产出一条规则文本**，"记住"不会承诺空动作 | `app.ts:1307,1534,1611`、`rule-distiller.ts:185-201` |
| 12 | 人工放行的 HTTP 版是 admin-only：`reopenTask` BLOCKED→PENDING + 一行 `人工放行：…` 系统日志 + `taskBus.publish`，非 BLOCKED 抛 409 `INVALID_TASK_STATUS`。签名链接不可能携带 admin token，所以任务页要有自己的 release 路由，但**写口径必须与这条一致** | `app.ts:2463-2490` |
| 13 | 工单表有 `task_id` 列和索引，但**没有按 taskId 查工单的仓储方法**（`repository.ts` 里 grep 无命中） | `db/schema.ts:44,69` |
| 14 | `SupervisorInboxItem` 已经把 `diagnosis`/`errorSignature`/`branch` 投影好了，`branch` 的来源正是 `shared` 的 `wipBranchName(task.id)`，只在 `workspacePath` 存在时给出 | `shared/src/schemas.ts:578-588`、`repository.ts:3484-3495` |
| 15 | 通知面在测试里可注入：`BuildAppOptions.notifiers`（默认 `createNotifiers(config.notifications, app.log)`）；`DeviceRouterOptions` 只有 `config/repo/gateway/三条 bus/onChanged`。既有通知测试一律注入 `fetchImpl`，不用 `vi.stubGlobal` | `app.ts:210,380`、`realtime/device-router.ts:19-27`、`notifications.test.ts:41-62` |
| 16 | web 收件箱里「人工放行」已经是真按钮（调 `POST /tasks/:id/retry`），4.2 要做的只是把同一件事搬到手机上；则例的两步式（批准 → 候选 → 记住）也已经在 HistoryList | `docs/design/console-4.1.md` §2.2 |

## 2. 落点

### 2.1 `shared`：只加一个可选请求字段

- `resolveTicketSchema` 加 `rememberRule: z.boolean().optional()`。这是 `POST /api/tickets/:id/resolve` 的**请求体契约**，所以属于 shared；`ResolveTicketInput` 随之变宽，web 的调用一行不改（可选字段，事实 16）。
- 通知的消息形状**不进 shared**：它是 server→渠道的私有编码，web 从不消费。动作、卡片、深链全留在 `server/src/notifications.ts`。

### 2.2 `server/notifications.ts`：消息族从"一张工单"扩成"一件欠人看一眼的事"

- `NotificationMessage`：`ticket` 改**可选**，新增可选 `task`、`actions`、`refUrl`（看板收件箱深链）。按既有口径，缺席的键就是缺席，不注入 `undefined`。8 个既有渠道构造器一行不改也照常工作（事实 1）；只有飞书与新增的企微读 `actions`。
- `NotificationAction = { label: string; url: string }`——卡片按钮只能是跳转（§3 解释为什么不能是回传）。
- `buildTaskNotificationMessage(task, facts)`：`facts = { kind:'blocked'|'done', diagnosis?, errorSignature?, branch?, workspacePath?, approvalUrl?, refUrl? }`。
  - blocked 标题 `【准奏 · 卡住了 #id】<project>`，正文 = 来源 env / 任务标题 / 管家一句话 / 错误特征 /（隔离工作区时）分支 + 路径 / 动作提示。
  - done 标题 `【准奏 · 完工 #id】<project>`，正文含**引擎原话** `task.result`，不给它编摘要。
  - `actions` 只在 `approvalUrl` 存在时给出 `批准继续`；`refUrl` 存在时给出 `看看板`。
- **唯一的 fan-out**：私有 `fanout(notifiers, message, logger, ref)`（`Promise.allSettled` + warn，逐字照抄现状）。`notifyTicketPendingHuman` 保留原签名、内部改为构造消息后走 `fanout`——**5 个调用点与 `notifications.test.ts:161` 一条不改**；新增 `notifyTaskBlocked/notifyTaskDone`（或直接一个 `notifyTask`）同样走它。
- 飞书：`actions` 非空 → `msg_type:'interactive'` 卡片（`header` + `div/markdown` + 每个 action 一个 `{tag:'button', ... url}`）；`actions` 为空 → 维持 `msg_type:'text'`（事实 9，既有断言原样绿）。
- 新增 `wecom` 渠道：`{ type:'wecom', url }` + `WECOM_WEBHOOK_URL`。改动面 = `config.ts` 联合 +1 分支、switch +1 case、报错串追加一个名字、`notifications.ts` +1 构造器、`.env.example` / `README.md` / `README.zh-CN.md` / `docs/PLUGINS.md` 的渠道清单同步。发 `msgtype:'markdown'`（群机器人没有按钮交互，`[文本](url)` 是它能表达的最接近卡片的东西），分支名与路径放代码块里。

### 2.3 `server/approval-link.ts`：任务侧深链与工单侧同名不同域

- `buildTaskApprovalToken(taskId, expiresAt, secret)` 签 `task.${taskId}.${expiresAt}`，`verifyTaskApprovalToken` 要求**恰好 4 段**、首段字面量 `task`、次段匹配 `/^[1-9]\d*$/`，同样 `timingSafeEqual`。工单 token 一字节不变（事实 5），两种 token 互不通用由段数天然挡死——不需要改 `verifyApprovalToken` 一行。
- `renderTaskApprovalPage(...)` 放同文件，复用私有 `layout`/`escapeHtml`（事实 6）。内容 = 任务标题 + env + 管家的话 + 错误特征 +（隔离）分支/路径只读展示 + 可选补充指令 + 一颗「批准继续」。
- 结果页直接复用现成的 `renderApprovalResultPage`，不另起一套文案。

### 2.4 `server/app.ts`：三个时刻接上通知，一个开关接上"记住"

- **BLOCKED**：`app.ts:846`（熔断）与 `:861`（升级）之后各发一次，diagnosis 用当下已在手的原因/摘要，`errorSignature` 用 `evidence.lastSignature`，分支按 `task.workspacePath` 判定（与事实 14 同口径）。
- **DONE**：抽一个局部 `announceTaskSettled(task)`，HTTP 完成路径与 WS `handleTaskComplete` **都调它**。`DeviceRouterOptions` 加可选 `onTaskSettled?: (task: AgentTask) => void`——比把 notifiers/config 搬进 realtime 面更小，且没有回调时行为与今天完全一致（事实 15）。
- **`GET /t/:token`**（无 admin，凭签名）+ **`POST /t/:token/release`**：release 走与事实 12 相同的写口径（`repo.reopenTask` + 同一行 `人工放行：…` 日志 + `taskBus.publish` + `refreshSyncFingerprint`）；状态非 BLOCKED → 与工单页一致的「已处理」结果页（事实 4 的 DONE 不签链接，也就没有第二条动作路由）。
- **记住规则**：`distillRule(ticket, { accept })`。`accept===true` 时把刚创建的候选立刻走 accept 路由的**同一写作路径**——抽出局部 `adoptRuleCandidate(candidate)`（`rulesStore.append` + `markRuleCandidate('ACCEPTED')`），路由与蒸馏共用一个实现。`POST /a/:token/resolve` 的表单多一颗 `<button type="submit" name="rememberRule" value="true">准奏并记住规则</button>`；`approvalResolveSchema`（`app.ts:193`）加 `rememberRule: union([string,boolean]).optional()`，按 `confirmDestructive` 已有的 `=== 'true'` 口径归一。
  - 诚实边界写进文案与日志：规则进的是**则例文件**（总管预审读，事实 10），不是 L1 的正则表；蒸馏返回 `null`（模型明确说 SKIP）时无规则可记，`app.log.info` 记一条 `nothing to remember`，不静默。

### 2.5 `web`：本步零改动

`rememberRule` 是可选字段，`api.resolveTicket` 的类型自动变宽；手机端要的"一步式"在 web 上不引进——那里已经有候选列表可看，两步（批准 → 在御览页确认）比一步更合适（事实 16）。因此 4.2 不碰 web 的任何组件、store 与测试。

## 3. 明确不做

- **Hub 不跑 git**（用户决定："只给合并信息，不动 git"）：卡片与任务页只给 `wip/zz-<id>` 分支名 + 节点上报的 `workspacePath`；真合并留在节点上的 `bridge/src/git/worktree.ts`。蓝图里那颗 `[一键 Squash 变基合并]` 在 4.2 落地为"看到合并信息"。
- **不做 GET 直批**（事实 7）：签名 URL 只把人送到页面，最后一下永远是页面上一次 POST——否则 destructive 确认形同虚设。
- **不做卡片回传（interactive callback）**：那要求企业自建应用 + AES 加解密 + 事件回调地址，而配置面只有一个 webhook URL（事实 8）。所以卡片按钮一律 `open_url`。
- 不给 DONE 签任务深链（没有待批动作），也不给 BLOCKED 任务做"批准并记住规则"——那是工单语义，需要按 `task_id` 查工单，这条查询今天不存在（事实 13），为它新开读路径不属于本步。
- 不改 WS `task.complete` 的 FAILED 不自愈（事实 4）：那是 transport 覆盖面的历史欠账，本步只补通知，补完记进 §7。
- 不做通知重试/退避：`postJson` 只有 5s 时间箱（`notifications.ts:77-100`），失败只 warn。投递可靠性是独立一步。
- 不改既有 5 个 `notifyTicketPendingHuman` 调用点、`notifications.test.ts` 既有 5 个 `it`、`config.test.ts` 既有断言。

## 4. 测试矩阵

> 落地时的编号更正：原计划的 `H.` 改叫 `U.`（`api-healer.test.ts` 已经占用 H1…H6，同系列字母撞车比换个字母贵）；
> `K.` 落在既有的 `approval-link.test.ts` 里追加 describe，不新建纯函数文件——同一份 secret/BASE 的夹具只维护一处。

### N. `server/test/notifications.test.ts`（追加 describe，既有 it 不动）

| id | 输入 | 期望 |
|---|---|---|
| N1 | `buildTaskNotificationMessage(blockedTask, facts)` | 标题含 `#77` 与"卡住"；正文含诊断、错误特征、`分支：wip/zz-77`、`工作区：…`；`ticket` 键**缺席**（`'ticket' in message === false`），不是 `undefined` |
| N2 | 同一条 blocked，给 / 不给链接 | 有链接时 `actions` 恰为 `[批准继续, 打开看板]`；都不给时 `actions` 键**缺席** |
| N3 | done 消息 | 标题含"完工"；正文含 `引擎结论：<task.result 原文>` 且不含"管家诊断"；`actions` 只有 `合并信息` |
| N4 | 同一条 blocked 打到通用 webhook | `type:'task.blocked'`、`task` 在、`ticket` 键缺席、`actions` 透传；`buildWebhookPayload(ticket)` 仍是 `ticket.pending_human` |
| N5 | 同一条工单消息带 / 不带 actions，打到 bark·slack·discord·ntfy·telegram | body **逐字节相同**——钉住"扩展对纯文本渠道是加法"（通用 webhook 会多出 `actions`，所以 N4 单独测它） |
| N6 | feishu | 无 actions 仍 `msg_type:'text'`；有 actions 变 `interactive`，header 标题＝消息标题，action 落成 `{tag:'button', url}` |
| N7 | wecom | 有链接：`msgtype:'markdown'`、含分支与 `[批准继续](…)`；无链接：正文恰为 `**标题**\n\n正文`，不出现尾随 `](` |
| N8 | `notifyTaskOutcome` 中一个渠道 503 | 不抛、`warn` 带 `{channel:'wecom', ticket:'#77'}`、另一个渠道照发 |

### C. `server/test/config.test.ts`（追加）

| id | 输入 | 期望 |
|---|---|---|
| C1 | `NOTIFY_CHANNELS=wecom` 与别名 `wechatwork` + `WECOM_WEBHOOK_URL` | `[{type:'wecom',url}]` |
| C2 | `NOTIFY_CHANNELS=wecom` 缺 URL | 抛错含渠道名（`requireValue` 口径） |
| C3 | 未知渠道 | 既有宽松正则仍绿；报错串里能看到 `wecom` |

### K. `server/test/approval-link.test.ts`（追加 `signed task link`，既有 it 不动）

| id | 输入 | 期望 |
|---|---|---|
| K1 | `buildTaskApprovalToken` → `verifyTaskApprovalToken` | 4 段、首段 `task`，往返得到 `{taskId,expiresAt}`；过期 / 错 secret / 尾部篡改都 `null`；`buildTaskApprovalUrl` 指向 `/t/` |
| K2 | 任务 token 喂 `verifyApprovalToken`；工单 token 喂 `verifyTaskApprovalToken` | 两者都 `null`（双向不可互用） |
| K4 | 工单 token 固定 secret+expiresAt | 与实现前**逐字节相同**的黄金串（防"顺手改签名口径"） |
| K5 | `renderTaskApprovalPage` 带 `<script>` 的诊断与路径 | 转义后输出，原文不出现；表单 action 指向 `/t/<token>/release`，按钮文案「批 准 继 续」 |
| K6 | 同一页面 | `<form>` 恰一个、不出现 `/merge`·`/squash`、明写"Hub 不代为执行" |

### U. `server/test/api-task-notify.test.ts`（新，注入假 notifiers，事实 15）

| id | 场景 | 期望 |
|---|---|---|
| U1 | 同一失败三轮 → 熔断 BLOCKED | 恰好一条 blocked 通知，正文含"已自愈 3 次"、`approvalUrl` 含 `/t/task.`；把这条链接喂 `GET` 能得到同一任务的页面 |
| U2 | healer 判 `ESCALATE_TO_HUMAN` → BLOCKED | 通知正文引用**管家诊断**，不引用引擎结论 |
| U3 | healer 判 `RETRY_WITH_FIX` → HEALING | **零通知**（还没到人） |
| U4 | HTTP `POST /tasks/:id/complete {DONE}` | 一条 done 通知，含 `result`；`actions` 只有看板 `?tab=inbox`，`approvalUrl` 不存在 |
| U4b | `POST /tasks/local`（LOCAL_WRAP）跑完 DONE | **零通知**——人就在自己终端前 |
| U5 | WS `task.complete` DONE（真 `/ws/bridge?env=` 帧） | 与 U4 同一条通知（两条 transport 同口径） |
| U6 | 未配 `PUBLIC_BASE_URL` 的 BLOCKED | 通知照发，`approvalUrl`/`actions` 键都缺席、不报错 |
| U7 | `notifiers=[]` | 全流程状态照常到 BLOCKED，不炸 |
| U8 | 完成时上报 `workspacePath` | 正文出现 `分支：wip/zz-<id>` 与工作区行，`actions` 两个标签齐 |

### P. `server/test/api-task-approval.test.ts`（新，签名页面路由）

| id | 场景 | 期望 |
|---|---|---|
| P1 | `GET /t/<valid>`（BLOCKED） | 200 HTML，含任务标题、诊断、错误特征与「批 准 继 续」 |
| P2 | `GET /t/<expired>` | 410「链接已失效」，任务状态未变 |
| P3 | `POST /t/<valid>/release` | BLOCKED→PENDING 且 `retryCount` 归零；`task_logs` 末行 `人工放行：重新排队，自愈次数归零`；结果页「已放行」 |
| P4 | 同一 token 第二次 release | 409 结果页，任务仍是 PENDING（第二次不改状态）；再 `GET` 显示"这桩活不用放行" |
| P5 | 工单 token 打到 `/t/`、任务 token 打到 `/a/` | 各 410，不动任务也不动工单 |
| P6 | release 带补充指令 | 日志行含指令原文（截断由 schema 管） |
| P7 | 全程不带任何 API token | 仍能放行——凭据就是签名本身；`verifyTaskApprovalToken` 是唯一把关 |
| P8 | token 尾部篡改 / token 指向不存在的任务 | 410 / 404「任务不存在」 |

### R. `server/test/api-remember-rule.test.ts`（新，"批准并记住规则"）

| id | 场景 | 期望 |
|---|---|---|
| R1 | `POST /tickets/:id/resolve {rememberRule:true}` | 候选 `ACCEPTED`、`GLOBAL_RULES.md` 的「历史批复沉淀」段落含该条（落盘会去掉句末标点，故断言规范后的整行）、工单 `HUMAN_RESOLVED` |
| R2 | 同上但 `rememberRule` 缺省 | 候选仍是 `PENDING`、则例文件未被创建（既有行为，一条断言不改） |
| R3 | distiller 返回 `null` | 无候选、则例文件未写、不抛——蒸馏器说 SKIP 就真的什么都不留 |
| R4 | `GET /a/<token>` 页面 + 表单带 `rememberRule=true` | 页面出现第二个按钮 `name="rememberRule"`；提交后同 R1（页面与 REST 两条入口同效果） |
| R4b | 同一页面只按「准 奏」 | 候选 `PENDING`、则例文件未写 |
| R5 | 则例文件写不进去（`GLOBAL_RULES_PATH` 落在一个普通文件下面） | 批准本身照常 200 且状态是 `HUMAN_RESOLVED`，候选停在 `PENDING`，那个普通文件没被动过 |
| R6 | R1 之后查 L1 | `listLearnedRules()` 仍为空——"记住"喂的是判例文档，不是 L1 放行表 |

## 5. 验收口径

`pnpm -r typecheck` + `pnpm test` 全绿；`packages/server/test/notifications.test.ts` 既有 5 个 `it`、`config.test.ts` 既有断言、`bridge-claims.test.ts` 既有帧测试**一条不改**；工单 token 的字节格式与 `/a/:token` 路由行为不变；`grep -rn "simplegit\|child_process" packages/server/src` 不出现新命中（Hub 不跑 git）。
