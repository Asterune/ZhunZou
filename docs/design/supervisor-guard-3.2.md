# Step 3.2 设计：`supervisor/guard.ts` L1 确定性风控

蓝图出处：`PLAN.md:70`。目标一句话——**权限请求里能被规则说清的那一类，0ms、0 Token 出结论；说不清的照原路走 LLM/人工，且灰区永不自动拒绝。**

## 1. 现状核实（2026-11-13，逐条带证据）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 结构化动作**已经完整抵达 Hub**，不需要新协议字段或新列 | `task_events.action` 存的是 parse 过的 `PermissionAction`（`server/src/db/schema.ts:328-335`）；写入方 `repository.ts:2152 reportTaskEvents`；入口 `app.ts:1735 POST /tasks/:id/events`（且只接受 CLAIMED 任务） |
| 2 | `outsideWorkspace` 由 Hub 重算，节点声明只能收紧 | `shared/src/supervisor.ts:20-23` `escapesWorkspace` + `:48-55` `transform`（`action.outsideWorkspace \|\| escapes`） |
| 3 | 工单已经挂着任务 | `db/schema.ts:44 tickets.taskId`（`:69` 有索引）；`repository.ts:1022-1040 create()` 在建票瞬间把该 env 处于 CLAIMED 的任务挂上去。park 与本地托管都是**先建票再 release/takeover**，链路成立：`bridge/src/wake/daemon.ts:181→214`、`bridge/src/wrappers/runner.ts:328→346` |
| 4 | 系统里只有两个判官，且第二个自称唯一 | `app.ts:607 runMetaReview`（ticket 路线，`POST /tickets` 建票后异步触发，`app.ts:1380`）；`decision-policy.ts evaluateDecision`（`POST /decisions` 路线，文件头注释 "there is exactly one policy in the system"） |
| 5 | `POST /decisions` 的输入是**散文** | `decisionRequestSchema`（`shared/src/schemas.ts:692-710`）只有 `proposal`/`context`/`risk`/`options`，没有结构化 action |
| 6 | 实现前：`learned_rules` 表和 CRUD 齐备但**零执行方** | 表 `db/schema.ts:200-222`；`repository.ts:3975 addLearnedRule` / `:4009 listLearnedRules` / `:4025 recordLearnedRuleHit` / `:4036 setEnabledLearnedRule`——后三个在 `packages/*/src` 里**没有任何调用方**（本步 §4 一次补齐四个） |
| 7 | 契约注释承诺的路由**当时**不存在 | `shared/src/supervisor.ts:181` "Query accepted by GET /api/learned-rules"（实现前在 `:169`，本步新增了 `updateLearnedRuleSchema` 使其下移）；实现前 `app.ts` 路由全表里没有 `/learned-rules`——本步 §4 把它兑现 |
| 8 | 权限工单的选项键是三套已知词表 | park：`approve`/`reject`（`wake/daemon.ts:188-202`，recommend `reject`）；本地托管：`y`/`n`（`wrappers/idle.ts:67-70`，recommend `n`）；决策票：`A`/`B`（`decision-policy.ts:44-60 optionsFor`） |
| 9 | 任务工作区路径只有伴随任务开局就有 | `repository.ts:3333 createLocalTask` 写 `workspace_path`；`:3468 completeTask` 才为下发任务写——**挂起时 Hub 未必知道**，故 `action.workspaceRoot` 仍是主要依据 |
| 10 | 实现前：超时常量已存在但无使用方 | `constants.ts SUPERVISOR_PERMISSION_TIMEOUT_MS = 55_000`（全仓 `src` 无引用）；本步 `guard.ts` 拿它做 §3.3 的新鲜度上界 |
| 11 | `permission.request` WS 帧有定义、无生产方 | `shared/src/realtime.ts:88-95/196-202` 定义；`server/src/realtime/device-router.ts:359-401` 的处理类型里没有它，落到 `default: break`；全仓 `src` 无任何发送方 |
| 12 | `TaskStatus` 的 `HEALING`/`BLOCKED` 无写入方 | `repository.ts` 里 `claimNextTask→CLAIMED :3437`、`createLocalTask→CLAIMED :3325`、`completeTask→DONE/FAILED :3451`、`cancelTask→CANCELLED :3486`、`releaseTask→PENDING/FAILED :3510`；`HEALING` 只在 `:3561` 被读 |
| 13 | 实现前：全仓没有命令分类器 | `isReadOnly`/`denylist`/`autoApprove`/`matchRule` 零命中；`bridge/src/workspaces.ts:405` 与 `fleet.ts:1003` 的 allowlist 是**文件系统路径包含**，不是命令风控 |
| 14 | 单任务事件保留窗口 = 500，且按 id 升序返回 | `repository.ts:155 MAX_TASK_EVENTS = 500`、`:2203 trimTaskEvents`、`:2186 listTaskEvents`（`limit` 上限也是 500）→ 取"最后一条权限请求"不需要新增仓储方法 |
| 15 | 实现前：`SupervisorDecision` 结构已定义、无生产者 | `shared/src/supervisor.ts:80-108`（L1 不许带 `fixPrompt`）；`shared/test/supervisor.test.ts:106` 锁着契约 |
| 16 | 挂起时**事件先落库、工单后建**，所以 L1 评审时一定看得见 action | `wake/daemon.ts:283 await eventSink.close()` 在 `:291 parkTask(...)` 之前；本地托管同理 `wrappers/runner.ts:224` 的 eventSink 与 `:328` 的建票 |
| 17 | 只读命令的自动放行对**两类工单**都成立 | 下发挂起票键 `approve`、本地托管票键 `y`（事实 8），两者都由 `runMetaReview` 评审 |

## 2. 落点与边界

**新增**
- `packages/server/src/supervisor/guard.ts`——纯函数模块，不做 IO、不读库、不调 LLM。

**修改（只追加，不改既有分支的行为）**
- `packages/server/src/app.ts`
  - `runMetaReview`：在 `metaAgent.review(...)` **之前**插一段确定性前置（事实 4：它必须是既有判官内部的一层，不是第三个判官）。
  - 三条管理路由（事实 7）：`GET /api/learned-rules`、`POST /api/learned-rules`、`PATCH /api/learned-rules/:id`，全部 `requireAdmin`。规则 id 是不透明串（`lr-…`）不是工单号，所以另配 `learnedRuleParamsSchema`，不复用 `paramsSchema`。
- `packages/shared/src/supervisor.ts`（两处，都是为了让路由名副其实）
  - 新增 `updateLearnedRuleSchema`：PATCH 只能动 `enabled` 一个字段。
  - 修 `listLearnedRulesQuerySchema.enabledOnly`：原来是 `z.coerce.boolean()`，会把查询串 `"false"` 读成 `true`——即"显示全部"会被解析成"只显示启用的"。本步之前没有路由，这个 bug 没人踩得到；现在 L1 拿它决定放行与否，必须修。

**明确不做**
- 不改 `decision-policy.ts`：那是散文路线（事实 5），既有 `risk==='destructive'` 硬规则已经守着它，**L1 不解析散文**。给自然语言做命令分类器是假确定性。
- 不接 `permission.request` WS 帧（事实 11）：没有生产方的输入接进来，只会喂给真风控。`device-router.ts` 的这个缺口在此记录、不在此填。
- 不改 DB schema、不动 bridge、不新增工单状态、不写 `HEALING`/`BLOCKED`（事实 12，那是 3.3 的范围）。shared 侧只加不减（见上）。
- 不做"批准即学会规则"：`rule-distiller` 目前把人工批准蒸馏成 `rule_candidates`（散文，`app.ts:3015 accept` 落到 `rulesStore`），把它接成 `learned_rules` 的写入方是 Phase 4 `[批准并记住规则]` 按钮的事（`PLAN.md:75`）。本步 `learned_rules` 的写入方只有 `POST /api/learned-rules`。

**`guard.ts` 导出面**

```ts
export interface GuardContext {
  rules: LearnedRule[];
  /** task.workspace_path：有值时优先于节点自报的 workspaceRoot。 */
  taskWorkspaceRoot?: string;
  /** 规则存在但已不可用时发声（不传就是静默跳过）。 */
  warn?: (message: string) => void;
}

/** 命中即出结论；undefined = 灰区，交回既有流程。 */
export function evaluateL1(
  action: PermissionAction,
  ctx: GuardContext,
): SupervisorDecision | undefined;

/** 从任务事件里挑出「这张票是因为它而开」的那条权限请求。 */
export function selectPermissionAction(
  events: readonly TaskEvent[],
  at: { ticketCreatedAt: number; now: number },
): PermissionAction | undefined;

/** 把 APPROVE 映射到这张票自己的"批准"选项；认不出来返回 undefined。 */
export function approveOptionFor(ticket: DecisionTicket): string | undefined;
```

三者都只吃数据、吐数据，所以风控表可以脱离 Fastify 和 SQLite 整张测完。

## 3. 语义

### 3.1 `evaluateL1` 的判定顺序（短路，第一条命中即返回）

顺序本身就是安全属性，不可调换：

1. **硬拒（DENY）**——不可逆或越界，**learned ALLOW 也救不回来**。四条按序检查，命中即返回（都产 DENY，只是 reason 不同）。
   - 敏感目标：`.env` 与 `.env.*`（`.env.example`/`.env.sample`/`.env.template`/`.env.dist` 先整段摘掉再扫）、`.ssh/`、`.aws/`、`.gnupg/`、`.kube/`、`id_rsa`/`id_ed25519`、`.git-credentials`、`.npmrc`、`.netrc`、`.pypirc`、`/etc/`、`.cursor/mcp.json`。**命令串和 path 列表一起扫**：`cat .env.production` 与 `paths:['/repo/.env']` 同样出局——读一次凭据和改一次凭据一样不能自动放行。边界用"非词字符"而不是路径分隔符，这样命令里的 `cat .env` 才抓得到。
   - 毁灭形态（对整条命令扫一遍正则，`rm`/`git` 再按段做旗标分析）：`rm` 同段内既递归又强制（`-rf`/`-fr`/`-r -f`/`--recursive --force`）、`--no-preserve-root`、`sudo`/`doas`、`dd of=`/`mkfs`/`fdisk /dev/`、`chmod 777`、fork bomb、`git push --force|-f|--force-with-lease`、`git reset --hard`、`git clean -f`、`git checkout|restore --hard|.`、`git branch -D|--delete`、`git filter-branch`、`npm|pnpm|yarn|bun|cargo|twine publish`、`curl|wget … | sh|bash|python|node…`、`docker prune|rm -f`、`DROP|TRUNCATE TABLE|DATABASE`、`artisan|knex|prisma|django-admin migrate(:)down`、`kubectl|helm delete|uninstall`。
   - 节点自报的 `workspaceRoot` 不在 Hub 记录的 `taskWorkspaceRoot` 之下 → DENY（谎报根目录换不来放行）。
   - 绝对路径越出根 → DENY。
2. **learned DENY 命中** → DENY，带 `ruleId`。
3. **learned ALLOW 命中** → APPROVE，带 `ruleId`（命中计数由调用方做，见 §4）。
4. **内在安全（allow-by-nature）→ APPROVE**
   - **命令分析只对 `kind==='command'` 开火**。`delete`/`network`/`git_operation` 即便带着 `command` 串也不参与只读判定——那三种 kind 的语义 L1 承担不起（G1~G3）。现实中 `bridge/src/wake/events.ts:222-228` 只产 `command` 与 `file_change` 两种，所以这不是空转的限制。
   - 只读命令：命令按 `;` `&&` `||` `|` 换行切成段，**每一段**都必须只读才算数——`ls | head -5` 放行，`ls; rm -rf /` 走毁灭判定。段的首要可执行文件（跳过 `FOO=1` 前缀与 `env`/`command`）在只读工具表内（`ls cat head tail wc file stat which whereis pwd echo printf date uptime uname ps df du tree grep rg ag find fd locate sort uniq cut diff cmp od strings jq basename dirname realpath readlink seq tac nl tr md5sum sha256sum …`），或是只读 git 子命令（`status log diff show blame rev-parse rev-list describe ls-files ls-tree cat-file show-ref shortlog merge-base annotate`；`branch`/`tag` 只要不带删除或改名旗标；`config` 只在 `--get|--get-regexp|--list|-l` 下算只读；`remote` 只在无参或 `-v|show` 下算只读；带 `-C/--git-dir/--work-tree` 这类全局旗标直接出局，因为根变了），或是类型/测试/静态检查（`tsc|vue-tsc --noEmit`、`eslint`（无 `--fix`）、`prettier --check|--list-different`、`npm|pnpm|yarn run <test|typecheck|lint|check|verify|cov|coverage>`、`vitest|jest|pytest|mocha|rspec|phpunit|mypy|biome|rubocop|flake8|pylint|golangci-lint`、`ruff check`、`go test`、`cargo test`、`make test`），或 `npx`/`bunx`/`pnpm exec` 剥掉前导旗标后仍然只读。
   - **不算只读的形态**：段里有重定向 `>` `<`（引号内的不算）、整条命令有命令替换 `` ` ``/`$(`/`${}`、`find` 带 `-delete|-exec|-execdir|-ok|-fprint|-fls`、`eslint --fix`、`prettier --write`、`npm run build`、未识别的可执行文件。`sed`/`awk` 干脆不在只读表里——它们能改文件，而 L1 不解析脚本体。
   - 工作区内源码变更：`kind==='file_change'` 且**每条 path 都是绝对路径、都在根内、扩展名属于源码/配置写集**（`.ts .tsx .js .jsx .mjs .cjs .json .jsonc .md .mdx .css .scss .sass .less .html .vue .svelte .py .go .rs .java .kt .c .h .cpp .hpp .cc .rb .php .sh .bash .yaml .yml .toml .ini .xml .sql .graphql .prisma .exs .swift .tf .lock .txt` 以及 `.example/.sample/.template`）→ APPROVE。
   - 根取自 `ctx.taskWorkspaceRoot ?? action.workspaceRoot`；两者都没有 → 灰区（事实 9）。**相对路径既不判越界也不放行**：`outsideWorkspace` 把相对路径算作越界（`shared/src/supervisor.ts:20-23`），对一个布尔旗标这样没错，作为一个判决就错了——子进程 `cd` 去哪儿 Hub 看不见，所以 L1 自己按绝对路径重算 containment，剩下的落灰区（A11/A12）。
5. **其余 → `undefined`（灰区）**。具体落灰区的：`kind==='delete'`、`kind==='network'`、`kind==='git_operation'`（除被硬拒抓走的那些，如 `commit`、`rebase`、`merge`）、不认识的 `command`、只有相对路径的 `file_change`。

`SupervisorDecision` 的 `layer` 恒为 `'L1'`、`reason` 必须非空且指出**踩了哪条规则**，不带 `fixPrompt`（契约见事实 15）。`reason` 在实现里自截 400 字符——契约上限 500，留 100 给调用方加的 `[L1] ` 前缀和规则名拼接。

### 3.2 `learned_rules` 匹配语义

| patternType | 判据 |
|---|---|
| `exact` | 归一化后整串相等（`trim` + 连续空白压成一个空格） |
| `glob` | 整串匹配（不是子串包含），支持 `* ? [..]`，先对 `command` 试、再对每条 `path` 试 |
| `regex` | `new RegExp(pattern)` 测 `command` 全文与每条 `path` |

- `rule.kind` 非空时必须与 `action.kind` 相等；为空表示不限类型。
- `rule.enabled === false` 直接跳过（撤销必须是 0 延迟，见 §4 的路由）。
- **防御性跳过**编译失败的 regex 规则并 `console` 级 warn：写入口有 schema 校验（`supervisor.ts:126-137/154-165`），但读旧库时仍要防脏行。
- 多条命中：**先 DENY 后 ALLOW**——这是顺序 2/3 的自然结果，不靠打分。

### 3.3 `selectPermissionAction`：谁的动作配谁的票

事件表按任务存流水（事实 14），票可能晚于、也可能根本不因这次请求而开。三条都满足才认：

1. `event.kind === 'permission_required' && event.action` 存在，取**最后一条**（升序列表的末尾）。
2. `event.createdAt <= ticketCreatedAt + 1_000`——票在这条请求之后（或同一秒）开的。
3. `now - event.createdAt <= SUPERVISOR_PERMISSION_TIMEOUT_MS`（55s，事实 10）——请求还热着，管家不是在给一场早已结束的-run 补票。

不满足 → `undefined`，`runMetaReview` 完全按今天的样子跑。

### 3.4 `approveOptionFor`：闭集词表

只认事实 8 的三套键：`approve` / `y` / `A`（大小写不敏感），且该选项 `risk !== 'destructive'`。认不出来 → `undefined` → **不自动放行**，交给 LLM。

这是有意的保守：代理通过 MCP 自造选项的工单（`bridge/src/mcp-server.ts:563`）不在权限工单的已知形状里，宁可多花一次 Token，也不猜哪个按钮是"同意"。

## 4. 与既有策略、状态机共存

```
POST /tickets → PENDING_META → runMetaReview
                                 ├─ taskId 存在？ ──否──────────────┐
                                 ├─ selectPermissionAction ─无─────┤
                                 ├─ evaluateL1                     │
                                 │   ├─ APPROVE → markAutoResolved(goKey, "[L1] …")
                                 │   │             + recordLearnedRuleHit(ruleId?)
                                 │   ├─ DENY    → markPendingHuman("[L1] …") + 通知
                                 │   └─ undefined ─────────────────┐
                                 └─────────────────────────────────┴→ metaAgent.review(...)（今天的代码，一行不改）
```

- **不改状态机**：APPROVE 走 `markAutoResolved`、DENY 走 `markPendingHuman`，两个方法都是既有的；不新增状态，也不给 `HEALING`/`BLOCKED` 开写入方。
- **DENY = 蓝图说的"0ms 拦截挂起"**：票停在 `PENDING_HUMAN`，端侧进程早已释放（`wake/daemon.ts:213-218`），人在仪表盘上拍板。它与今天灰区结果的唯一区别是：**LLM 再也没有机会把它自动批掉**——这才是"拦截"。
- **AUDIT 不落新表**：结论写进既有的 `resolutionReason`（前缀 `[L1]`），结构化决定用 `app.log.info` 落日志。本步没有 `supervisor_decisions` 表，因为 3.3 之前没有第二个读者。
- **共存于 `decision-policy`**：`POST /decisions` 的 PENDING 分支不经过 `runMetaReview`（`app.ts` 里直接 `markPendingHuman`），所以 L1 不会影响它；它的风险由既有 `risk==='destructive'` 硬规则承担。两套判据不重叠：一个吃结构化 action，一个吃散文 proposal。
- **`recordLearnedRuleHit` 得到第一个生产调用方**（事实 6）。已知副作用：它同时 bump `updatedAt`，而 `listLearnedRules` 按 `updatedAt` 倒序排——热门规则会浮到列表前面，对仪表盘反而是对的。
- **三条路由**：
  - `GET /api/learned-rules?enabledOnly&action` → `listLearnedRulesQuerySchema.parse` → `repo.listLearnedRules`（把事实 7 的空头支票兑现）。
  - `POST /api/learned-rules` → `createLearnedRuleSchema` → `repo.addLearnedRule`；`(pattern, action)` 唯一索引让重复批准更新同一行（`db/schema.ts:218`）。
  - `PATCH /api/learned-rules/:id` `{enabled}` → `setEnabledLearnedRule`。**撤销阀是必须的**：L1 一旦据 ALLOW 规则自动放行，人就要能在 0 延迟内把它关掉；只有开关没有 DELETE，规则表可回滚、历史 hits 保留。

## 5. 安全边界

- **只信 Hub 侧数据**：action 是 `permissionActionSchema` parse 过的结构化对象（不是散文，也不是节点自己解释的字符串）；`task_events` 只在任务 CLAIMED 时由 `POST /tasks/:id/events` 写入（`app.ts:1735`）。
- **containment 自己算，不读 `action.outsideWorkspace`**：shared 的 transform 把**相对路径**也算作越界（`supervisor.ts:20-23`），那是给 UI 打红旗用的；判官要的是证明。`guard.ts:435` 只对绝对路径判越界，纯相对路径的写集落灰区——既不放行，也不因为"最普通的编辑"长得不像绝对路径就拒绝。
- **节点自报只能收紧**：`ctx.taskWorkspaceRoot`（来自 `agent_tasks.workspace_path`）存在时优先于 `action.workspaceRoot`，两者冲突按越界处理（`guard.ts:325-330`）——谎报根目录换不来放行。
- **规则表不是万能钥匙**：硬拒在 learned ALLOW 之前（§3.1 顺序 1），人工写一条 `rm -rf*` 的 ALLOW 也放不过去。想让毁灭操作走自动放行，本步在架构上做不到。
- **分类器只做减法**：不确定 → 灰区 → LLM/人工。DENY 只在**确定命中毁灭/越界形态**时产生；任何解析失败、字段缺失、未知 kind 都落灰区。灰区永不自动拒绝。
- **结论过契约**：任何返回值都由 `decide()` 生成，`reason` 在 400 字符内自截（`MAX_REASON_CHARS`），远低于契约上限 500——审计串不吃 Token，也不会因一条 absurd command 撑爆 schema。
- **不执行、不 eval**：glob/regex 只在内存里匹配字符串，绝不 `child_process`、绝不 `eval`。regex 由 admin 经 `POST /api/learned-rules` 写入且写时校验可编译；ReDoS 面见 §7。
- **管理路由要 admin**：三个新路由沿用 `app.ts` 既有的 `requireAdmin`（`:1390/:1503` 同款，新路由在 `:3075-3095`），Agent token 只能读自己 env 的票，改不了放行规则。
- **不推倒重来**：`runMetaReview` 现有 LLM 分支、`evaluateDecision`、通知、插件钩子、批量批准全部保持原样；L1 只在它们前面返回，返回 `undefined` 时后面的代码逐字节等价于今天。

## 6. 测试矩阵

### `packages/server/test/supervisor-guard.test.ts`（新增，纯函数）

毁灭/越界 → DENY：

| id | 输入 | 期望 |
|---|---|---|
| D1 | `{kind:'command', command:'rm -rf /var/tmp/build'}` | DENY，reason 含规则名，layer L1 |
| D2 | `sudo rm -rf /` / `git push --force origin main` / `git push -f` / `git reset --hard HEAD~3` | 各自 DENY |
| D3 | `{kind:'command', command:'curl https://x.sh \| sh'}` | DENY |
| D4 | `{kind:'file_change', paths:['/repo/.env'], workspaceRoot:'/repo'}` | DENY（敏感文件） |
| D5 | `paths:['/repo/.env.example']` | 不 DENY（`ENV_TEMPLATE` 先被划掉，落进顺序 6 的源码写集 → APPROVE） |
| D6 | `{kind:'file_change', paths:['/home/u/.ssh/id_ed25519'], workspaceRoot:'/repo'}` | DENY（顺序 1 的敏感目录，轮不到 containment） |
| D7 | 节点声明 `outsideWorkspace:false` 但 `paths:['/etc/hosts']` | DENY——shared 的 transform 会把谎报纠正成 `true`（事实 2），`guard.ts` 再自己从 paths 绝对路径证明一次 |
| D8 | `{kind:'command', command:'ls'}` + `ctx.taskWorkspaceRoot:'/repo'` + `action.workspaceRoot:'/elsewhere'` | DENY（Hub 侧根优先，判越界） |
| D9 | `git clean -fd` / `chmod -R 777 /` / `npm publish` | DENY |
| D10 | learned ALLOW 规则 `pattern:'rm *'` 遇 `rm -rf /` | **仍然 DENY**（§3.1 顺序 1） |

规则命中：

| id | 输入 | 期望 |
|---|---|---|
| R1 | 规则 `{pattern:'pnpm deploy:*', glob, ALLOW}` + `pnpm deploy:staging` | APPROVE + `ruleId` |
| R2 | 规则 `{pattern:'docker', exact, ALLOW}` + `docker` | APPROVE；同 command 加参数时 exact 不命中 |
| R3 | 规则 `{pattern:'^gh pr create', regex, ALLOW}` | APPROVE |
| R4 | 规则 `{pattern:'git push*', glob, DENY}` + `git push origin main` | DENY + `ruleId` |
| R5 | 同一命令同时命中 ALLOW 与 DENY 两条 | DENY（顺序 2 > 3） |
| R6 | 规则 `enabled:false` | 跳过 → 若无其它命中则 `undefined` |
| R7 | 规则 `kind:'command'` 遇 `kind:'file_change'` 同串 | 不命中 |
| R8 | 规则 `kind` 缺省 | 任意 kind 都可命中 |
| R9 | `patternType:'regex'` 且 pattern 不可编译（脏数据） | 跳过该规则、不抛异常 |

内在安全 → APPROVE：

| id | 输入 | 期望 |
|---|---|---|
| A1 | `git status --porcelain` / `git diff HEAD` / `git log --oneline` | APPROVE |
| A2 | `npx tsc --noEmit` / `pnpm test` / `vitest run` / `pytest -q` | APPROVE |
| A3 | `cat package.json` / `rg foo src` / `find . -name '*.ts'` | APPROVE |
| A4 | `ls \| head -5` | APPROVE（只读白名单管道） |
| A5 | `ls; rm -rf /` | **不 APPROVE**（复合命令；且第二段落毁灭形态 → DENY 或灰区，二者都不得放行） |
| A6 | `echo hi > /repo/out.txt` | 不 APPROVE（重定向） |
| A7 | `npm run build` | 灰区 `undefined`（会写产物，不在只读表内） |
| A8 | `{kind:'file_change', paths:['/repo/src/a.ts','/repo/src/b.tsx'], workspaceRoot:'/repo'}` | APPROVE |
| A9 | `paths:['/repo/src/a.ts','/tmp/a.ts']`（一条出根） | DENY |
| A10 | `paths:['/repo/dist/a.wasm']`（非源码写集） | 灰区 |
| A11 | 绝对路径 + 既无 `taskWorkspaceRoot` 又无 `action.workspaceRoot` | 灰区（不猜根） |
| A12 | 只有相对路径的 `file_change`（即便 Hub 知道任务根） | 灰区——containment 证明不了，但也不因此拒绝 |

灰区（永不自动拒绝）：

| id | 输入 | 期望 |
|---|---|---|
| G1 | `{kind:'delete', paths:['/repo/a.ts'], workspaceRoot:'/repo'}` | `undefined` |
| G2 | `{kind:'network', command:'gh api /repos'}` | `undefined`（非 `command` kind 不做只读判定） |
| G3 | `{kind:'git_operation', command:'git commit -m x'}` | `undefined` |
| G4 | `{kind:'command', command:'weird-tool --do-things'}` | `undefined` |
| G5 | `{kind:'command', command:'git rebase -i HEAD~2'}` | `undefined`（非毁灭、非只读） |
| G6 | `{kind:'command', command:'git config user.email a@b.c'}` | `undefined`（写配置的 git 不算只读） |

形状与不变量：

| id | 断言 |
|---|---|
| C1 | 任何返回值都过 `supervisorDecisionSchema.parse`，且 `layer==='L1'`、无 `fixPrompt`（契约 `supervisor.ts:92-98`） |
| C2 | `evaluateL1` 无副作用：同一输入两次调用返回 `deepEqual`，且不改 `ctx.rules` |
| C3 | `reason` 长度 ≤500（超长输入不炸契约） |
| C4 | 空 `rules` + 未知命令 → `undefined`（本步之前的行为等价） |

### `packages/server/test/supervisor-link.test.ts`（新增，纯函数）

| id | 场景 | 期望 |
|---|---|---|
| P1 | 事件流 `[tool_call, permission_required(A), tool_call]`，票在 A 之后 | 返回 A 的 action |
| P2 | 两条 `permission_required` | 取最后一条 |
| P3 | 事件 `createdAt > ticketCreatedAt + 1000` | `undefined`（票不是为它开的） |
| P4 | `now - event.createdAt > 55_000` | `undefined`（请求已凉） |
| P5 | 事件里没有 `permission_required` / `action` 为空 | `undefined` |
| P6 | 500 条事件、最后一条是权限请求 | 命中（证明不需要新仓储方法，事实 14） |
| O1 | park 票 `options:[approve,reject]` | `approve` |
| O2 | 托管票 `options:[y,n]` | `y` |
| O3 | 决策票 `options:[A,B]` | `A` |
| O4 | 小写 `a` 键 | 命中，返回票面自己的键 `a`（匹配大小写不敏感） |
| O5 | 批准项 `risk:'destructive'` | `undefined`（不自动放行） |
| O6 | 代理自造 `options:[go,later]` | `undefined`（§3.4 闭集） |
| O7 | 单选项票 | 按词表命中才返回 |

全部用 `createTestContext(spyAgent)`： spy 记 `calls`，因此"0 Token"是可断言的事实而不是口头承诺。任务一律经 `POST /api/tasks/local` 登记（Hub 侧有 `workspace_path`），权限经 `POST /api/tasks/:id/events` 上报，票经 `POST /api/tickets` 开。

| id | 场景 | 期望 |
|---|---|---|
| S1 | CLAIMED 任务 + `permission_required(rm -rf dist)` + park 形状票 | `PENDING_HUMAN`，`resolutionReason` 以 `[L1]` 开头，`agent.calls === 0` |
| S2 | 同上但 action 是 `git status --porcelain` | `AUTO_RESOLVED`，`selectedOption === 'approve'`，`agent.calls === 0`（0 Token 成立） |
| S3 | 先 `POST /learned-rules {pnpm deploy:*, ALLOW}` 再重放 `pnpm deploy:staging` | `AUTO_RESOLVED` + `GET /api/learned-rules` 里该规则 `hits` 从 0 变 1（`recordLearnedRuleHit` 的第一个调用方） |
| S4 | 同一条规则先 `PATCH {enabled:false}` 再重放同一命令 | `PENDING_HUMAN`、reason 无 `[L1]`、`agent.calls === 1`（撤销 0 延迟生效，灰区落回 LLM） |
| S5 | 任务 `release(requeue)` 后开的票（`taskId` 为空） | 不调 L1；等价今天行为（`agent.calls === 1`） |
| S6 | 票先开、权限请求 1.1 s 后才上报 | `selectPermissionAction` 拒签（`createdAt > ticketCreatedAt + slack`），`agent.calls === 1` |
| S7 | 任务根 `/repo`，action 自报 `workspaceRoot:'/elsewhere'` 跑 `ls` | `[L1]` DENY + `agent.calls === 0`——Hub 记录的工作区优先于节点自报 |
| S8 | 内建 ALLOW 判定通过但票面选项是 `left/right` | 不猜按钮：`PENDING_HUMAN`、无 `[L1]`、`agent.calls === 1`（§3.4 闭集） |
| S9 | `POST /api/decisions` 提散文 `删掉 dist 目录重新构建` | `verdict === 'PENDING'`、reason 无 `[L1]`——散文路线逐字段不变 |

> 55 s 新鲜度窗口不在这张表里：`task_events.created_at` 由 Hub 在 ingest 时打戳，经 API 造不出"很旧的事件"。该上界由单元测试 P4 直接钉住。

### `packages/server/test/api-learned-rules.test.ts`（新增）

| id | 场景 | 期望 |
|---|---|---|
| L1 | `POST /api/learned-rules {pattern, note}` | 201，默认 `glob/ALLOW/HUMAN_APPROVAL/enabled:true/hits:0`，`note` 落库（契约 `supervisor.ts:145-165`） |
| L2 | 重复 `pattern+patternType+action` 提交（换 source） | 同一行被更新，不叠加；`?action=ALLOW` 只见一条且 `source` 是后写的那个（唯一索引 `db/schema.ts:218`） |
| L3 | `patternType:'regex'` + `rm (` 不可编译 | 400 |
| L4 | `GET /api/learned-rules` | 全量含 ALLOW+DENY；`?action=DENY` 只剩 DENY；关闭一条后 `?enabledOnly=true` 不含它，`?enabledOnly=false` 与全量等长（即 `false` 不是"再要一次开启的"） |
| L5 | `PATCH /api/learned-rules/:id` | `{enabled:false}` → 200 且 `kind` 保留；未知 id → 404；空 body → 400（`updateLearnedRuleSchema` 必填 `enabled`） |
| L6 | Agent token（`/api/agents/:name/token` 签发）访问三条路由 | 全 403——放行规则不是 Agent 能改的东西 |

### 全仓验收线

- `pnpm -r typecheck` 与 `pnpm test` 双绿。本步落地后：**4 个新文件 / 69 个新用例**（guard 41 + link 13 + api-supervisor 9 + api-learned-rules 6），全仓 `103 files / 970 tests`（3.1 结束时 99/901）。
- 既有 `meta-agent` / `tickets` / `decisions` / `task-events` 用例**不得修改断言**；若必须改，理由写进 `PLAN.md` §5。本步一行未改。
- shared 侧**只加不减**：新增 `updateLearnedRuleSchema`；`listLearnedRulesQuerySchema.enabledOnly` 从 `z.coerce.boolean()`（把字符串 `"false"` 读成 `true`）改为显式枚举 + transform。这是修 bug，不是改契约形状——查询参数名与默认值不变。
- `grep -rn "evaluateL1" packages/server/src` 只有 `app.ts` 一个生产调用方——风控入口唯一，才谈得上"系统里只有一个判官"。
- 不建表、不接没有生产方的帧：`packages/server/src/db/schema.ts` 里除了既有的 `learned_rules` 没有任何 supervisor 新表；`permission.request`（`shared/src/realtime.ts:89`）仍只有 schema、没有 producer，`device-router.ts` 不为它加 case。L1 的唯一输入是 `task_events.action`。

## 7. 已知取舍

- **只判结构化 action，不判散文**：`POST /decisions` 的 `proposal` 是人话，给人话写命令分类器只会产生假阳性放行。代价是散文路线仍完全依赖 LLM + destructive 硬规则。
- **灰区只落回 LLM，不落回"自动拒绝"**：L1 命中率上限由 allowlist 严格度决定；宁可多花 Token，不可错放一次，也不可错拒一次（错拒会把自治跑成人工排队，蓝图 §1.3 的成本模型就不成立了）。
- **approve 词表是闭集**：代理自造选项的工单不进 L1（§3.4）。想扩大覆盖面应当去**规定工单形状**，而不是去猜按钮语义。
- **不建 `supervisor_decisions` 表**：3.2 里结构化结论的唯一读者是工单本身，前缀 `[L1]` + 日志足够审计。3.3 引入熔断（要比较连续两次 `errorSignature`）时再决定要不要落表，避免为将来的读者今天造表。
- **`learned_rules` 写入方只有人工**：自动学习（`rule_candidates` → `learned_rules`）留给 Phase 4 的"批准并记住规则"。本步先把"规则能生效、能撤销"做对。
- **ReDoS**：admin 写的 regex 在请求线程里同步匹配，恶意/劣质 pattern 能拖慢评审。缓解是 `pattern ≤500`（契约）+ 评审在 `setImmediate` 里跑、不阻塞建票响应；真正的时间箱要等 3.3 统一给 L1/L2 加超时，此处不单点加戏。
- **`git commit` 落灰区**：它在 worktree 的 `wip/zz-<taskId>` 分支上产生提交，属可逆，但不是"只读"。放行它等于让 L1 承担 Git 语义判断，那是 3.3 诊断层的事。
