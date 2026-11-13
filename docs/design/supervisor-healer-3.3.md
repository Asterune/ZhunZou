# Step 3.3 设计：`supervisor/healer.ts` L2 诊断与熔断

蓝图出处：`PLAN.md:71`。目标一句话——**任务失败后，能被证据判死的循环 0ms、0 Token 直接熔断；判不死的才花一次 Token 问模型；模型说"再试一次"时，改的是任务的下一步，不是任务的过去。**

## 1. 现状核实（2026-11-13，逐条带证据）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 失败今天**没有任何后续动作** | `POST /tasks/:id/complete` 写完就 `return {task}`（`app.ts:1690-1699`，路由体内不 publish）；`agent_tasks` 侧 `status='FAILED'` 只出现在 `releaseTask`（`repository.ts:3528`）与状态别名表（`:148`），2897/2948 两处属聊天消息 |
| 2 | `retryCount` 三层齐备但**零写零读** | 契约 `shared/src/schemas.ts:440`（注释已写明"L2 self-healing retries so far; the circuit breaker compares it to its ceiling"）；列 `db/schema.ts:278`、DDL `db/client.ts:153`、升级 `:394`；`repository.ts:351` 只做 `?? 0` 读取，建任务时写死 0（`:3297`、`:3332`） |
| 3 | `HEALING`/`BLOCKED` 的语义**契约里已经写好**，本步是第一个写入方 | 注释见 `constants.ts:58-61`（"The supervisor ordered a retry; the engine resumes the same session"）；占用统计已把 HEALING 算作占额度、BLOCKED 不算（`repository.ts:3557-3566`，说明在 `:744-746`）；web 已有样式与活跃判定（`packages/web/src/lib/format.ts:34-56`）；`shared/test/task-record.test.ts:60-65` 锁住非终态与 attention 归属 |
| 4 | 但 `claimNextTask` 只认 PENDING | `repository.ts:3422-3449`（候选查询 `eq(status,'PENDING')`）——所以今天 HEALING 是一个"计入占用、无人领取"的死状态。全仓**没有**任何测试锁住"HEALING 领不走"（`grep -rn HEALING packages/*/test` 只命中 shared 的协议形状用例） |
| 5 | 三个诊断列在 `task_logs`，本步之前只有 `error_signature` 有写入方 | 列 `db/schema.ts:307-312`、升级 `db/client.ts:407-409`、上报契约 `appendTaskLogSchema` 已含三字段（`schemas.ts:582-588`）；3.1 只把 `errorSignature` 接进 `sanitizer.describe()` → `log-sink.ts:69` → `send(stream, chunk, meta)`；`diagnosis`/`diffHash` 空着等本步（1.2 的记录 `PLAN.md:118` 原话："熔断比较的是日志行而不是任务行"） |
| 6 | 相似度算法**已存在**且已被决策路线使用 | `repository.ts:545-577` `textSimilarity`（去空白标点 + 字符 bigram + `overlap / min(size)`），`findSimilarTickets` 用它给 Meta-Agent 找判例。本步复用，不新造第二套相似度 |
| 7 | 日志按**字节预算**从最旧开始裁 | `MAX_TASK_LOG_BYTES = 256 * 1024`（`repository.ts:152`）、`trimTaskLogs`（`:2218-2245`）；`listTaskLogs` 单次上限 500 行（`schemas.ts:592`）。裁最旧 ⟹ 本步要的"最后一次签名/最后一次诊断"永远在保留窗口内，而"最早几次"可能已经不在——条件必须写成"够两条才比" |
| 8 | 已有**第二个 LLM 调用方**的先例可照抄 | `rule-distiller.ts`：自带接口（`RuleDistiller`）、自带工厂 `createRuleDistiller(config.metaAgent, fetch, app.log)`、复用 `meta-agent.ts` 的 `buildRequestHeaders`、有确定性兜底 `fallbackRule`；注入点 `app.ts:363-365`，与 `options.metaAgent ?? createMetaAgent(...)`（`:361-362`）同形。**不动 `MetaAgent` 接口**——它被 30+ 个测试替身实现，加方法会波及全部工单用例 |
| 9 | L2 的输出契约**已经存在且严格** | `supervisorDiagnosisSchema`（`shared/src/supervisor.ts:62-75`）：`.strict()`、`decision ∈ {APPROVE, RETRY_WITH_FIX, ESCALATE_TO_HUMAN}`（注释：灰区永不自动拒绝，所以 DENY 不在候选里）、`diagnosisSummary ≤ DIAGNOSIS_SUMMARY_MAX_CHARS = 50`（`constants.ts:313`，此前只有契约自己在用）、`RETRY_WITH_FIX ⇒ fixPrompt` 必填；`shared/test/supervisor.test.ts:68-103` 已锁四条 |
| 10 | 记录侧契约允许 L2 带 fixPrompt，只禁 L1 带 | `supervisorDecisionSchema`（`supervisor.ts:80-106`）；`:92-98` 拒 `layer:'L1' + fixPrompt`，`:99-105` 拒"RETRY_WITH_FIX 没有 fixPrompt" |
| 11 | 续跑凭据已经在任务行上 | `session_id` 列（`db/schema.ts:272` 注释"kept so the next claim can resume"）由 `reportTaskEvents` 镜像；`completeTask` 不清 `sessionId`（`repository.ts:3463-3474` 只写 status/result/workspacePath/completedAt）；引擎侧 `--resume` 已接（`wake/adapters.ts`）。所以"重跑接上同一条会话"不需要新协议 |
| 12 | 但 Hub **没有**任何"下次领取时额外带给引擎的话"的通道 | 提示词只有 `task.instruction` 一个来源（`bridge/src/wake/prompt.ts:17-48` 两个 builder 都只吃 instruction）；领取响应体只有 `{task}`（`schemas.ts:1097`）；`customInstruction` 只在**本地托管**路线被读（`wrappers/runner.ts:384`、`format.ts:21-22`），派单路线不读工单 |
| 13 | 领取是带状态守卫的乐观更新，且**先读后写** | `repository.ts:3424-3445`：先 `select` 候选行，再 `update ... where status='PENDING' returning`。注意 `.returning()` 给的是**更新后**的行——要在领取时投递一次性载荷，必须从先读到的候选行取，不能从 returning 取 |
| 14 | `diffHash` 只能由节点算，但节点侧的接缝**已经全齐** | 内容只在节点工作树里；Hub 侧列与上报字段都建好了（事实 5）；节点侧有 git 执行器与可注入类型（`spawnGit`、`GitRunner`：`bridge/src/git/worktree.ts:30/117`）；完成时 daemon 已知 `workspace.cwd`，且**先**推最后一条 system 日志、**再** `completeTask`（`wake/daemon.ts:263-305`）——指纹上报点就在那两行之间，天然早于 FAILED 抵达 Hub |
| 15 | `managedBySupervisor` 是"Hub 可否无人代办"的既有旗标 | 列 `db/schema.ts:274`、契约 `schemas.ts:438`、写入方 `markTaskManaged`（`repository.ts:3349+`，状态守卫 + 幂等）；2.3 用它区分"人还在终端前"与"已交给管家" |
| 16 | `POST /tasks/:id/complete` 的响应就是刚被写入的那一行 | `app.ts:1697-1698`；`completeTask` 要求当前状态是 CLAIMED（`repository.ts:3456-3461`）。任何"看完失败再动"的逻辑都必须发生在响应之后——先例是工单评审用 `setImmediate`/`void`（`app.ts:1380`） |
| 17 | 工单路线与任务路线今天**互不写状态** | `runMetaReview`/`rulePermission` 只动 `tickets`（3.2 §4）；`releaseTask`/`completeTask` 只动 `agent_tasks`。今天没有任何代码在工单被批准后回写任务状态——所以本步不能假设"批了工单任务就会复活" |
| 18 | admin 面由 dashboard 直连 | `requireAdmin`（`app.ts:1389/1502` 等）；web 用 bearer 调 `/api`（`packages/web/src/lib/api.ts:281`）。人工放行是 admin 动作，不是 Agent token 能做的 |

## 2. 落点与边界

**新增**
- `packages/server/src/supervisor/healer.ts`——纯函数 + LLM 客户端工厂，不碰 Fastify、不写库（照 3.2 `guard.ts` 与 2.x `rule-distiller.ts` 的分工）。导出面：

  ```ts
  /** 一次失败可供比较的证据。全部来自 Hub 已有的行，不新增查询。 */
  /** 管家自己动过手的一次尝试；一行 = 一次处置。 */
  export interface HealRecord {
    diagnosis: string;
    errorSignature?: string;
    diffHash?: string;
  }

  export interface FailureEvidence {
    task: AgentTask;
    /** 本任务最后一次非空 error_signature（本次尝试的结论）。 */
    lastSignature?: string;
    /** 本任务最后一次非空 diff_hash（本次尝试的工作树指纹）。 */
    lastDiffHash?: string;
    /** 管家自己写过的行，旧→新；每行代表一次动过手的尝试。 */
    heals: HealRecord[];
    /** 已降噪的尾部输出，预算内截断。 */
    logTail: string;
  }

  /** 尾部输出的字符预算，也是提示词的组成部分。 */
  export const LOG_TAIL_CHARS = 2_000;

  /** 0ms、0 Token。命中即熔断，不调模型。 */
  export function evaluateBreaker(e: FailureEvidence): string | undefined;

  /** 从日志行里提出可比较的证据；纯函数，好测。 */
  export function collectEvidence(task: AgentTask, logs: readonly TaskLog[]): FailureEvidence;

  /** 严格 JSON 提示词与解析：解析即过 supervisorDiagnosisSchema。 */
  export function buildDiagnosisMessages(e: FailureEvidence): { system: string; user: string };
  export function parseDiagnosis(raw: string): SupervisorDiagnosis | undefined;

  export interface SupervisorHealer {
    /** undefined = 判不出来（模型关闭/超时/答案不合法）；调用方必须保持今天的行为。 */
    diagnose(e: FailureEvidence): Promise<SupervisorDiagnosis | undefined>;
  }
  export function createHealer(
    config: MetaAgentConfig,
    fetchImpl?: typeof fetch,
    logger?: HealerLogger,
  ): SupervisorHealer;
  ```

  落地时比草案多了一个可选 `logger`：模型侧的 500/超时全部降级成 `undefined`，没有这行 warn 就成了运维上的黑盒（A5 钉住它只响一次）。

- `packages/bridge/src/git/delta.ts`（小）：工作树指纹的纯计算 + 一次只读 git 调用，注入 `GitRunner`（事实 14）。

**修改（只追加）**
- `packages/server/src/app.ts`：`complete` 路由在 `return` 前挂一个 `setImmediate(() => void healFailure(taskId))`；新 `healFailure()` 负责 IO（读日志→熔断→必要时问模型→写库/发事件/记日志）；新 admin 路由 `POST /api/tasks/:id/retry`。
- `packages/server/src/repository.ts`：`retryTask(id, fixPrompt, now)`、`blockTask(id, now)`（都从 FAILED 出发、带状态守卫、幂等由守卫保证；`blockTask` 不接 `reason`——理由是管家日志行的内容，不是任务行的内容，见 §3.5）；`claimNextTask` 候选与守卫放宽到 `PENDING|HEALING`，并从**先读到的候选行**取出一次性载荷；`reopenTask(id, now)`（草案里的 `resetTaskForHumanRetry`）供人工放行。
- `packages/server/src/meta-agent.ts`：把 `extractJsonObject` 导出（`:110`，现在私有），L2 复用它剥 Markdown 围栏，不再写第二份。
- `packages/shared`：`agentTaskSchema.fixPrompt`（可选，`≤4000`，与 `supervisorDecisionSchema.fixPrompt` 同界）、`agent_tasks.fix_prompt` 列 + `ensureColumn`；`SUPERVISOR_RETRY_CEILING = 3`、`SUPERVISOR_SIGNATURE_SIMILARITY = 0.85` 两个常数（放 `constants.ts`，与 `SUPERVISOR_PERMISSION_TIMEOUT_MS`、`DIAGNOSIS_SUMMARY_MAX_CHARS` 同区）。
- `packages/bridge`：`wake/prompt.ts` 两个 builder 在有 `task.fixPrompt` 时追加一段「总管诊断」；`wake/log-sink.ts` 的 `push(stream, chunk, meta?)` 允许第三个入参覆盖 `sanitizer.describe()` 的 meta（事实 14 的上报点）；`wake/daemon.ts` 在 `sink.close()` 前推指纹。

**明确不做**
- 不改 `decision-policy.ts`、不改 `runMetaReview`、不改工单状态机：L2 的读者是任务，不是工单。事实 17 决定了本步**不新建"批准工单→任务复活"的耦合**——BLOCKED 的出口是一条独立的小 admin 路由，不是工单。
- 不给 `MetaAgent` 接口加 `diagnose`：事实 8，会波及全部工单用例的测试替身。
- 不动 web（延续"数据层留字段、UI 不先动"；web 的状态样式 1.1 就备好了，事实 3）。
- 不做"人工放行时补充新指令"：Phase 4 的按钮语义（`PLAN.md:75`）。本步把载荷通道打通（`fix_prompt` 列已存在），Phase 4 不需要再改 schema。
- 不建 `supervisor_decisions` 表：3.2 §7 留的问题在这里有答案了——管家每次动手写**一行 `task_logs`**（`diagnosis` 列就是为它准备的，事实 5），`diagnosis IS NOT NULL` 成为"这一行代表一次被处置的尝试"的判别式，熔断条件直接读它，不需要新表、新列、新查询。
- 不接 `permission.request` 帧（同 3.2）。

## 3. 语义

### 3.1 触发与顺序

```
POST /tasks/:id/complete {status:'FAILED'} → repo.completeTask → 响应 {task}（逐字节不变，事实 16）
                                                        └─ setImmediate → healFailure(taskId)
                                                             ├─ 作用域闸：origin==='HUB_DISPATCH' 或 managedBySupervisor（事实 15）
                                                             ├─ collectEvidence(task, listTaskLogs)
                                                             ├─ evaluateBreaker ──命中──→ blockTask(reason)  ← 0ms、0 Token、模型根本不会被叫醒
                                                             └─ healer.diagnose(...)
                                                                  ├─ undefined → 什么都不做（= 今天）
                                                                  ├─ APPROVE → 只写诊断行（失败可接受，不重跑、不熔断）
                                                                  ├─ RETRY_WITH_FIX → retryTask(fixPrompt)：HEALING + retryCount+1 + 一次性载荷
                                                                  └─ ESCALATE_TO_HUMAN → blockTask(summary)
```

顺序本身就是成本属性：**熔断在模型之前**。一个已经在原地打转的任务，最贵的处置方式就是再问一次模型"要不要再试一次"。

### 3.2 三条熔断条件（任一命中即 BLOCKED）

| # | 条件 | 数据来源 | 证据不足时 |
|---|---|---|---|
| B1 | `task.retryCount >= SUPERVISOR_RETRY_CEILING`（3） | `agent_tasks.retry_count`（任务行，永不被裁） | 不存在——列有默认 0，永远可判 |
| B2 | 本次签名与**上一次被处置的尝试**的签名相似度 `> 0.85` | `textSimilarity`（事实 6）比 `lastSignature` 与 `heals.at(-1).errorSignature` | 任一为空 → 该条件沉默 |
| B3 | 本次 `diff_hash` 与上一次处置的 `diff_hash` **相等** | 同上取 `diffHash` | 任一为空 → 该条件沉默 |

- 比较对象是"上次处置时的签名/指纹"，不是"上次报错的那一行"。差别是实质性的：一次尝试内部常常重复同一句话（build 和 test 各打一遍同一个 TS 错误），拿它自己比自己是假的循环信号；跨尝试同错才是。
- `heals` 只认管家自己写的行（`diagnosis` 非空，事实 5），所以**没处置过的尝试不会污染比较序列**；模型关闭时一行都不会写，B2/B3 永远沉默，整层静默=今天的行为（这是设计，见 §7）。
- B2/B3 落在 `listTaskLogs` 的保留窗口里（事实 7：只裁最旧，我们要的是最后几次）。
- 顺序 B1→B2→B3，短路返回**第一条命中的中文理由**——理由会进 `diagnosis` 给人看，说清踩了哪条比说"熔断"有用。

### 3.3 L2 的提示词与解析

- 输入证据：任务标题/指令（各自 `truncate`，事实：`meta-agent.ts` 已有同名工具函数形状）、engine、`attempts`/`retryCount`、`lastSignature`、上次 `diagnosis`、`logTail`（预算 ≤2000 字符，与 `bridge/src/sanitizer/errors.ts:14` 的 `DIAGNOSIS_CHARS` 同界——3.1 已经把结论压到那里，本步不重复裁剪逻辑，只重复预算）。
- 输出：`supervisorDiagnosisSchema` 要求的**严格 JSON**（事实 9）。`parseDiagnosis` = `extractJsonObject`（剥围栏，事实 8 导出）+ `JSON.parse` + `schema.parse`，任何一步失败 → `undefined`（不是抛错，不是假批准）。
- 模型参数沿用既有约定：`temperature: 0`、`response_format:{type:'json_object'}`、`max_tokens: 800`（一句 ≤50 字诊断 + ≤4000 字修复指令）、`AbortController` 用 `config.metaAgent.timeoutMs`（这补上了 3.2 §7 欠 L2 的时间箱）。
- 语义约束由契约代劳，不重复发明：`DENY` 不在候选里（灰区永不自动拒绝）、`RETRY_WITH_FIX` 必须带 `fixPrompt`、多余字段被 `.strict()` 拒掉。
- `provider==='none'`、无 `apiKey`、非 2xx、超时、非法 JSON——**全部返回 `undefined`**，与 `rule-distiller` 的静默降级同形；但和 distiller 不同，这里**不编确定性兜底**：一句没有依据的"再试一次"就是熔断器要防的那种循环。

### 3.4 `fixPrompt` 的投递（本步唯一的载荷设计）

事实 12 说明今天没有通道，事实 13 说明投递点必须选在领取。落地：

- 存储：`agent_tasks.fix_prompt TEXT`（可空、默认 NULL、`ensureColumn` 升级），契约 `agentTaskSchema.fixPrompt?`。
- 写：`retryTask` 在 FAILED→HEALING 的同一条 UPDATE 里写入。
- 读：**领取时一次性交还**。`claimNextTask` 放宽到 `PENDING|HEALING`，从先读到的候选行取 `fixPrompt`，同一条 UPDATE 置 `status='CLAIMED'` 并把列清回 NULL（事实 13 的 `.returning()` 陷阱由"先读"绕开），返回的 task 带上那段话。
- 消费：`buildRunPrompt`/`buildInjectPrompt` 在 `task.fixPrompt` 存在时追加一段「总管诊断与修复要求」，明确写给引擎："这是上一次尝试失败后的结论，不是原始需求"。
- 后果：一次修复指令**只会被一次领取看见**。这是刻意的——重复投递会让第 N 次尝试去修第 1 次的问题，而熔断器的全部意义就是不让这种事发生。

否决的两个替代：把话拼进 `task.instruction`（污染人类原文，且多次重试会叠罗汉，不可逆）；造一张工单放 `customInstruction`（事实 17：派单路线不读工单，且会把 L2 自造的东西灌进人类的决策收件箱）。

### 3.5 状态机转移表（本步新增的全部边）

| 起 | 讫 | 谁写 | 还写什么 |
|---|---|---|---|
| FAILED | HEALING | `retryTask`（B 未命中 + `RETRY_WITH_FIX`） | `retry_count += 1`、`fix_prompt`、清 `completed_at`/`claimed_at`/`lease_at`，**不动** `result`/`session_id` |
| FAILED | BLOCKED | `blockTask`（B 命中，或 `ESCALATE_TO_HUMAN`） | 不动 `retry_count`；`result` 保留引擎原话；理由写进管家日志行。**只能从 FAILED 出发**：HEALING 是「等节点来领」，管家要熔断它得等它跑完再报 FAILED |
| FAILED | FAILED | 只写日志（`APPROVE`，或 `undefined`） | 只写日志 |
| BLOCKED | PENDING | `reopenTask`（`POST /tasks/:id/retry`，admin） | `retry_count = 0`、清 `fix_prompt`、清三个时间列，`reason` 作为 system 日志入档，`result` 不动 |
| HEALING | CLAIMED | `claimNextTask`（放宽后的既有方法） | 一次性投递 `fix_prompt`，`attempts += 1`（沿用既有语义） |

- `HEALING` 的语义严格采用契约原文（事实 3）：管家已下令重试、引擎续跑同一条会话。`BLOCKED` = 等一个管家不能自己做的决定。
- 人工放行把 `retryCount` 归零是对的：人给了新信息，之前那串循环作废；但 B2/B3 不清零——放行后立刻又是同一个错、同一份没动的工作树，就再次熔断。"人放行过一次"不该换成"机器可以再自动转三轮"。
- `retryTask`/`blockTask` 都以 `where status='FAILED'` 为守卫：节点在 L2 思考期间重报或人已经取消时，UPDATE 打空、本步放弃动作并记日志——与 `markTaskManaged` 同一个乐观并发口径。

## 4. 与既有结构共存

- **不改任何既有写入方的行为**：`completeTask`/`releaseTask`/`cancelTask`/`markTaskManaged` 一字不动；`claimNextTask` 只是放宽谓词，而今天没有行会处于 HEALING（事实 4），所以对既有数据是空操作。
- **FAILED 仍是引擎的结论，HEALING/BLOCKED 是管家对那个结论的结论**：两者不同时出现在一行里；`result` 永远是引擎原话，管家的话只在 `task_logs.diagnosis` 与 `app.log`。审计上"谁说的"不会混。
- **成本模型**：B 命中 → 0 Token；`undefined` → 0 Token；只有真正问过模型才花钱。与 3.2 的口径一致，`agent.calls`/`fetch` 计数可以断言。
- **事件与总线**：状态变化走既有 `taskBus.publish`（`releaseTask` 路径同款，`app.ts:831`），dashboard 的 SSE 立刻能看到 HEALING/BLOCKED；通知仍不做——`BLOCKED` 的推送是 Phase 4 的 `[批准继续]` 按钮一起做（`PLAN.md:75`），本步先让状态可查、可放行。
- **占用与调度**：HEALING 继续占额度（事实 3 已是既有口径：管家还握着那台机器的会话），BLOCKED 不占——所以熔断不会把节点填成"看似很忙"。`/tasks/next` 会领走 HEALING，`GET /api/resume`（`app.ts:2543-2551` → `listActiveTasks` 只 PENDING/CLAIMED）不会——那是"端侧重启后找回我自己正在跑的活"的视图，管家下令的重试不属于它，口径不同是有意的。
- **与 3.2 的接缝**：工单路线和任务路线仍然互不写状态。一个被 L1 DENY 挂住的权限请求走 `PENDING_HUMAN`；一个失败的走本步。两条线只在日志/事件里汇合，不共享判决。

## 5. 安全边界

- **模型没有把手，只有建议权**：`RETRY_WITH_FIX` 能做的仅是把任务放回可领取状态并附一段文本；它改不了 status 之外的任何列，碰不了 `instruction`、`managedBySupervisor`、learned rules、工单。文本被引擎当真与否，是引擎的事；Hub 侧绝不把模型输出当命令执行，也不拼进 shell。
- **自动重跑的上限由列决定，不由模型决定**：`retry_count` 只在 `retryTask` 里 +1，且 B1 在问模型**之前**判——模型无法通过反复乐观来绕过熔断。
- **指纹来自节点，但只用作"没变动"的否定判断**：节点谎报一个每次都变的哈希只能让 B3 失效（少熔断），永远换不来放行；真正的兜底是 B1，它不依赖节点。
- **`fix_prompt` 不进 shell**：它是 CLI 的参数值，走 argv（既有口径），且长度受契约 ≤4000 约束。
- **`collectEvidence` 只读**：不写库、不改入参数组（矩阵 E8 用 `deepEqual` 钉）。
- **人工放行是 admin 动作**（事实 18）：Agent token 改不了 BLOCKED——否则被熔断的任务能自己给自己开门。
- **不推倒重来**：本步不新增表、不新增状态、不改既有路由的响应体；新增列只有一列，且有 `ensureColumn` 升级路径与旧库用例护栏（`task-protocol.test.ts:100-142` 用 `arrayContaining`，新列不会撞它）。

## 6. 测试矩阵

### `packages/server/test/supervisor-heal.test.ts`（新增，纯函数）

熔断（B）：

| id | 输入 | 期望 |
|---|---|---|
| B1 | `retryCount:2` + 无 heals | `undefined`（还没到 3） |
| B2 | `retryCount:3` | 熔断，理由含"已自愈 3 次" |
| B3 | `retryCount:9` + 签名与上次完全不同 | 仍然熔断（B1 独立生效） |
| B4 | 上次处置签名 `TS2322 src/a.ts`，本次同串 | 熔断（相似度 1.0 > 0.85） |
| B5 | 本次 `Cannot find module './a'` vs 上次 `TS2322 src/a.ts` | `undefined`（低于阈值，该问模型） |
| B6 | 中文签名换词序："编译失败 缺少分号" vs "缺少分号 编译失败" | 熔断（bigram 重合，复用事实 6 的算法） |
| B7 | 本次无签名 | `undefined`（B2/B3 沉默，B1 未到） |
| B8 | heals 有签名、本次指纹与上次 `diffHash` 相同 | 熔断（B3） |
| B9 | 同上但指纹不同 | `undefined` |
| B10 | 上次处置无 `diffHash`（老节点） | 不因 B3 熔断；其余条件照判 |
| B11 | 三条同时命中 | 返回 B1 的理由（顺序短路，且**不看模型**） |
| B12 | `heals` 三条历史，只看最后一条 | 与最后一条比（不被更早的失败稀释） |

证据提取（E）：

| id | 输入 | 期望 |
|---|---|---|
| E1 | 混合日志行，末尾两条带签名 | `lastSignature` = 最新那条 |
| E2 | 只有进度行、无签名 | `lastSignature === undefined` |
| E3 | 两行带 `diagnosis` | `heals` 长度 2，**旧→新** |
| E4 | `diagnosis` 与 `errorSignature` 同一行 | 收进 heals 的同一条（管家行自带证据） |
| E5 | 行带 `diffHash` 但 `diagnosis` 为空 | 只作 `lastDiffHash`，不进 heals（节点行≠处置行） |
| E6 | `logTail` 预算：100KB 输入 | ≤2000 字符，且取的是**尾部** |
| E7 | 空日志 | 全字段 undefined，不抛 |
| E8 | 任意输入两次调用 | 返回等值，且入参数组 `deepEqual` 未变 |

提示词与解析（N）：

| id | 输入 | 期望 |
|---|---|---|
| N1 | `buildDiagnosisMessages` | system 要求严格 JSON 且列出三种 decision；user 含指令、签名、上次诊断、尾部输出 |
| N2 | 指令/日志超长 | 各自预算内截断，整体长度有上界（成本护栏） |
| N3 | `parseDiagnosis('{"decision":"RETRY_WITH_FIX","diagnosisSummary":"…","fixPrompt":"…"}')` | 通过 |
| N4 | 同上但 ```json 围栏 | 通过（复用 `extractJsonObject`） |
| N5 | `RETRY_WITH_FIX` 无 `fixPrompt` | `undefined`（契约 :99-105） |
| N6 | `decision:'DENY'` | `undefined`（契约不给模型拒绝权，事实 9） |
| N7 | `diagnosisSummary` 60 字 | `undefined`（`DIAGNOSIS_SUMMARY_MAX_CHARS`） |
| N8 | 多一个 `confidence` 字段 | `undefined`（`.strict()`） |
| N9 | 非 JSON / 空串 / 只有散文 | `undefined`，不抛 |

### `packages/server/test/supervisor-healer.test.ts`（新增，注入 fake fetch/config）

| id | 场景 | 期望 |
|---|---|---|
| A1 | `provider:'none'` | `diagnose` → `undefined`，**fetch 未被调用** |
| A2 | 无 apiKey | 同上 |
| A3 | 200 + 合法严格 JSON | 返回解析后的 `SupervisorDiagnosis` |
| A4 | 200 + 模型散文 | `undefined`（不重试、不猜） |
| A5 | 500 / 非 2xx | `undefined`，不抛给调用方 |
| A6 | fetch 挂起超过 `timeoutMs` | `undefined`（AbortController 生效，3.2 欠的时间箱在此兑现） |
| A7 | 请求体 | `temperature:0`、`response_format:'json_object'`、`max_tokens≤800` |
| A8 | `provider:'http'` + endpoint | 走通用 HTTP 形状，复用 distiller 的口径 |

### `packages/server/test/db-task-heal.test.ts`（新增，仓储层）

| id | 场景 | 期望 |
|---|---|---|
| R1 | `retryTask(FAILED)` | → HEALING，`retryCount+1`，`fixPrompt` 落库，`completedAt` 清空，`result`/`sessionId` **不变** |
| R2 | `retryTask(CLAIMED)` | 返回 `null`（守卫打空），状态不变；同一条方法对 FAILED 仍然生效 |
| R3 | 领取 HEALING 任务 | 拿到 CLAIMED + 那次 `fixPrompt`；`attempts+1` |
| R4 | 紧接着第二次领取 | **不再**带 `fixPrompt`（一次性投递） |
| R5 | 领取按 `created_at` 排序，**不看**它是 PENDING 还是 HEALING | PENDING 的既有语义（`attempts`、无载荷）逐条不变 |
| R6 | `blockTask(FAILED)` | → BLOCKED，`retryCount` 不动，`result` 保留引擎原话 |
| R7 | `reopenTask(BLOCKED)` | → PENDING、`retryCount=0`、`fix_prompt` 为 NULL、`result` 仍是引擎原话；BLOCKED 领不走、放行后领得到 |
| R8 | BLOCKED/HEALING 都**不是**终态 | `isTerminalTaskStatus` 口径不变（契约用例已锁，本步不新增断言面） |
| R9 | 旧库（无 `fix_prompt` 列）升级 | 列出现、旧行读回 `fixPrompt === undefined`、`GET /tasks` 不炸 |
| R10 | `activeTaskCountsByEnv` | HEALING 计入、BLOCKED 不计入（既有实现的本步第一次被真实数据检验） |

### `packages/server/test/api-healer.test.ts`（新增，`createTestContext` + 注入 fake healer）

| id | 场景 | 期望 |
|---|---|---|
| H1 | 上报 FAILED，fake healer 返回 `RETRY_WITH_FIX` | 轮询到 HEALING、`retryCount=1`；`POST /tasks/:id/complete` 的响应体仍是 `status:'FAILED'`（事实 16 的"响应不变"） |
| H2 | 返回 `ESCALATE_TO_HUMAN` | BLOCKED，且 `GET /tasks?status=BLOCKED` 查得到；`result` 未被管家话覆盖 |
| H3 | 返回 `APPROVE` | 留在 FAILED，只多一行 `diagnosis` |
| H4 | 返回 `undefined` | 与今天逐字段相同（无新行、无状态变化）——本步的回归护栏 |
| H5 | `retryCount` 已到 3 且 healer 会返回 RETRY | **healer 未被调用**（调用计数为 0 ⇒ 熔断在前，0 Token 成立），任务 BLOCKED |
| H6 | 两次同错（第一次已 RETRY） | 第二次熔断在 B2，healer 调用总数仍为 1 |
| H7 | 管家日志行 | `diagnosis` = 一句话/熔断理由，`errorSignature` = 本次签名，`diffHash` 从节点行带入 |
| H8 | DONE 上报 | 完全不进 L2 |
| H9 | `origin:'LOCAL_WRAP'` 且 `managedBySupervisor=false` | 不进 L2（人还在终端前） |
| H10 | `origin:'LOCAL_WRAP'` 且 `managedBySupervisor=true` | 进 L2 |
| H11 | `POST /tasks/:id/retry`（admin） | BLOCKED→PENDING、`retryCount=0`、system 日志入档；再失败时 B2 仍比上次处置的签名 |
| H12 | 同一路由用 Agent token | 403 |
| H13 | 领取带 HEALING 的下一个任务（经 `/tasks/next`） | 响应里 `task.fixPrompt` 有值；紧接第二次领取没有（R3/R4 的 HTTP 面） |
| H14 | 既有 `tasks` / `stale-tasks` / `task-protocol` / `api-supervisor` 用例全绿且**不改断言** | 追加式落地的验收线 |

### `packages/bridge/test/wake-heal.test.ts`（新增）

| id | 场景 | 期望 |
|---|---|---|
| W1 | `buildRunPrompt(task.fixPrompt)` | 追加「总管诊断」段，且明写"不是原始需求"；无 fixPrompt 时**逐字节等于今天** |
| W2 | `buildInjectPrompt` 同上 | 同上 |
| W3 | 指纹纯函数：`porcelain` + `HEAD` 给定 | 稳定、与顺序无关的哈希串，长度 ≤64 |
| W4 | 两次相同的工作树 | 两次相同指纹（B3 的正例来源） |
| W5 | 未跟踪文件出现 | 指纹变化（"改了但没提交"必须算动了工） |
| W6 | git 失败 / 非工作树 | `undefined`，且 daemon 照常上报（不阻塞完成流程） |
| W7 | daemon 完成流程 | 指纹在 `sink.close()` 前推出去，`completeTask` 在其后（Hub 收到 FAILED 时指纹一定已入库） |
| W8 | `sink.push(stream, chunk, meta)` | 显式 meta 覆盖 `sanitizer.describe()`，不传时行为与今天一致（3.1 的既有用例不改） |

### 全仓验收线

- `pnpm -r typecheck` 与 `pnpm test` 双绿；`grep -rn "SUPERVISOR_RETRY_CEILING\|SUPERVISOR_SIGNATURE_SIMILARITY" packages/server/src` 只命中 `healer.ts`（阈值只有一个读者才有意义）。
- 既有 `tasks` / `stale-tasks` / `task-protocol` / `meta-agent` / `tickets` / `decisions` / `task-events` / `api-supervisor` 用例**不得修改断言**；若必须改，理由写进 `PLAN.md` §5。
- `grep -rn "evaluateBreaker\|healFailure" packages/server/src` 只有 `healer.ts`（纯判据）与 `app.ts`（唯一 IO 接线点）——延续 3.2"风控入口唯一"的口径。
- `task.status` 的新写入方只有四个：`retryTask`/`blockTask`/`reopenTask` 与放宽后的 `claimNextTask`。除此之外 `agent_tasks.status` 的写入点与本步之前一字不差。

### 落地后的用例数

5 个新文件、71 个新用例：`supervisor-heal`(30) / `supervisor-healer`(9) / `db-task-heal`(10) / `api-healer`(13) / `bridge:wake-heal`(9)。全仓 `108 files / 1041 tests`（3.2 结束时 103/970）。矩阵之外补了三个负例：N2b（缺证据要写"未上报"而不是编一个）、A8b（http provider 没 endpoint 也不打空请求）、W7b（非工作树目录照常 completeTask）。H5 用仓储层把前三轮跑完、第四轮才走 HTTP——`FAILED` 不可领取，所以"到顶的那一次"必须是正在跑的那一次；H14 不是用例，是 `pnpm test` 全绿本身。

## 7. 已知取舍

- **模型关闭时整层静默**（含熔断）：管家的证据行由处置动作产生，没处置就没证据可比，B2/B3 永久沉默，B1 也永不触发。这看着可惜，但换来说服力强得多：`META_AGENT_PROVIDER=none` 的部署与本步之前逐字节等价。要让熔断在纯离线环境生效，得给签名比较找一个不依赖模型的锚——那是 4.x 的事，不在此偷偷加。
- **`APPROVE` 不改变状态**：模型说"这次失败可以接受"时，Hub 只记录不重跑，任务留在 FAILED。理由是 FAILED 是引擎的结论，管家没有把手去改它；如果这类"假失败"多到值得处理，正确做法是让适配器报 DONE，而不是让 L2 学会撒谎。
- **同错判定只看最后一次处置**：`heals.at(-1)` 而不是整条历史。历史越长越容易把"曾经同错"当成"现在同错"，而熔断要的是"当下正卡住"。真要看趋势，日志行都在，Phase 4 的收件箱可以摊开展示。
- **B3 依赖节点指纹，允许缺位**：老版本 bridge、非 git 目录、git 不可用时该条件自动沉默，不报错也不熔断。取舍方向是明确的——缺证据时宁可多花一次 Token 问模型，也不要把一个正常任务关进 BLOCKED。
- **`fix_prompt` 是新增列，本步唯一的数据面代价**：投递需要持久化，而事实 12 证明既有列没有一个能承担"一次性、随领取交还"的语义。可空 + `ensureColumn` + R9 的旧库用例保证升级安全。
- **人工放行不补新指令**：`POST /tasks/:id/retry` 只开门、归零计数。Phase 4 的"批准并补充指令"可以直接复用 `fix_prompt`，不需要再动 schema——这正是本步把载荷通道打通、但不发明按钮的原因。
- **L1 的 ReDoS 时间箱仍然欠着**：3.2 §7 写下"等 3.3 统一给 L1/L2 加超时"。L2 这次真加了（A6）；L1 没加，因为它现在是同进程内的纯内存匹配，要真正限时只能上 worker 或给匹配加字符预算——那比本步该有的改动更大，且 0ms 判据加线程池会把成本模型反过来。此处如实记录，不留假承诺。
