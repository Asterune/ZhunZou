# Step 3.1 设计：`LogSanitizer` 终端日志降噪与高密度诊断

蓝图条目（`zhunzou_ai.md` Phase 3 / PLAN.md:69）：剥离 ANSI；折叠重复进度条/构建输出；提炼 `Error:`、TS 错误码、单测断言与堆栈，输出 ≤2000 字符高密度诊断。

本文先核实现状，再定语义、落点与测试矩阵。**实现前本文为准，实现后与设计不符处在 PLAN.md §5「Step 3.1 落地说明」记录。**

---

## 1. 现状核实（2026-11-13）

| 事实 | 位置 | 对本步的意义 |
| --- | --- | --- |
| `task_logs.error_signature / diagnosis / diff_hash` 三列已建、`appendTaskLogSchema` 已收、`repository.appendTaskLog` 已落库 | `server/src/db/client.ts:173-175,407-409`、`shared/src/schemas.ts:571-588`、`server/src/repository.ts:2120-2122` | Step 1.2 只给了**字段和列，没有写入方**——和 2.3 的 `managedBySupervisor` 是同一形状的空位 |
| 既有的签名口径：`chunk` 是 `src/pages/list.ts(24,7): error TS2322: …` ⇒ `errorSignature: 'TS2322 src/pages/list.ts'`；普通进度行三个字段都**不出现** | `server/test/db-task-diagnostics.test.ts:44-67,69-83` | 签名格式**已被测试钉死**，本步必须逐字对齐，否则 3.3 的相似度比较拿两套格式 |
| `diagnosis` 的注释是「the L2 diagnosis in one line」、`diffHash` 是「the git diff hash the supervisor judged」 | `server/src/db/schema.ts:308-312` | 这两个字段的语义主人是 **Step 3.3 的管家**，不是端侧。端侧写入等于替别人填答卷 |
| 端侧唯一日志出口是 `createLogSink(send, onError)`：缓冲 600ms 或 24KB 触发、按 `CHUNK_BYTES=12_000` 切片后 `send(stream, chunk)` | `bridge/src/wake/log-sink.ts:19-27,49-63,110-123` | 它已经是「本机字节 → Hub」的**唯一咽喉**：派单循环（`daemon.ts:242,256` `reportLog: sink.push`）与本地伴随（`wrappers/runner.ts:209-211`）共用一个咽喉，改这里等于两个生产者一起改 |
| 失败结论的写法：`result: tail(output) \|\| …`（派单）与 `truncate(tail.trim(), RESULT_CHARS=4_000)`（伴随） | `bridge/src/wake/adapters.ts:178,455,526`、`wrappers/runner.ts:49,441` | 两处都是**原始尾巴直出**：带 ANSI、带进度条、4000 字符里可能 3900 字符是 `Resolving: 99%` |
| 事件侧已有「跨 chunk 断行 + 超长行重同步」的成熟写法 | `bridge/src/wake/events.ts:44,57-108`（`MAX_LINE_BYTES = 64 * 1024`、`discarding` 标志） | 降噪器同样必须跨 chunk 组行，照抄这条经验，不重犯「一行不结束就永久沉默」的错 |
| 空闲判据里已经有一组错误/确认正则，且 2.3 明确把「统一脱敏/降噪」推给本步 | `bridge/src/wrappers/idle.ts:22,26,38-45,106`、`docs/design/wrappers-2.3.md:129` | `EVIDENCE_CHARS=600` 的原文尾巴是**已知待替换项**；`idle.ts` 的用途是「判是否卡住」（布尔），本步的用途是「说清卡在哪」（行），二者输入输出都不同 |
| 全仓没有任何 ANSI 剥离/进度折叠实现，也没有 `strip-ansi` 依赖；唯一的 ANSI 生产者是浏览器里的 xterm | `web/src/components/TerminalView.vue:35-43,171,181`、`grep` 无命中 | 降噪器是**净新增能力**，且必须做成零依赖（bridge 是 Cursor 一键安装的独立包） |
| 实时终端镜像走 WS `task.log` 帧直接 `repo.appendTaskLog({stream, chunk})`，`device/src/pty/*` 输出原始 ANSI | `server/src/realtime/device-router.ts:242-264`、`shared/src/realtime.ts:69` | 这条路径的字节是给 xterm 重放的，**本步不碰**：碰了实时终端就变成黑白电视 |
| 看板日志区把 `chunk` 原样塞进 `<pre>` | `web/src/components/LogViewer.vue:111-124` | 存进去什么就显示什么：Hub 存的日志降噪了，看板自然干净，**web 一行不用改**（符合「不加 UI 字段」） |
| `session.ts:434` 的 sink 发的是 `appendChatEvent`（聊天事件），不是任务日志 | `bridge/src/session.ts:434-438` | 聊天事件契约里没有 `errorSignature`，本步不扩展到它；不产生「写进没人读的字段」 |

结论：**列、校验、存储、读取、看板全都在**，本步缺的是三件——一个能把原始字节变成干净文本的流式降噪器、一个把错误行归一成可比较签名的提炼器、以及在 sink 上把签名随 chunk 一起报出去的那个口子。

---

## 2. 落点与边界

新增（全部增量文件，不新建包）：

- `packages/bridge/src/sanitizer/ansi.ts`：纯函数 `stripAnsi(text)` 与 `sanitizeAnsi(text) → {text, pending}`（`pending` 是跨 chunk 的半截转义序列）。
- `packages/bridge/src/sanitizer/progress.ts`：纯函数 `progressKey(line)` 与 `collapseRuns(lines)`（连续同形行折叠成一条 + 次数）。
- `packages/bridge/src/sanitizer/errors.ts`：纯函数 `looksLikeError(line)`、`extractErrors(text)` → 错误行/TS 码/断言/堆栈帧，`combineSignatures(findings)`，`buildDiagnosis(findings, {limit, total})`。
- `packages/bridge/src/sanitizer/log-sanitizer.ts`：`createLogSanitizer()`——按流组行的状态机，对外四个动作：`feed` / `settle` / `describe` / `summarize`。

改动（都是可选参数，默认行为与今天逐字节一致）：

- `packages/bridge/src/wake/log-sink.ts`：第三个可选参数 `{ sanitizer }`；`send` 多一个 `meta` 入参。
- `packages/bridge/src/wake/daemon.ts`：建任务 sink 时传入降噪器；失败结论优先用 `summarize()`。
- `packages/bridge/src/wrappers/runner.ts`：同上；失败结论改用 `summarize()`。

**本步不做**：

- 不写 `diagnosis` / `diffHash` 两列——语义主人是 Step 3.3（`schema.ts:308-312` 的注释为准）。本步只把 ≤2000 的诊断文本放进**已经有主人的地方**：`completeTask.result`（≤4000）。端侧写签名，管家写诊断，各交各的卷。工单的 `blockerQuestion` 本步不动，它的接入点在 3.2 建票时统一。
- 不改 `POST /api/tasks/:id/log`、`appendTaskLogSchema`（字段与上限 1.1/1.2 已给足），不改 `task_logs` 表。
- 不碰实时终端 WS 路径（`device-router.ts` / `device/src/pty/*` / `TerminalView.vue`）。
- 不碰中继给人看的字节：`zz run` 的 `io.writeStdout/writeStderr` 仍是原始输出，人在自己终端里该看到的颜色一点不少（降噪只作用于**上报**）。
- 不改 `idle.ts` 的判据与 `EVIDENCE_CHARS`：判「卡没卡」和说「卡在哪」分开，本步只把提炼能力做出来；尾巴脱敏的接入点在 3.2/3.3 建票时统一。
- 不加看板 UI、不加依赖。

---

## 3. 语义：什么叫「干净」

### 3.1 剥离 ANSI

去：CSI 序列（`\x1b[…最终字符`，含 256 色、光标移动、清行）、OSC 序列（`\x1b]…BEL` 或 `\x1b]\…\x1b\\`，含窗口标题）、双字符转义、除 `\n`/`\t` 之外的 C0 控制字符。留：`\n`、`\t`、`\r`（`\r` 是进度条的机制本身，不是噪声，交给 §3.2 处理）。

跨 chunk 的半截转义（`\x1b[` 落在一次喂入的末尾）不能当普通文本发出去——`sanitizeAnsi(text)` 返回 `{ text, pending }`，`pending` 就是末尾未闭合序列的原文，`feed` 把它扣下来并到下次的**开头**继续拼。这是 sink 缓冲之外唯一的跨调用状态，和 `events.ts` 的组行状态同级。扣着的片段超过 `MAX_ESCAPE_BYTES = 64` 时直接丢弃：一截 64 字节还没收尾的转义序列不是文本，留着只会把后面的真实输出也扣死。

### 3.2 折叠进度条/重复输出

`\r` 段（同一逻辑行被反复改写）：一组 `\r` 段只保留**最后一个非空段**——终端重放出来本来就是最后一帧，Hub 存中间帧纯属抄三遍屏幕。

`\n` 行（真·反复打印，如 `Progress: resolved 100, reused 50`）：把行归一成「形状键」——数字串替成 `#`、空格与常见 spinner/box 字符去掉。连续若干行形状键相同 ⇒ 折叠成**最后一行** + `（重复 N 次）`。

流式代价：一条行的「重复次数」只有看到下一行才知道。因此 `feed` 只输出**已定论**的行，形状键仍可能在延续的那一组扣在状态里；释放时机是（a）出现不同形状的行、（b）`settle()`——sink 每 600ms 冲刷前按流调用一次（与它既有的批量延迟同级，不额外加时延）、(c) 扣着的文本超过 `MAX_HELD_BYTES = 8 * 1024` 时强制释放（照抄 `events.ts:44` 的教训：宁可断行，不可永久沉默）。

### 3.3 提炼错误（`describe` / `summarize`）

识别四类，按出现顺序记录：

| 类别 | 输入长相 | 签名 |
| --- | --- | --- |
| TS 编译错误 | `src/pages/list.ts(24,7): error TS2322: Type "string" is not assignable…` | `TS2322 src/pages/list.ts`（**逐字对齐既有测试**：码 + 空格 + 文件，不带行列） |
| 断言失败 | `AssertionError: expected 1 to be 2`、`FAIL packages/x/test/y.test.ts > case` | `AssertionError <测试文件名或首个业务栈帧>` |
| 通用错误行 | `Error: …`、`error: …`、`fatal: …`、`TypeError: …`、`failed to …`、`permission denied` | `<词>: <归一化消息>` 整体小写、数字替 `#`、连续空白并一、≤160 字符（如 `error: no such file or directory`） |
| 堆栈 | `    at foo (/a/b.ts:1:2)` | 不单独成签名；作为**上一条错误**的上下文帧（最多 2 帧，优先业务帧；全是 `node:internal`/`node_modules` 时保留 1 帧运行栈） |

- `describe(chunk)`：对**即将发出的一块文本**给 `{ errorSignature }`。同一块里多个不同签名按出现顺序去重、最多 3 个用 ` \| ` 连接、总长钳到 500。没有错误行 ⇒ 返回 `{}`，字段整个不出现——这正是 `db-task-diagnostics.test.ts:69-83` 要求的形状。
- `summarize()`：整段运行的 ≤2000 字符高密度诊断。有序号、每条错误一行（`文件:行 + 消息`）、下面缩进带最多 2 个栈帧、尾部若有省略则注明「共 N 条，另有 M 条未列出」。
- **兜底**：一段输出里一个错误都没认出（`boom: model overloaded` 这类引擎自定义文案），`summarize()` 退化为「最后 15 行降噪文本」（每行钳 200 字符）；认出错误时**只用清单**，不再追加这段尾巴——两条通道都给会让结论翻倍且更难比对。全程无输出 ⇒ `''`，由调用方回落到原有文案。
- **`system` 流不作为证据**：管家自己写的 `[zhunzou] …` 旁白（含「执行失败：…」）会进 `feed`、会入库，但 `note()` 对 `system` 流跳过记账，否则一条失败任务的诊断会被我们自己的旁白占满，真正的引擎错误反而排不进去。
- 签名归一化的目的只有一个：给 3.3 的「连续两次报错相似度 >85%」提供可比字符串。因此数字、计数、耗时一律抹平，文件路径保留原样。

---

## 4. 与既有结构的共存

- **sink 的默认行为不变**：`createLogSink(send, onError)` 两个参数的调用（`session.ts:434` 的聊天事件）字节路径与今天完全一致；`send` 多出来的第三个实参被忽略即可。现有 6 条 `log-sink.test.ts` 用例不许改动断言。
- **不新增状态机边、不改路由、不改校验**：`appendTaskLogSchema` 早收 `errorSignature`，`repository` 早落库，`hub-client.appendTaskLog`（`:407-418`）只做 `appendTaskLogSchema.parse`，多传一个字段是**已允许输入**，不是放宽约束。
- **失败结论的替换是「优先」而非「覆盖」**：`result: summarize() || tail(output) || 原文案`。DONE 的 `result` 是 Agent 给人看的回答正文（`adapters.ts:450` 取的是 stdout），**一个字都不动**。
- **16KB 上限仍然守住**：`describe` 作用在切片后的 `chunk` 上，签名 ≤500，`chunk` 本身比原始字节更短（降噪只减不增，最多增加 `（重复 N 次）` 十几个字符）。`summarize()` ≤2000 < `completeTaskSchema.result` 的 4000。
- **内存有界**：每组流最多扣一行 + 一组同形行（`MAX_HELD_BYTES` 强制释放）；运行期错误记录最多留 `MAX_FINDINGS = 40` 条，超出只更新计数不增长。
- **看板与移动端的读法不变**：`LogViewer.vue` 还是读 `chunk`；`errorSignature` 是数据层字段，按既定口径**不往 UI 加展示**。

---

## 5. 安全边界

- 降噪器只做**删除与折叠**：不做字符串替换式的「打码」，不猜测敏感值；签名里只允许出现文件路径、错误码、被钳长的消息文本。真正的密钥脱敏是独立能力，不混进本步。
- 不进 shell：所有输入输出都是内存里的 `string`；不 `eval`、不拼命令。
- 签名与诊断文本有硬上限（500 / 2000），且只随 `appendTaskLog` 走已经在 2.3 通过校验的 HTTPS + `zz_` token 通道，不新增外发面。
- 原始字节仍然只在两条既有通道里流动：给人看的终端中继、给 xterm 的 WS 镜像。本步不给它们加任何转换，也不给它们加新接收方。

---

## 6. 测试矩阵

先写测试再实现（TDD）。全部是纯单元 + 三个已有集成文件的追加用例；不需要网络、终端或二进制。

### `packages/bridge/test/sanitizer-ansi.test.ts`（新增）

| # | 用例 | 断言 |
| --- | --- | --- |
| A1 | 颜色与复位 | `\x1b[38;5;196mboom\x1b[0m` ⇒ `boom`；结果不含 `\x1b` |
| A2 | 光标移动/清行/私有模式 | `\x1b[2K\x1b[1G`、`\x1b[?25l` ⇒ `''` |
| A3 | OSC 窗口标题 | BEL 收尾与 `\x1b\\` 收尾两种写法都只留正文 |
| A4 | 保留换行与制表 | `a\nb\tc` 原样；`\r` 原样（交给折叠层） |
| A5 | 控制字符 | `\x00`、`\x07`、`\x08` 被去掉，普通可打印字符不动 |
| A6 | `sanitizeAnsi` 完整序列 | 返回 `{text, pending:''}` |
| A7 | `sanitizeAnsi` 半截序列 | `\x1b[3`、`\x1b[38;5`、裸 `\x1b`、未收尾 OSC ⇒ 正文空、未闭合片段进 `pending` |
| A8 | 片段续喂 | 先 `\x1b[3` 再 `1mred\x1b[0m` ⇒ 合起来是 `red`，ANSI 不漏进正文 |

### `packages/bridge/test/sanitizer-progress.test.ts`（新增）

| # | 用例 | 断言 |
| --- | --- | --- |
| P1 | 形状键读计数器 | `progressKey('Resolving: 12%')` === `progressKey('Resolving: 87%')`；`foo 3/10` === `foo 9/10` |
| P2 | 不同内容不误折叠 | `progressKey('test a')` !== `progressKey('test b')` |
| P3 | spinner 字形不参与形状 | `⠋/⠙/✔ Building project`（U+2800 块）键相同 |
| P4 | 空行没有键 | `progressKey('')`、`progressKey('   ')` ⇒ `''` |
| P5 | `collapseRuns` 留最后一帧 | 5 条同形 ⇒ 1 条（最后一条）+ `（重复 5 次）` |
| P6 | 动画折叠到收尾字形 | `⠋/⠙/✔ Building…` ⇒ 只留 `✔ Building…（重复 3 次）` |
| P7 | 不相邻不合并 | 同形行中间夹一行别的 ⇒ 三行原样，不跨组合并 |
| P8 | 单行不标注 | 一组只有一条时不追加「重复 1 次」 |
| P9 | 空行原样穿过 | 空行打断分组但不被折叠 |

### `packages/bridge/test/sanitizer-errors.test.ts`（新增）

| # | 用例 | 断言 |
| --- | --- | --- |
| E1 | TS 错误签名（括号式） | `src/pages/list.ts(24,7): error TS2322: Type "string" …` ⇒ `signature` === `'TS2322 src/pages/list.ts'`（**与既有 Hub 测试逐字一致**） |
| E2 | 冒号式（tsc pretty 输出） | `src/a.ts:1:5 - error TS2304: …` ⇒ 同一形状 |
| E3 | 多个 TS 错误 | 两条不同文件/码 ⇒ 两个签名，按出现顺序 |
| E4 | 断言失败 | `FAIL …/y.test.ts > case` 后跟 `AssertionError: expected 1 to be 2` ⇒ 一条 finding，签名含测试文件 |
| E5 | 通用错误行 | `TypeError: …`、`  Error: no such file…` ⇒ 小写化 + 数字/空白归一的签名 |
| E6 | 既有判据短语 | `failed to …`、`Permission denied: …` 也认（与 `idle.ts` 同一套说法） |
| E7 | 数字抹平可比 | 两次仅耗时/计数不同的同义错误 ⇒ 签名**完全相同**（3.3 相似度比较的前提） |
| E8 | 栈帧归属 | 错误行后 4 个 `at` 帧 ⇒ 只取前 2 个业务帧，`node:internal`/`node_modules` 排除 |
| E9 | 全运行时栈 | 无业务帧 ⇒ 保留 1 个运行时帧 |
| E10 | 普通输出不产错误 | `pnpm test: 603 passed`、`hello world`、JSON 事件行 ⇒ 空 |
| E11 | `looksLikeError` 与折叠层同判据 | 同一行在两处判定一致 |
| E12 | `combineSignatures` | 最多 3 个、` \| ` 连接、去重、≤500 |
| E13 | 无错误 ⇒ `undefined` | 干净块不产生字段 |
| E14 | 诊断预算 | 40 条错误 ⇒ `buildDiagnosis` ≤2000，末尾「另有 N 条未列出」 |
| E15 | 预算内全列 | 2 条 ⇒ 序号 + `文件:行 码: 消息`，无省略标注 |

### `packages/bridge/test/sanitizer-log.test.ts`（新增，状态机）

| # | 用例 | 断言 |
| --- | --- | --- |
| L1 | 跨 chunk 组行 | 一行只在**下一行**或 `settle` 时才定论：`hello `+`world\n` 仍扣着，再喂一行才吐出 `hello world\n`（一行延迟是折叠的前提） |
| L2 | 跨 chunk 半截 ANSI | 片段扣住，续喂后正文正确 |
| L3 | `\r` 改写只留最后一帧 | 一次喂入 `Resolving: 10%\rResolving: 100%\n` ⇒ 只有 `Resolving: 100%` |
| L4 | `\r` 组跨 chunk | 分三次喂同一组改写 ⇒ 仍只有一帧（折叠不能因为 chunk 边界失效） |
| L5 | 同形行的流式折叠 | 三次 `Progress: resolved N…\n` 分三次喂 ⇒ 前两次不各自成条；`settle('stdout')` ⇒ 一条 + `（重复 3 次）` |
| L6 | 不同形状即定论 | 进度组后跟一行别的 ⇒ `feed` 立刻把整组吐出来 |
| L7 | 超长行强制释放 | 单行超过 `heldBytes` ⇒ 立刻有输出；`settle` 后**一个字节不丢**；后续行不受影响（不永久沉默） |
| L8 | 两流互不污染 | stdout 未结束的行不影响 stderr 的折叠与输出 |
| L9 | 空行不进正文 | `\n\x1b[0m[zhunzou] done\n` ⇒ 只留正文一行 |
| L10 | 错误行立刻出且不折叠 | 相邻两条 TS 错误各自成行，不带 `（重复 N 次）` |
| L11 | 不重复的流不丢字 | 三行普通输出拼接后逐字节等于原文 |
| L12 | 永不收尾的转义被丢弃 | 超 `MAX_ESCAPE_BYTES` 的片段丢掉后，后续正常行照旧送达 |
| L13 | 常量公开 | `MAX_HELD_BYTES`/`MAX_ESCAPE_BYTES` 可导入且有界 |
| L14 | `describe` 逐块签名 | TS 错误块 ⇒ `{errorSignature:'TS2322 src/pages/list.ts'}`；普通/空块 ⇒ `{}`（字段不出现） |
| L15 | `describe` 多签名钳长 | 一个块里 5 个不同错误 ⇒ 最多 3 个签名、` \| ` 连接、总长 ≤500 |
| L16 | `summarize` 命中错误 | ANSI + 进度条 + TS 错误 + 栈 + vitest 断言的混合输出 ⇒ ≤2000 字符，含 `TS2322`、文件行号、断言行、业务栈帧；不含 `\x1b`；不含被折叠的进度中间帧 |
| L17 | `summarize` 兜底 | 只有 `boom: model overloaded\n`（认不出错误）⇒ 含该行；全空输入 ⇒ `''` |
| L18 | 错误记录有界 | 200 条同签名错误 ⇒ ≤2000，且计数说明「共 200 条…未列出」（内部条数封顶） |
| L19 | `system` 旁白不作证据 | 只有管家旁白 ⇒ `summarize()` 为 `''`；随后真实错误 ⇒ 结论里只有真实错误 |

### `packages/bridge/test/log-sink.test.ts`（追加，不改既有断言）

| # | 用例 | 断言 |
| --- | --- | --- |
| S1 | 不传降噪器 | 与今天逐字节一致（回归护栏：既有 6 条用例断言一字未改） |
| S2 | 传降噪器 | `send` 拿到的是降噪器 `feed` 的返回值，不是原始字节 |
| S3 | meta 随行 | 错误块 ⇒ 第三实参 `{errorSignature}`；普通块 ⇒ `{}`（`{stream,chunk,meta}` 精确形状） |
| S4 | settle 时机 | 冲刷前**按流**调用 `settle`，扣着的末行不丢；只喂过 stdout 时 stderr 不产出空行 |
| S5 | 切片各自带 meta | 一个大缓冲切成多块 ⇒ 只有含错误的块带签名 |
| S6 | 重排队重新签名 | 瞬时失败重排队后重新发出的块签名仍与文本对应（顺序不变量沿用既有实现） |

### 集成：`packages/bridge/test/wrappers-runner.test.ts`（追加）

| # | 用例 | 断言 |
| --- | --- | --- |
| W1 | 上报降噪、中继原样 | 子进程输出彩色 + 进度条 ⇒ 人侧 `stdoutText()` 仍含 `\x1b`；`calls.logs` 的 `chunk` 不含 `\x1b`，且只留最后一帧 |
| W2 | 签名为真 | stderr 打 TS 错误 ⇒ 对应 `appendTaskLog` 入参为 `{stream:'stderr', chunk:该行, errorSignature:'TS2322 src/pages/list.ts'}` |
| W3 | 失败结论走诊断 | 60 条彩色 `Error: fault N` ⇒ `result` ≤2000、含首条与「未列出」、不含 `\x1b` |
| W4 | DONE 结论不动 | 即既有 R1 的 `result:'hello world'` 断言原样保持（回归护栏，不另开用例） |

### 集成：`packages/bridge/test/wake.test.ts`（追加）

| # | 用例 | 断言 |
| --- | --- | --- |
| D1 | 派单循环同样降噪 | `context.reportLog` 两次 `\r` 改写 ⇒ 只落一条 `{stream:'stdout', chunk:'…\n'}`，且**没有** `errorSignature` 键 |
| D2 | 失败 result 优先诊断 | FAILED + TS 错误 ⇒ `completeTask` 的 `result` 含 `TS2322`、≤2000，且日志行里带签名 |
| D3 | 无输出时结论不变 | 适配器给 `result:'端侧执行失败（无输出）'` ⇒ 诊断为空时原样回落（成功路径仍由既有 2.x 用例守） |

**验收线**：`pnpm typecheck` 与 `pnpm test` 全绿；既有 `log-sink` / `wrappers-runner` / `wake` 用例除新增行外**不得修改断言**（若必须改，写进 PLAN.md §5 说明理由）。

---

## 7. 已知取舍

- `diagnosis` / `diffHash` 两列本步继续留空：等 3.3 的管家写。字段先于写入方存在，是这个仓一贯的做法（1.1/1.2 就是这么给的）。
- 折叠只在「连续同形」范围内做：不跨不相邻的块去重，避免把两次真实的相同输出说成一次。
- 进度识别靠形状键而非引擎专用表：好处是任何 CLI 都受益，代价是理论上可能折叠掉连续两条含义不同但形状相同的行（如 `test 1` / `test 2`）。接受——`（重复 N 次）` 保留了计数，信息没丢。
- 降噪只作用于上报字节：人在自己终端看到的颜色、实时终端镜像都不变。代价是 Hub 存储与实时镜像不再是同一份文本，看板上的历史日志会比镜像更干净。
- 600ms 冲刷时 `settle()` 会让一组进度条「提前定论」：进度条跨 600ms 以上时会出现两条折叠记录而非一条。这是与 sink 既有批量延迟一致的取舍，不为此加计时器。
