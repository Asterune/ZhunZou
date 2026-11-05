# 准奏（Zhunzou）· 界面重设计功能说明（PC + PWA）

> 用途：交给 Stitch / Figma AI 做**界面重设计**时的功能底稿。
> 本文件描述的是**当前已经实现的功能与真实交互**，不是设想。文末附可直接粘贴给 Stitch 的分屏 Prompt。
>
> 版本：v2 · 与当前代码同步（6 个页签、长轮询同步、PWA 已上线）。
> 注意：`docs/UI_BRIEF.md` 是更早的 v1，只覆盖 3 个页签，已不足以描述现状；本文件为准。

---

## 0. 先看这一段（给设计工具的硬约束）

- 产品界面语言：**简体中文为主，可切换 English**（右上角语言切换，登录页也有）。
- 形态：**单页响应式 Web 应用**，桌面浏览器与手机浏览器共用一套代码；手机可「添加到主屏幕」以 PWA 独立窗口运行。
- 当前是**浅色主题**，没有深色模式。
- 用户名下可能有**多个 Agent 接入端、多个项目、多张工单并发**，信息密度不能过低。
- 最重要的一次操作是：**在 10 秒内看懂一张待批工单并点一个方案**。所有布局取舍都要服务于这一点。
- 不要设计「在 Web 里创建决策工单」——工单只能由 Agent 通过 API 创建。Web 端只负责人工审批、下发任务、会话、接入端管理、历史与规则。

---

## 1. 产品定位

**一句话：** 准奏是 AI Agent 的异步决策中枢。Agent 遇到需要人类拍板的卡点时，提交「三行简报 + 2~6 个封闭选项」；总管 Agent 先按团队规范自动处理大部分问题，剩下的进入看板，人类点一下，正在等待的 Agent 立即恢复执行。

**英文定位：**
> Zhunzou — Approve once, unblock every agent.
> An async decision hub where AI coding agents escalate blockers, a meta-agent auto-approves routine choices from team rules, and the human approves the rest in one click.

**典型用户：** 同时跑多个仓库、多个 IDE / Agent（Cursor、OpenCode、Claude Code、Codex、Gemini、Windsurf、任意 MCP 客户端）的开发者或小团队。

**核心闭环：**

```text
Agent 卡住
  → 提交三行简报 + 封闭选项（可标高危）
  → 总管 Agent 按 GLOBAL_RULES.md 预审
      → 常规：几秒内自动准奏
      → 其余：进入待批队列 + 通知
  → 人在 PC 看板 / 手机 PWA / 通知里的签名链接点一下
  → 端侧长轮询立即唤醒 Agent
  → 本次批复沉淀为候选规则
```

---

## 2. 当前实现事实

| 项 | 现状 |
| --- | --- |
| 前端 | Vue 3 + Vite + TailwindCSS 4，单页应用，无路由库；页签用 `?tab=` 查询参数记忆 |
| 后端 | Fastify + SQLite，单进程单实例 |
| 部署 | 默认由后端**同端口托管前端构建产物**，无 CORS；也支持 HTTPS / 反代 |
| 登录 | 粘贴服务端 Token，存本机 `localStorage`；401 自动退出 |
| 数据同步 | 看板走 **长轮询** `GET /api/sync`：空闲时约 25 秒一次请求，数据变化立即推送；断线 4 秒后重试；右上角有连接状态与最近同步时间 |
| 数据范围 | 一次快照包含最新 200 张工单、200 个任务、全部接入端与项目绑定、最近 100 条会话摘要；**历史页没有服务端分页**，只在前端搜索/筛选 |
| 语言 | 中文 / English 运行时切换，文案集中在 i18n 表 |
| PWA | 可安装；Service Worker 缓存；离线页；应用内更新提示 |
| 独立页面 | 除主看板外，还有服务端渲染的**签名审批页** `/a/:token` 和**离线页** `/offline.html` |
| 通知 | Bark / 飞书 / Slack / Discord / ntfy / Telegram / Webhook / 控制台；通知可带签名审批链接 |

---

## 3. 信息架构

```text
未登录
└── 登录门

已登录
└── 主看板
    ├── 顶栏：品牌 / 6 个页签 / 语言 / 刷新 / 退出 / 连接状态
    ├── 接入端状态栏（所有页签都显示，常驻）
    ├── 断网横幅（仅断线时）
    ├── 页签 1 待批奏折（默认）
    ├── 页签 2 下发任务
    ├── 页签 3 会话
    ├── 页签 4 接入端
    ├── 页签 5 历史决策
    └── 页签 6 规则配置
    └── 全局浮层：Toast / 批量准奏对话框 / PWA 更新提示

主看板之外
├── 签名审批页 /a/:token        （手机通知点开，免登录）
└── 离线页 /offline.html        （断网且无缓存时）
```

**桌面端**：顶栏横向 6 个页签，内容最大宽度约 1152px 居中。
**移动端 / PWA**：顶栏只保留品牌、连接状态、语言、刷新、退出；6 个页签变成**底部固定导航**（带角标）。

---

## 4. 全局外壳

### 4.1 顶栏（始终存在）

- 印章式品牌标记「准」+ 产品名「准奏」+ 英文小字 `Zhunzou`。
- 连接状态：绿点「已连接」/ 红点「连接中断」/ 灰点「连接中」，旁边显示最近同步时间（相对时间，如「刚刚」「2 分钟前」）。
- 桌面：6 个页签 + 数量角标：
  - 待批奏折（待处理工单数）
  - 下发任务（未结束任务数）
  - 会话（无角标）
  - 接入端（接入端总数）
  - 历史决策（无角标）
  - 规则配置（无角标）
- 右侧：语言切换（中 / EN）、立即刷新（同步中旋转）、退出登录。
- 移动端：页签移到底部；顶部保留连接状态、语言、刷新、退出。

### 4.2 接入端状态栏（所有页签顶部常驻）

横向卡片列表（手机横向滚动，桌面自动网格）：

- 环境名（如 `company-cursor`，等宽字体）
- 在线圆点：运行中（绿）/ 等待决策（琥珀，带呼吸动画）/ 空闲（灰）/ 离线（灰）
- 状态徽标：`运行中` / `等待决策` / `空闲` / `离线` / `已停用`
- 当前项目名、当前任务（没有则「暂无活跃任务」）
- 最近心跳相对时间
- 「等待决策」时额外显示「等待审批」
- 90 秒无心跳即视为离线；已停用的接入端置灰
- 空状态：暂无接入端心跳，启动 Cursor / OpenCode 后自动出现
- 右上角有「N / M 在线」与「自动轮询中」提示

### 4.3 断网横幅

- 仅在连接中断时出现，位于顶栏下方、状态栏上方。
- 红色 / 琥珀色条 + Wi-Fi 断开图标 + 错误原因 + 「重试」按钮。
- 保留旧数据，不清空页面。

### 4.4 Toast

- 成功 / 错误 / 信息三种。
- 桌面右下角、手机底部居中（避开底部导航与安全区）。
- 4 秒自动消失，点击可关闭。

### 4.5 PWA 更新提示

- 检测到新版本时弹出模态框（桌面居中、手机底部抽屉式）。
- 标题「发现新版本」，说明「新版本已下载完成，更新后即可使用最新功能。」
- 两个操作：「之后更新」「立即更新」；更新中显示 loading。
- 「之后更新」本次会话不再打扰，下次打开再提示。

---

## 5. 页签 1：待批奏折（核心页面）

**目标：** 10 秒内看懂一张工单并完成审批。

### 5.1 页头

- 标题「御览奏折」+ 数量徽标「N 封急奏」
- 右侧提示「三思而后决 · 即批即行」
- 待批超过 1 张时出现「批量准奏」按钮

### 5.2 排序与布局

- 按创建时间从早到晚排队（最久的在最前）。
- 桌面宽屏可多列卡片（每列最小约 380px）；中小屏单列。
- 空状态：大字标题「天下太平 · 暂无待批奏折」+ 说明「各方 Agent 皆顺畅运行中。若有新疑难阻塞，自当飞鸽传书，立呈御前。」+ 「调度守护进程处于待命监听状态」。

### 5.3 工单卡片（重设计的重点对象）

卡片必须承载以下信息与操作，顺序可按视觉优化调整，但**不能删减语义**：

1. **水印**：右上角淡色「待批」印章。
2. **头部**：
   - `#104`（等宽、主色）
   - 项目名（标题级）
   - `env: company-cursor` 小标签
   - 相对时间「3 分钟前起奏」
   - 状态徽标：`总管预审中` / `待批奏折`
3. **三行简报**（固定结构）：
   - ①「已完成进展」：绿色对勾 + 文本
   - ②「请旨阻塞关键抉择」：**全卡视觉焦点**，朱红侧边条 + 加粗文本
   - ③「候命下一步」：箭头 + 文本
4. **总管预审中提示**（仅 `PENDING_META`）：
   「总管 Agent 正在按 GLOBAL_RULES.md 预审，通常几秒内自动处理；你也可以直接拍板。」
5. **总管为何不敢批**（仅 `PENDING_HUMAN` 且有理由）：
   机器人图标 + 预审理由 / 转人工原因。
6. **超时默认裁决条**（仅配置了 `AUTO_RESOLVE_TIMEOUT_MS` 且尚未到期）：
   - 倒计时 `mm:ss` / `h:mm:ss`
   - 「后默认准奏方案 A」
   - 推荐方案为 `destructive` 时显示「高风险，不会自动执行」
   - 「暂缓 10 分钟」按钮
   - 到期后显示「已到时限，正在执行默认裁决…」
7. **端侧离线警告**（该 env 已离线）：
   - 警示图标 +「端侧 company-cursor 已离线，工单可能已无人等待。」
   - 「取消工单」按钮；第一次点击变「再次点击确认取消」，4 秒内再点才真正取消。
8. **批红备忘 / 补充指令**（选填）：
   - 2 行 textarea，最多 2000 字
   - 标签旁提示「随审批一起发送」
   - 占位示例「例如：先只改登录页，其他页面下个迭代处理」
9. **抉择分支**（2~6 个封闭选项）：
   - 每项展示：选项字母 / key、label、可选 `prosCons`（利弊说明）
   - 推荐项高亮 + 「推荐」徽标（**只高亮，不默认选中**）
   - 高风险项红色语义 + 「高风险」徽标
   - 点击即提交审批；提交中显示 loading，全部按钮禁用
   - `destructive` 选项需要**同一按钮二次点击**（第一次变「再次点击确认」，4 秒超时复位）
   - 普通项右侧显示「准奏」，高危项显示「确认」
10. **卡片底部**：
    「点击选项即提交审批 · 批红后 Agent 将立即恢复运行 · 高风险选项需二次确认」

### 5.4 批量准奏对话框

- 由待批页「批量准奏」打开。
- 列出本批次工单：`#id`、项目名、将采用的推荐方案字母；高危项带「高风险」标签。
- 说明「将按每封奏折的推荐方案分别批复。」
- 若有高风险推荐项：显示复选框「同时批准 N 封高风险方案。」并说明「不勾选时这些奏折会被跳过，保留人工确认。」
- 无高风险时显示「本批次没有高风险方案，可直接准奏。」
- 主按钮「准奏 N 封」→ 点击后进入 **3 秒倒计时撤销窗口**：按钮变「N 秒后提交 · 撤销」，再点一次即取消；倒计时结束自动提交。
- 桌面居中模态，手机底部抽屉，避开安全区。

---

## 6. 页签 2：下发任务（人 → Agent）

**目标：** 人主动把一条任务派给某个接入端 / 项目，Agent 领取后执行并回传输出。

### 6.1 页头

- 小标题 `Dispatch Desk · 自上而下 · 差遣`
- 标题「下发任务」+「待办 N 项」
- 右侧提示「Agent 调用 agent_hub_next_task 即可领取」

### 6.2 下发表单

- **目标环境**：下拉，列出已接入 env，并标注「· 在线 / · 离线」；默认选中第一个。
- **项目名（选填）**：下拉只列出该 env 已绑定的项目；若没有绑定，提示「该工作区还没有绑定项目，可在下方直接绑定。」
- **工作区项目绑定**（表单内嵌区域）：
  - 展示当前 env 已绑定项目的 chips
  - 「绑定项目」：从 Agent 已上报过的项目中选择，不需要手输
  - 每个 chip 可解除绑定；**当前活跃项目不可解除**（心跳会自动重新绑定）
  - 没有绑定：显示「尚未绑定项目 · Agent 心跳会自动上报工作区」
  - 所有已知项目都绑定后提示「已绑定全部已知项目」
- **任务标题**：单行，最多 200 字，占位「一句话说明要做什么」
- **详细指令**：多行，最多 2000 字，占位说明目标 / 边界 / 验收标准
- 底部提示「任务会排队到下一位在线的同环境 Agent 领取，不会打断正在审批的工单。」
- 主按钮「下发任务」；提交中「下发中…」
- 环境 / 标题 / 指令都必填才可提交。

### 6.3 待办与执行中列表

- 标题「待办与执行中」，未结束任务按创建时间从早到晚排队（最早下发的先执行）；「已结束」区按最近更新倒序。
- 任务卡：
  - `#id`、标题、状态徽标（`待领取` / `执行中` / `已完成` / `失败` / `已取消`）
  - 领取次数 > 1 时显示「第 N 次领取」
  - `env` 标签、项目名、下发相对时间
  - 「查看输出 / 收起输出」按钮
  - 「取消」按钮（取消中 loading）
  - 指令全文
  - 执行中时显示「Agent 已领取，执行中 · 3 分钟前」
- 输出查看器（展开后）：
  - 终端风格深色面板，等宽字体
  - 区分 stdout / stderr（红）/ system（黄）
  - 执行中实时增量拉取（约 1.2 秒一次），自动滚到底
  - 结束后可回看；单任务最多保留 256 KB
  - 标题「执行输出」+「实时」指示；无输出时「无输出 / 等待输出…」
- 空状态：「暂无待办任务 / 在上方写下任务，指定环境后 Agent 领取即开始执行。」

### 6.4 已结束

- 标题「已结束 · 共 N 条」
- 紧凑列表：`#id`、状态、env、更新时间、标题、结果文本、「输出」按钮。
- 失败状态用红色徽标。

---

## 7. 页签 3：会话（人 ↔ Agent 多轮对话）

**目标：** 在看板里直接和任意项目的 Agent 多轮对话，输出实时回传。

### 7.1 页头

- 标题「会话」+ 说明「与任意项目的 Agent 多轮对话」
- 右上「新建会话」

### 7.2 新建会话对话框

- 目标环境：下拉，**只允许选在线 Agent**；离线项可见但禁用并标注「· 离线」
- 没有在线 Agent 时提示「当前没有在线 Agent，先把端侧 runner 启动起来再新建会话。」
- 项目（可选）：只列该 env 的项目，默认「使用项目默认目录」
- 标题（可选）：最多 120 字，占位「例如：重构登录页」
- 「取消 / 创建」

### 7.3 会话列表（桌面左侧 280px，手机在对话上方）

- 「全部会话」+ 刷新按钮
- 每项：标题、`已关闭` 徽标、env 标签、项目名、「N 条消息 · 3 分钟前 / 刚创建」
- 选中项高亮
- 每项右上角有删除按钮（手机常显，桌面悬停显示），二次确认后永久删除会话及其消息与输出记录
- 列表高度与右侧对话区一致（`clamp(420px, 100dvh - 14rem, 760px)`），超出内部滚动；手机上限 45dvh
- 空状态：「还没有会话。点「新建会话」选一个在线 Agent 开始。」

### 7.4 对话区

- 头部：会话标题、env、项目、状态（「在线」绿点 / 「端侧离线」红点 / 「已关闭」）、「关闭」按钮（仅 ACTIVE 会话）
- 消息流：用户消息靠右（主色气泡），助手 / 系统消息靠左（浅色气泡）
- 用户消息状态：
  - 待领取：「等待端侧领取…」；离线时「等待端侧领取…（该环境当前离线）」
  - 失败：红字错误 + 「重试」按钮
- 正在执行的那一轮下方内嵌**实时输出面板**（同上，终端风格、增量、自动滚动）
- 空对话：「发送第一条消息开始对话。」
- 输入区：
  - textarea 2 行，最多 32000 字，Enter 发送 / Shift+Enter 换行
  - 发送按钮圆形箭头
  - 底部提示「会话由端侧 runner 执行；本机需要常驻 `wake` 或 `fleet`，否则消息会停在待领取。」
- 会话关闭后输入框禁用，不能再发消息。
- 桌面为左右两栏；手机上下堆叠。对话区高度自适应视口（约 420~760px）。

---

## 8. 页签 4：接入端管理

**目标：** 把每个 Agent 运行环境当成可管理资产：看状态、改名称、签发 Token、停用、删除。

### 8.1 页头

- 标题「接入端管理」+「N 个 · M 个离线」
- 「刷新」「登记接入端」

### 8.2 运行节点汇总（按主机分组）

- 每张节点卡：主机名、在线数 / 总数、托管项目数、停用数、系统、bridge 版本、最近心跳
- 排序：在线优先、接入端数量多优先、主机名
- 空主机显示「未上报主机」

### 8.3 接入端卡片

- 在线圆点 + env（等宽）+ 状态徽标（在线 / 离线 / 已停用）
- 显示名称 · 客户端类型
- 编辑按钮（铅笔）
- 信息网格：当前项目、最近心跳、版本 / 主机、系统
- 当前任务（有则显示）
- **最近一次会话摘要**（该 env 最新镜像的「追问 / 结论」+ 时间）
- Token 区：
  - 已签发：`zz_••••` 前缀占位
  - 「签发 / 轮换」按钮；已签发时还有「吊销」
  - 停用的接入端不能签发
- 底部「停用 / 启用」「删除」
- 删除 / 吊销前用浏览器原生确认框二次确认

### 8.4 登记 / 编辑对话框

- env 标识（新增时可编辑，编辑时禁用）、显示名称、客户端类型（Cursor / OpenCode / Claude Code / Codex / Gemini / Windsurf / 其他）
- 保存 / 取消

### 8.5 一次性 Token 对话框

- 说明这是该 env 的专属 Token，只显示一次
- 令牌全文 + 「复制 / 已复制」
- 警告：「关闭后无法再次查看；如果丢失，只能轮换生成新 Token（旧 Token 立即失效）。」
- 引导写入该端 `HUB_TOKEN`，不要共用管理员 `HUB_SECRET_TOKEN`

### 8.6 空状态

- 「尚无接入端」
- 引导在项目里运行 `npx zhunzou-bridge init`，桥接第一次心跳后自动出现；也可以手动登记。

---

## 9. 页签 5：历史决策

**目标：** 回看所有已结束的工单与裁决依据。

- 页头：`Archive Dossier · 文书御批宗卷`、「历史决策」、「共 N 条」、「最近更新的排在前面」
- 搜索框：检索编号、项目、卡点、批复意见、补充指令、自动理由
- 筛选 chips（带数量）：全部 / 人工审批 / 总管自动 / 超时默认 / 已取消
- 列表按更新时间倒序，紧凑卡片：
  - 右上水印徽标：
    - 人工：「准奏 · 裁定」
    - 总管：「机断 · 例行」
    - 超时：「超时 · 默认」
    - 取消：「已取消」
  - `#id`、项目名、env、更新时间（悬停显示精确时间）
  - 状态徽标
  - 裁决来源图标 + `总管自动 / 超时默认 / 人工审批`
  - 取消的工单显示「端侧取消」
  - 「奏请决议点」：卡点问题
  - 最终方案：「方案 A · Toast 提示」
  - 「批」备注：补充指令或自动审批理由
- 空状态：「宗卷空寂 · 暂无记录 / 审批或取消工单后，记录会出现在这里。」
- 搜索无结果：空状态 + 「重置筛选」
- 说明：当前只加载最近 200 张工单，搜索与筛选均在前端完成。

---

## 10. 页签 6：规则配置

**目标：** 在线编辑 `GLOBAL_RULES.md`，并处理「批复沉淀」候选规则。

### 10.1 页头

- `Meta-Agent Policy · 御批枢密章法`
- 标题「全局工程与架构规范」
- 说明「Meta-Agent 预审的唯一依据。保存后立即生效，无需重启服务。」

### 10.2 候选规则收件箱（页面顶部）

- 标题「御前待议 · 批复沉淀」+ 待处理数量
- 说明「从人工批复中提炼的候选规则，采纳后立即并入 GLOBAL_RULES.md。」
- 每条：`#id`、来自工单 `#N`、时间、规则正文
- 操作：「忽略」「采纳」
- 空状态：「暂无候选规则。每次人工批复后，系统会自动提炼一条可复用规范，供你一键采纳。」
- 刷新按钮

### 10.3 规则编辑器

- 文件名 `GLOBAL_RULES.md`
- 字符数 / 行数、更新于
- 有未保存修改：圆点 + 「有未保存修改」徽标
- 「重新加载」「保存规则并生效 / 已保存 / 颁行中…」
- 编辑器：等宽字体、行号栏、Markdown 纯文本、约 480px 高、可复制全文
- 页脚提示「保存后 Meta-Agent 立即使用新规则」
- 未保存时保存按钮才可用；重新加载会覆盖草稿

### 10.4 侧栏提示

- 「怎么写更省事」三条：
  - 写清上下文边界（如 feature/* 自动放行，main 合并必须人工）
  - 规则越具体，自动放行率越高
  - 把底线写死（删除数据、schema 变更、生产配置一律人工）
- 「示例偏好」三条
- 提醒：修改会直接写入服务器文件，建议纳入版本管理
- 手机端侧栏移到编辑器下方

---

## 11. 签名审批页 `/a/:token`（独立、免登录、手机优先）

通知（Bark / 飞书 / Slack / Discord / ntfy / Telegram / Webhook）里点开的落地页。**不在主看板内**，由服务端直接渲染 HTML，所以设计上要单独出一套样式。

- 顶部小字「准奏 · 待批奏折」
- 标题：`#104` · 项目名
- 副信息：`env` · 创建时间
- 三行简报：已完成进展 / 请旨阻塞关键抉择（朱红侧条）/ 候命下一步
- 选项：单选卡片，展示 key、label、利弊、推荐徽标、高风险 / 需谨慎标签
- 批红备忘 / 补充指令 textarea
- 高危工单显示复选框「我确认这是高风险 / 不可逆操作」
- 主按钮「准 奏」
- 提示：「点击后 Agent 会立即恢复执行；高风险选项必须勾选确认。」
- 成功 / 失败结果页：圆形标记 + 标题 + 说明 + 「打开完整看板」
- 链接默认 30 分钟过期、只绑定一张工单；重复提交会被拒绝
- 该页**不走 Service Worker 缓存**，必须实时访问

---

## 12. 离线页 `/offline.html`

- 印章「准」+ 标题「当前离线 · You are offline」
- 说明「准奏需要连接 Hub 才能读取奏折和任务。网络恢复后点下方按钮重试。」
- 按钮「重新连接 · Retry」
- 监听 `online` 事件自动刷新
- 中英双语、极简、单屏居中

---

## 13. 数据与状态字典

### 13.1 工单状态

| 状态 | 中文 | 语义 |
| --- | --- | --- |
| `PENDING_META` | 总管预审中 | 通常几秒内结束，人也可以直接批 |
| `PENDING_HUMAN` | 待批奏折 | 需要人行动 |
| `AUTO_RESOLVED` | 总管准奏 | 已完成 |
| `HUMAN_RESOLVED` | 人工准奏 | 已完成 |
| `CANCELLED` | 已取消 | 端侧取消或人工取消 |

### 13.2 任务状态

`PENDING 待领取` → `CLAIMED 执行中` → `DONE 已完成 / FAILED 失败`；任意未结束状态可 `CANCELLED 已取消`。

### 13.3 接入端状态

`Running 运行中` / `Blocked 等待决策` / `Idle 空闲`；90 秒无心跳 = 离线；`active / disabled` 为管理状态。

### 13.4 会话状态

会话：`ACTIVE` / `CLOSED`。
消息：`PENDING` / `RUNNING` / `DONE` / `FAILED`。
角色：`user` / `assistant` / `system`。

### 13.5 选项风险

`safe`（默认，无标签）/ `caution`（需谨慎）/ `destructive`（高风险，永不自动执行，必须人工二次确认）。

### 13.6 客户端类型

Cursor / OpenCode / Claude Code / Codex / Gemini / Windsurf / 其他。

---

## 14. 跨页面交互与状态（设计时必须覆盖）

- **审批是即时的**：点击方案即提交，不做「选中 → 再点确认」的两段式（高危项除外，高危需同按钮二次点击）。
- **乐观更新**：提交成功后卡片立即从待批队列消失，后台再同步；失败弹错误 Toast。
- **重复审批**：服务端返回 409，UI 用 Toast 提示，不白屏。
- **批量审批**：3 秒撤销窗口是硬需求，不能省。
- **超时裁决**：倒计时必须每秒更新；「暂缓 10 分钟」要明显可点；高危推荐永不自动执行。
- **端侧离线**：工单卡要提示「可能已无人等待」，并允许取消。
- **Token 失效**：任何接口 401 → 清 Token、回登录页、提示「登录已过期，请重新输入 Token」。
- **网络中断**：顶部横幅 + 保留旧数据 + 重试；不要整页错误页。
- **页面隐藏**：会话列表与对话的定时轮询在页面隐藏时跳过拉取，回到前台立即刷新；主看板长轮询继续由浏览器调度。
- **深链接**：`?tab=pending|tasks|chat|agents|history|rules` 可直接打开指定页签；切换页签会写回 URL 并滚到顶部。
- **键盘**：聊天 Enter 发送 / Shift+Enter 换行；更新弹窗 Enter 确认、Esc 延后。
- **确认框**：删除接入端、吊销 Token、关闭会话目前用浏览器原生 `confirm`——重设计时建议换成统一的应用内确认对话框。
- **加载 / 空 / 错误 / 禁用**：每个列表、每个按钮、每个异步动作都要有这四态。

---

## 15. PC 端设计要求

- 内容最大宽度约 1152px，居中；顶栏 sticky。
- 6 个页签在桌面必须一屏放得下（含数量角标）；不要退化成横向滚动。
- 待批页宽屏建议 1~2 列卡片；单卡信息完整，不要为了多列把三行简报压扁。
- 任务、会话、规则页适合「主内容 + 侧栏」结构；接入端、历史适合卡片 / 列表。
- 桌面可用 hover 显示次级操作（复制、精确时间、解除绑定），但主操作必须常显。
- 日志 / 输出面板是深色终端风格，与浅色主界面形成对比；要保证等宽字体与换行可读。
- 键盘可达：Tab 序、焦点环、Esc 关闭模态、Enter 提交。
- 不要依赖右键菜单、拖拽、悬浮 tooltip 作为唯一入口。

---

## 16. PWA / 移动端设计要求

### 16.1 安装与运行形态

- `display: standalone`（优先）/ `minimal-ui` / `browser` 兜底。
- 独立窗口没有浏览器地址栏和前进后退：**页面内必须自带返回 / 关闭 / 页签导航**。
- 图标：192 / 512 普通图标 + 192 / 512 maskable + Apple Touch Icon。
- 主题色与背景色当前为暖纸白 `#fff8f5`。

### 16.2 安全区与视口

- `viewport-fit=cover`，必须处理 `env(safe-area-inset-top / bottom / left / right)`。
- 底部导航、Toast、底部抽屉、登录页都要避开 Home Indicator。
- 页面底部要给固定导航预留高度（当前约 6rem + 安全区）。
- 键盘弹起时，聊天输入框与发送按钮不能被遮住（使用 `100dvh` 而非 `100vh`）。

### 16.3 移动端导航

- 当前 6 个页签全部塞进底部导航，320px 宽度下每项约 53px，非常拥挤。
- 重设计建议：**底部保留 4 个高频入口**（待批奏折、下发任务、会话、更多），把接入端 / 历史 / 规则收进「更多」页或抽屉；接入端状态栏可折叠。
- 底部导航每项触控高度 ≥ 44px，激活态必须有文字 + 颜色双重标识。

### 16.4 触控与输入

- 所有可点区域 ≥ 44×44px；方案按钮当前最小高度 54px。
- 输入控件在触屏设备上字号 ≥ 16px，避免 iOS 聚焦时整页缩放。
- 不要只靠 hover 暴露操作；不要用过小的关闭叉号。
- 高危二次确认不能只靠颜色，要有文字变化（「再次点击确认」）。
- 长列表滚动要顺滑；不要嵌套多层横向滚动。

### 16.5 离线与更新

- 离线时展示 `/offline.html`（若连缓存壳也没有），或顶部断网横幅 + 旧数据。
- 页面导航 network-first；构建产物 stale-while-revalidate；API 与 `/a/` 永不缓存。
- 新版本：应用内弹窗「立即更新 / 之后更新」；更新后自动 reload。
- 移动 PWA 可能长期挂后台：回到前台要立即检查更新、刷新数据。

### 16.6 通知落地

- 通知里的签名链接直接打开 `/a/:token`，**不要求登录**。
- 这一页必须在手机上单手可完成：大单选卡片、大提交按钮、清晰的高危确认。
- 提交成功 / 过期 / 已处理 / 无效链接都要有明确结果页。

### 16.7 移动端布局建议

| 区域 | 手机（< 768px） | 平板（768–1279px） | 桌面（≥ 1280px） |
| --- | --- | --- | --- |
| 顶栏 | 品牌 + 状态 + 操作，单行 | 品牌 + 页签，可能两行 | 品牌 + 6 页签 + 操作，单行 |
| 导航 | 底部固定 4~6 项 + 安全区 | 顶部页签 | 顶部页签 |
| 接入端状态栏 | 横向滚动卡片，可折叠 | 横向滚动 / 网格 | 自动网格 |
| 待批卡片 | 单列，方案纵向堆叠 | 单列 | 1~2 列 |
| 会话 | 列表与对话上下堆叠 | 左右两栏 | 左 280px + 右自适应 |
| 规则编辑器 | 编辑器在上、提示在下 | 上下 | 编辑器 + 右侧提示栏 |
| 对话框 | 底部抽屉 / 全宽 | 居中模态 | 居中模态 |
| Toast | 底部居中，避开导航 | 右下 | 右下 |

---

## 17. 可访问性与国际化

- 正文对比度 ≥ 4.5:1；状态不能只靠颜色，必须配文字或图标。
- 所有图标按钮有 `aria-label` / `title`；模态有 `role="dialog"` / `aria-modal`。
- 焦点环清晰；支持键盘完成登录、页签切换、审批、保存规则、关闭弹窗。
- 尊重 `prefers-reduced-motion`：倒计时、呼吸点、更新弹窗动效要可关闭。
- 中英双语：文案长度差异大（英文通常更长），按钮和页签要留出伸缩空间；不要把中文硬编码进图形。
- 数字、env、项目名、工单号用等宽字体，提升扫读效率。

---

## 18. 现有视觉语言（供参考，不是必须保留）

当前主题是「现代奏折 / 朱批」，但已经做过减法：

- 底色暖纸白 `#fff8f5`，卡片纯白 `#ffffff`，分区浅米 `#faf2ee / #f4ece8`
- 主墨色 `#1e1b19`，次要文字 `#5b403d`
- 朱红主色 `#93000b`，浅红容器 `#b91c1c`
- 成功绿 `#006c4e`，警示琥珀 `#6e3900`，错误红 `#ba1a1a`
- 标题用衬线（Noto Serif SC），正文用无衬线（Inter / PingFang SC），编号与环境名用等宽（JetBrains Mono）
- 12~16px 圆角、细边框、轻阴影、极淡纸纹
- 线性图标（Lucide）

**重设计可以完全换一套视觉**，但请保留这些语义映射：朱红 / 主强调 = 需要人行动与品牌；绿色 = 已完成 / 在线；琥珀 = 等待 / 超时；灰色 = 离线 / 已取消；红色 = 高风险 / 错误。

---

## 19. 当前不做 / 不要设计过度

- 不在 Web 端创建决策工单（工单只由 Agent 创建）。
- 不做多用户、角色权限、团队空间（单 Token 全权限）。
- 不做服务端分页与无限滚动（历史只在前端筛选最近 200 条）。
- 不做数据统计图表、报表、趋势分析。
- 不做深色模式（可作为下一版探索，但本期不要求）。
- 不做推送通知订阅（通知走 Bark / 飞书 / Slack 等外部渠道 + 签名链接）。
- 不做工单评论、@ 提及、富文本编辑器。
- 不要为了「好看」隐藏三行简报或选项利弊——它们是产品的核心信息。

---

## 20. 可直接粘贴给 Stitch 的 Prompt

> 建议按屏幕逐个生成，先做 `20.1` 的 Design System，再逐屏生成，最后补 `20.9` 的 PWA 状态。

### 20.1 总 Design System + 应用外壳

```text
Design a complete design system and app shell for "Zhunzou" (准奏), an async decision hub for AI coding agents. The UI language is Simplified Chinese with an English toggle.

Product: AI agents submit a "decision ticket" with a strict three-line brief (what was completed / the blocker question / the next step) plus 2–6 closed options and one recommended option. A meta-agent auto-approves routine tickets using team rules; only the rest reach the human. The human clicks one option and the waiting agent is unblocked instantly.

Deliver:
1. Color tokens: warm paper surface, ink text, vermilion primary for action/brand, jade for success/online, amber for waiting/timeout, red for destructive risk, neutral gray for offline/cancelled. Light theme only. Must pass WCAG AA.
2. Typography: serif display for the brand and section titles (Noto Serif SC), clean sans for body (Inter / PingFang SC), monospace for ticket IDs, env names, project names, counts and logs (JetBrains Mono).
3. Components: primary/secondary/ghost/danger buttons, icon buttons, inputs, selects, textareas, search field, tabs, count badges, status pills, risk badges, cards, list rows, empty states, skeletons, toasts, modal, bottom sheet, confirm dialog, terminal log panel, countdown timer, progress/undo bar.
4. App shell — desktop: sticky 64px top bar with a seal-like logo "准", product name "准奏", six tabs (待批奏折 / 下发任务 / 会话 / 接入端 / 历史决策 / 规则配置) with count badges, connection dot + last-sync time, language toggle, refresh, sign out. Content max-width 1152px, centered.
5. App shell — mobile/PWA: top bar with brand, connection dot, language, refresh, sign out; fixed bottom navigation with safe-area padding. Six tabs are too many for 320px, so propose 4 primary tabs (待批奏折 / 下发任务 / 会话 / 更多) plus a "更多" sheet for 接入端 / 历史决策 / 规则配置. Include env status strip, offline banner, toast placement, update dialog.
6. Responsive specs for 360, 390, 768, 1024, 1280, 1440 widths. Touch targets ≥ 44px. Show focus, disabled, loading, empty and error states.

Visual direction: modern editorial, calm, developer-tool quality. A restrained "memorial / vermilion endorsement" metaphor — paper texture only if subtle, no dragons, no gold gradients, no imperial clichés. High information density, strong hierarchy, generous but efficient spacing.
```

### 20.2 登录门

```text
Design the login screen for "Zhunzou" (准奏), a decision hub for AI agents. Simplified Chinese.

Centered card on a warm paper background with subtle grain. Brand: a square seal-like mark with the character "准" in vermilion, product name "准奏" in serif, subtitle "Agent 决策中枢 · 批奏折" with "批奏折" in the accent color.

Elements:
- Label "访问令牌 / Secret Token" with a key icon.
- Password input, monospace, placeholder "粘贴服务端 HUB_SECRET_TOKEN", show/hide eye button.
- Primary full-width button "进入看板"; loading state "验印通行中…".
- Inline error panel with role=alert: "Token 无效，请检查服务端 HUB_SECRET_TOKEN", plus a network-error variant.
- Small privacy note: "Token 仅保存在本机浏览器，不会上传第三方；生产环境请务必使用 HTTPS。"
- Language toggle top-right (中文 / EN).
- Footer "准奏 · Zhunzou Auth Engine".

Also show the same screen on mobile (PWA standalone, safe areas top/bottom, no browser chrome) and the error/loading states.
```

### 20.3 待批奏折（核心屏，桌面 + 手机）

```text
Design the primary screen of "Zhunzou" (准奏): the pending approvals dashboard. Simplified Chinese. This is the most important screen — a developer must understand one ticket and approve it within 10 seconds.

Layout:
- Page title "御览奏折" with a count badge "3 封急奏", subtitle "三思而后决 · 即批即行". A "批量准奏" button appears when more than one ticket is pending.
- A horizontally scrollable strip of environment status cards: env name, online dot, status pill (运行中 / 等待决策 / 空闲 / 离线), current project, current task, last heartbeat. One "等待决策" card is highlighted.
- A queue of decision cards, oldest first. Desktop 1–2 columns; mobile single column.

Each decision card:
- Faint "待批" seal watermark in the top-right.
- Header: "#104" in monospace primary, project name as title, tag "env: company-cursor", relative time "3 分钟前起奏", status pill "待批奏折" or "总管预审中".
- Three-line brief, visually unmistakable:
  1. "已完成进展" with a green check.
  2. "请旨阻塞关键抉择" — the blocker question, the visual focus, vermilion left rule, bold text.
  3. "候命下一步" with an arrow.
- If status is "总管预审中": a quiet note "总管 Agent 正在按 GLOBAL_RULES.md 预审，通常几秒内自动处理；你也可以直接拍板。"
- If a meta-agent reason exists: a card "总管为何不敢批" with the reason.
- Auto-resolve countdown strip: live "12:34" + "后默认准奏方案 A" + "暂缓 10 分钟" button. If the recommended option is destructive, show "高风险，不会自动执行".
- If the env is offline: amber warning "端侧 company-cursor 已离线，工单可能已无人等待。" with a "取消工单" action that requires a second click ("再次点击确认取消").
- Optional instruction textarea labeled "批红备忘 / 补充指令（选填）", hint "随审批一起发送", placeholder "例如：先只改登录页，其他页面下个迭代处理", max 2000.
- "抉择分支" — 2–6 option buttons. Each: option key in a circle, label, optional pros/cons line, "推荐" badge on the recommended one, "高风险" red badge on destructive ones. Clicking submits immediately. The recommended option is highlighted but NOT preselected. A destructive option requires a second click on the same button ("再次点击确认") with a 4-second reset. Right side shows "准奏" / "确认".
- Footer hint: "点击选项即提交审批 · 批红后 Agent 将立即恢复运行 · 高风险选项需二次确认".

Include: empty state "天下太平 · 暂无待批奏折", loading state, submitting state (spinner, all buttons disabled), and the batch-approve dialog with a 3-second undo countdown ("3 秒后提交 · 撤销") and a destructive-confirmation checkbox.
Show desktop and mobile versions. Mobile: stacked option buttons, 44px+ targets, bottom nav, safe areas.
```

### 20.4 下发任务 + 任务输出

```text
Design the "下发任务" (dispatch task, human → agent) screen for "Zhunzou" (准奏). Simplified Chinese.

Top: eyebrow "Dispatch Desk · 自上而下 · 差遣", title "下发任务" with "待办 3 项", hint "Agent 调用 agent_hub_next_task 即可领取".

Dispatch form card:
- "目标环境" select, options annotated "· 在线 / · 离线".
- "项目名（选填）" select, only projects bound to that env.
- An inline "工作区项目" binding row: chips of bound projects with an x to unbind (the currently active project cannot be unbound), a "绑定项目" action that opens a select of known projects, empty text "尚未绑定项目 · Agent 心跳会自动上报工作区", and "已绑定全部已知项目" when done.
- "任务标题" single-line input.
- "详细指令" 4-row textarea.
- Hint "任务会排队到下一位在线的同环境 Agent 领取，不会打断正在审批的工单。"
- Primary button "下发任务", disabled until env/title/instruction are filled; loading "下发中…".

Below: "待办与执行中" list. Each task card: "#12", title, status pill (待领取 / 执行中 / 已完成 / 失败 / 已取消), "第 2 次领取" badge when retried, env tag, project, relative dispatch time, "查看输出" toggle, "取消" action, full instruction, and "Agent 已领取，执行中 · 3 分钟前".
Expanded output: terminal-style dark panel, monospace, 1.2s live tail, stdout white / stderr red / system amber, auto-scroll, max height ~256px, header "执行输出" + live dot, empty "等待输出…".

Also design "已结束" compact list (id, status, env, updated time, title, result text, "输出" button) and the empty state "暂无待办任务".
Desktop and mobile.
```

### 20.5 会话（Chat）

```text
Design the "会话" (chat) screen for "Zhunzou" (准奏), where a developer talks to an AI coding agent in a specific project. Simplified Chinese. Desktop: 280px session sidebar + flexible transcript. Mobile: stacked, safe areas.

Header: "会话", subtitle "与任意项目的 Agent 多轮对话", primary "新建会话".

New-session dialog: "目标环境" select (only online agents selectable; offline visible but disabled with "· 离线"), "项目（可选）", "标题（可选）", cancel/create. Show the state "当前没有在线 Agent，先把端侧 runner 启动起来再新建会话。"

Session list: "全部会话" + refresh. Each row: title, "已关闭" badge, env tag, project, "12 条消息 · 3 分钟前". Selected row highlighted. Empty state.

Transcript:
- Header: session title, env, project, status ("在线" green dot / "端侧离线" red dot / "已关闭"), "关闭" action.
- User messages right-aligned in primary bubbles; assistant/system left-aligned in neutral bubbles.
- Pending user message shows "等待端侧领取…"; offline variant adds "（该环境当前离线）".
- Failed message shows the error and a "重试" button.
- While a turn runs, an inline live terminal output panel appears under the last user message.
- Input: 2-row textarea, Enter to send / Shift+Enter newline, circular send button, hint "会话由端侧 runner 执行；本机需要常驻 wake 或 fleet，否则消息会停在待领取。"
- Closed session: input disabled.

Show empty, running, failed, offline-agent and closed states, on desktop and mobile.
```

### 20.6 接入端管理

```text
Design the "接入端管理" (agent/environment management) screen for "Zhunzou" (准奏). Simplified Chinese.

Header: title "接入端管理", count "5 个 · 2 个离线", actions "刷新" and primary "登记接入端".

Section "运行节点": cards grouped by host. Each: hostname, "3 / 5 在线", "托管 4 个项目", disabled count, OS, bridge version, last heartbeat.

Agent cards grid. Each card:
- Online dot + env name (monospace) + status pill (在线 / 离线 / 已停用) + edit pencil.
- Display name · client type (Cursor / OpenCode / Claude Code / Codex / Gemini / Windsurf / 其他).
- Info grid: 当前项目, 最近心跳, 版本 / 主机, 系统.
- Current task strip if present.
- "最近一次会话" summary: 追问 / 结论 + relative time.
- Token row: "zz_••••" or "未签发 Token", with "签发 / 轮换" and "吊销".
- Footer actions: "停用 / 启用" and "删除" (danger).

Dialogs:
- Register/edit: "环境标识 AGENT_ENV" (disabled when editing), "显示名称", "客户端类型" select, save/cancel.
- One-time token: explanation, monospace token with copy button, warning "关闭后无法再次查看；如果丢失，只能轮换生成新 Token（旧 Token 立即失效）。"

Empty state: "尚无接入端" + "在项目里运行 npx zhunzou-bridge init，桥接第一次心跳后会自动出现在这里；也可以手动登记。"
Also design a shared in-app confirm dialog for destructive actions (delete agent, revoke token, close session) to replace native browser confirm. Desktop + mobile.
```

### 20.7 历史决策

```text
Design the "历史决策" (decision history) screen for "Zhunzou" (准奏). Simplified Chinese.

Header: eyebrow "Archive Dossier · 文书御批宗卷", title "历史决策" + "共 48 条", hint "最近更新的排在前面".

Controls:
- Search field: "检索编号、项目、卡点或批复意见…", with clear button.
- Filter chips with counts: 全部 / 人工审批 / 总管自动 / 超时默认 / 已取消.

List (newest first), compact cards. Each:
- A tilted stamp watermark top-right: "准奏 · 裁定" (human), "机断 · 例行" (meta), "超时 · 默认" (timeout), "已取消" (cancelled).
- "#104", project name, env, relative update time (tooltip exact time).
- Status pill.
- Resolver row with icon: 总管自动 / 超时默认 / 人工审批; cancelled shows "端侧取消".
- "奏请决议点": the blocker question.
- Final decision: "方案 A · Toast 提示".
- "批" note: custom instruction or auto-resolution reason.

States: empty ("宗卷空寂 · 暂无记录"), no search results ("没有匹配的宗卷" + "重置筛选"), loading.
Desktop list and mobile cards.
```

### 20.8 规则配置

```text
Design the "规则配置" (GLOBAL_RULES.md editor + rule candidates) screen for "Zhunzou" (准奏). Simplified Chinese.

Header: eyebrow "Meta-Agent Policy · 御批枢密章法", title "全局工程与架构规范", description "Meta-Agent 预审的唯一依据。保存后立即生效，无需重启服务。"

Top card "御前待议 · 批复沉淀":
- Subtitle "从人工批复中提炼的候选规则，采纳后立即并入 GLOBAL_RULES.md。"
- Pending count badge, refresh button.
- Candidate rows: "#12", "来自工单 #104", relative time, rule text; actions "忽略" and primary "采纳".
- Empty state: "暂无候选规则。每次人工批复后，系统会自动提炼一条可复用规范，供你一键采纳。"

Editor card:
- File row: "GLOBAL_RULES.md", character/line count, "更新于 5 分钟前", unsaved dot + badge "有未保存修改".
- Actions "重新加载" and primary "保存规则并生效" (disabled when clean; "已保存" / "颁行中…" states).
- Markdown textarea with line-number gutter, monospace, ~480px tall, copy button in a small toolbar labeled "MARKDOWN · UTF-8 · LF".
- Footer hint "保存后 Meta-Agent 立即使用新规则".

Right sidebar:
- "怎么写更省事" tip card with 3 tips: context boundaries, specificity raises auto-approval rate, hard-code the red lines (deleting data, schema changes, production config always require a human).
- "示例偏好" with 3 example rules.
- Note: changes write directly to the server file; keep it in version control.

Mobile: editor first, tips below. Show dirty, saving, saved and load-error states.
```

### 20.9 PWA 专属状态 + 签名审批页 + 离线页

```text
Design the PWA-specific surfaces for "Zhunzou" (准奏), a Chinese developer dashboard installed to the home screen. Same visual language as the desktop app.

1. Mobile app shell in standalone mode: no browser chrome, safe-area top/bottom, sticky compact header (seal logo, connection dot, refresh, sign out), fixed bottom navigation with 4 primary items (待批奏折 / 下发任务 / 会话 / 更多) + a "更多" bottom sheet containing 接入端 / 历史决策 / 规则配置. Include count badges and active state.
2. Environment status strip collapsed to a single summary row ("5 个接入端 · 3 在线 · 1 等待决策") that expands into horizontal cards.
3. Update dialog: bottom sheet "发现新版本" / "新版本已下载完成，更新后即可使用最新功能。" with "之后更新" and "立即更新" (loading "正在更新…").
4. Offline state: a warm, minimal full-screen page with the seal logo "准", "当前离线 · You are offline", explanation, and a "重新连接 · Retry" button. Also an in-app offline banner variant that keeps cached data visible with a retry action.
5. Signed approval page /a/:token — opened from a Bark / Feishu / Slack notification, no login, mobile-first. Show: eyebrow "准奏 · 待批奏折", "#104 · project name", "env · created time", the three-line brief with the blocker highlighted, large radio option cards with key/label/pros-cons/recommended/risk badges, optional instruction textarea, a destructive-risk checkbox ("我确认这是高风险 / 不可逆操作"), a large "准 奏" button, and the hint "点击后 Agent 会立即恢复执行；高风险选项必须勾选确认。" Provide success, expired, already-handled and invalid-link result pages with a clear mark, title and message.
6. Bottom-sheet versions of the batch-approve dialog and confirmation dialogs with safe-area padding.

Show 360px and 390px widths, light theme, 44px+ touch targets, and both iOS and Android safe-area behavior.
```

---

## 21. 验收清单（设计稿交付前自查）

- [ ] 6 个页签在桌面 1280px 下一屏放得下；移动端有明确的「更多」收纳方案。
- [ ] 待批卡片在 360px 宽度下仍能一眼看到：项目、卡点、推荐方案、高危标识。
- [ ] 三行简报、推荐徽标、高危徽标、倒计时、离线警告、补充指令都在。
- [ ] 高危选项的二次确认有文字变化，不只靠颜色。
- [ ] 批量准奏的 3 秒撤销窗口有清晰视觉反馈。
- [ ] 空 / 加载 / 错误 / 禁用 / 提交中 五种状态齐全。
- [ ] 底部导航、Toast、抽屉、输入框都避开安全区与键盘。
- [ ] 离线横幅保留旧数据，不清空页面。
- [ ] 更新弹窗有「立即更新 / 之后更新」两条路径。
- [ ] 签名审批页不依赖登录，单手可完成。
- [ ] 中英文切换后按钮不溢出、页签不换行错位。
- [ ] 键盘可完成登录、切页、审批、保存规则、关闭弹窗。
- [ ] 状态不只靠颜色区分；对比度达到 AA。
