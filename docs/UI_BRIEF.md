# 准奏（Zhunzou）· UI 设计说明

> 用途：给 Stitch / Figma AI / 其他界面生成工具的产品与设计 Brief。
> 产品当前形态：单页响应式 Web 看板，桌面与手机浏览器共用一套界面。

---

## 1. 一句话定位

**准奏是 AI Agent 的异步决策中枢：Agent 遇到需要人类拍板的卡点时提交「三行简报」，总管 Agent 先按团队规范自动处理大部分问题，剩下的进入看板，人类点一下即可放行。**

英文定位：

> **Zhunzou — Approve once, unblock every agent.**
> An async decision hub where AI agents escalate blockers, a meta-agent auto-approves routine choices, and a human approves the rest in one click.

---

## 2. 要解决的问题

开发者同时使用多个 AI 编码工具（Cursor、OpenCode、Claude Code 等）并行开发多个项目时：

- Agent 频繁停下来问「用 A 还是 B」，打断心流；
- 问题散落在不同设备、不同终端，无法集中处理；
- 简单问题不该问人，复杂问题又必须由人拍板；
- 回答之后，Agent 还要能自动继续干活。

准奏把「提问 → 预审 → 人工审批 → 唤醒 Agent」变成一条异步流水线。

---

## 3. 核心概念

### 3.1 决策工单（DecisionTicket）

每张工单是一次待拍板的决策，强制包含：

| 字段 | 含义 | UI 呈现 |
| --- | --- | --- |
| `id` | 工单编号，如 `104` | `#104`，等宽字体 |
| `env` | 来源环境，如 `company-cursor` | 小标签 |
| `projectName` | 项目名，如 `yikuaomed-erp` | 卡片标题 |
| `status` | 工单状态 | 彩色状态徽标 |
| `doneSummary` | **已完成**什么（一句话） | 三行简报第 1 行 |
| `blockerQuestion` | **卡点问题**（具体分歧） | 三行简报第 2 行，视觉重点 |
| `nextStepPlan` | 确认后的**下一步** | 三行简报第 3 行 |
| `options[]` | 封闭选项，每项 `{key, label, prosCons?}` | 可点击的方案按钮 |
| `recommendedOption` | Agent 推荐方案 key | 高亮「推荐」 |
| `selectedOption` | 最终选择 | 历史记录展示 |
| `customInstruction` | 人类补充指令 | 审批输入框 / 历史展示 |
| `resolvedBy` | `META_AGENT` 或 `HUMAN` | 「总管自动」/「人工审批」 |
| `resolutionReason` | 自动审批理由 | 历史记录展示 |
| `createdAt` / `updatedAt` | 时间戳 | 相对时间，如「3 分钟前」 |

### 3.2 工单状态

| 状态 | 中文 | 视觉语义 |
| --- | --- | --- |
| `PENDING_META` | 总管预审中 | 蓝色 / 进行中，通常几秒内结束 |
| `PENDING_HUMAN` | 待人工审批 | 琥珀色 / 需要行动 |
| `AUTO_RESOLVED` | 总管已批 | 绿色 / 已完成 |
| `HUMAN_RESOLVED` | 人工已批 | 绿色 / 已完成 |
| `CANCELLED` | 已取消 | 灰色 / 失效 |

### 3.3 Meta-Agent（总管）

- 读取团队的 `GLOBAL_RULES.md`；
- 判断当前卡点是否被规范明确覆盖；
- 能拍板 → 自动选择推荐方案，工单变 `AUTO_RESOLVED`；
- 不能拍板 / 预审失败 → 转 `PENDING_HUMAN`，并触发通知。

### 3.4 接入端（Env）

每个 Agent 运行环境定期上报心跳：

- 名称：`company-cursor`、`home-opencode`；
- 状态：`Running`（运行中）/ `Blocked`（等待决策）/ `Idle`（空闲）；
- 最近心跳时间；
- 90 秒无心跳视为离线；
- 可附带当前项目名与当前任务。

### 3.5 全局规则（GLOBAL_RULES.md）

- 一份 Markdown 文本，是在线可编辑的团队工程规范；
- Meta-Agent 自动审批的唯一依据；
- 规则越具体，自动放行率越高；
- 保存后立即生效，无需重启。

### 3.6 长轮询（用户不可见，但影响交互）

- Agent 提交工单后会挂起等待，最长约 40 秒；
- 人类点击审批后，Agent 在 100ms 内被唤醒继续干活；
- 看板本身每 5 秒同步一次，页面隐藏时暂停，切回前台立即刷新。

---

## 4. 页面与信息架构

当前是**单页应用**，只有两个层级的界面：

```text
登录页（未认证时）
└── 主看板
    ├── 顶栏：品牌 / 三个 Tab / 连接状态 / 刷新 / 退出
    ├── 接入端状态栏（始终显示）
    ├── Tab 1：待批奏折（默认）
    ├── Tab 2：历史决策
    └── Tab 3：规则配置
```

### 4.1 登录页

目的：用访问 Token 进入看板。

元素：

- 品牌区：印章式 Logo（「准」字）、产品名「准奏」、副标题「Agent 决策中枢 · 批奏折」；
- Token 输入框（密码型，可显示/隐藏）；
- 主按钮「进入看板」；
- 错误提示：「Token 无效，请检查服务端配置」；
- 说明文案：Token 仅保存在本机浏览器，不会上传第三方。

状态：空输入、验证中、验证失败、网络错误。

### 4.2 主看板 · 顶栏

- 左侧：品牌印章 + 「准奏」+ 副标题；
- 中部：三个 Tab
  - **待批奏折**（带待处理数量角标）
  - **历史决策**
  - **规则配置**
- 右侧：
  - 连接状态圆点 + 「已连接 / 连接中断 / 连接中」+ 最近同步时间；
  - 刷新按钮（同步中旋转）；
  - 退出按钮。
- 移动端：Tab 换行到第二行，操作按钮靠右，连接状态可收起为圆点。

### 4.3 Tab 1：待批奏折（核心页面）

目标：让人在 10 秒内看懂一张工单并完成审批。

顶部：

- 标题「待批奏折」；
- 一句说明：「每张卡片是一份三行简报。点击任一方案即完成审批，Agent 会立即收到指令。」
- 右侧：「N 件待处理」。

工单卡片（重点设计对象）：

1. 卡片顶部有一条琥珀色进度条 / 强调线；
2. 头部：`#104`、项目名、环境标签、状态徽标、创建时间；
3. **三行简报**：
   - 第 1 行「已完成」：绿色序号 1 + 文本；
   - 第 2 行「卡点」：琥珀底色块 + 序号 2 + 加粗文本，**全卡视觉焦点**；
   - 第 3 行「下一步」：灰色序号 3 + 文本；
4. `PENDING_META` 时显示提示：「总管 Agent 正在按 GLOBAL_RULES.md 预审，通常几秒内自动处理；你也可以直接拍板。」
5. 补充指令输入框（可选，2 行，最多 2000 字）；
6. 方案按钮组：
   - 每个选项展示 key、label、可选利弊；
   - 推荐项高亮（深色底或强调边框 + 「推荐」徽标）；
   - 点击即提交，不需要二次确认；
   - 提交中显示「提交中…」，全部按钮禁用；
7. 底部提示：「点击选项即提交审批 · 推荐方案仅作参考」。

空状态：

- 插画 / 大字「🎉」；
- 「暂无待批奏折」；
- 「Agent 们正在干活；遇到需要拍板的卡点时会自动出现在这里。」

移动端：方案按钮纵向排列，保证 44px 以上触控高度；三行简报不折叠。

### 4.4 Tab 2：历史决策

目标：回看所有已完成的决策。

- 标题「历史决策」+ 说明 + 「共 N 条」；
- 列表项（比待批卡片更紧凑）：
  - `#104`、项目名、环境、状态徽标；
  - 更新时间（相对时间）；
  - 卡点问题；
  - 决定：`A · Toast 提示`；
  - 来源：`总管自动` / `人工审批`；
  - 补充指令或自动审批理由。
- 空状态：「还没有已完成的决策 / 审批或取消工单后会出现在这里。」
- 排序：最近更新在前。

### 4.5 Tab 3：规则配置

目标：在线编辑团队的 `GLOBAL_RULES.md`。

- 标题「全局工程与架构规范」+ 说明「Meta-Agent 预审的唯一依据。保存后立即生效，无需重启。」
- 右上：更新时间、「重新加载」、「保存规则 / 已保存」；
- 主编辑器：
  - 文件名标签 `GLOBAL_RULES.md`；
  - 「有未保存修改」徽标；
  - 字符数；
  - 等宽字体多行文本域，最小高度约 480px；
- 右侧提示卡「怎么写更省事」：
  - 规则越具体，自动放行率越高；
  - 明确写出「可以直接放行」和「必须人工确认」的边界；
  - 示例：状态管理统一 Pinia、优先 Fastify + SQLite、删除数据/schema 变更必须人工确认；
  - 提醒：修改会直接写入服务器文件，建议纳入版本管理。
- 移动端：提示卡移到编辑器下方。

### 4.6 全局元素

- **接入端状态栏**：横向卡片列表，每张显示环境名、在线圆点、状态徽标、项目名、当前任务、最近心跳；离线置灰；无数据时显示虚线空状态。
- **连接中断横幅**：红色条 + 错误原因 + 「重试」。
- **Toast**：右下角（移动端底部居中），成功/错误/信息三种，4 秒自动消失，可点击关闭。
- **页脚**：「准奏 · 单实例部署 · 数据持久化于 SQLite」。

---

## 5. 关键交互与状态

- 所有审批操作乐观更新：点击后立即更新卡片，再后台同步；
- 重复审批由服务端返回 409，UI 展示失败 Toast；
- Token 过期（401）自动退出并提示重新输入；
- 网络中断：顶部红色横幅 + 保留旧数据 + 可重试；
- 页面隐藏时暂停轮询，切回立即刷新；
- 规则编辑：有未保存修改时保存按钮才可用；保存成功 Toast；重新加载会覆盖草稿，需谨慎；
- 按钮禁用态、加载态、空状态、错误态必须完整设计；
- 推荐方案高亮但**不默认选中**，避免误触。

---

## 6. 视觉方向（建议）

概念：**现代奏折 / 朱批**。把「批奏折」的历史意象做减法，不要宫廷风、不要龙纹、不要金色渐变。

推荐风格：

- **底色**：暖纸白 `#F5F1E8` / `#FAF7F0`，比纯白更有温度；
- **主墨色**：`#1C1917`（接近黑），用于标题与主按钮；
- **朱批色**：`#C2410C` 或 `#B91C1C`，只用于关键强调、印章、推荐徽标；
- **琥珀色**：`#F59E0B`，用于「待批」与卡点高亮；
- **成功绿**：`#047857`；**离线灰**：`#94A3B8`；
- **字体**：
  - 品牌与标题：宋体 / Noto Serif SC，克制使用；
  - 正文与按钮：Inter / PingFang SC / 系统无衬线；
  - 编号、环境名、代码：等宽字体；
- **形状**：12–16px 圆角，细边框，轻阴影；印章可做成 8–12px 小圆角方块；
- **质感**：极淡的纸纹或噪点，不要影响可读性；
- **图标**：线性图标，1.5–2px 描边；
- **动效**：150–250ms，轻微位移与透明度；尊重 `prefers-reduced-motion`。

备选风格（可作为第二套探索）：

1. **墨色极简**：黑白灰为主，仅保留一个朱红强调色，适合开发者工具；
2. **暖纸手账**：更柔和、更生活化，适合个人开发者。

---

## 7. 响应式要求

| 断点 | 要求 |
| --- | --- |
| ≥ 1280px | 最大内容宽度 1152px，居中；工单卡片单列，可探索双列 |
| 768–1279px | 单列，状态卡片横向滚动 |
| < 768px | 顶栏两行；Tab 可横向滚动；方案按钮纵向堆叠；Toast 底部居中；触控目标 ≥ 44px |

---

## 8. 可访问性

- 正文对比度 ≥ 4.5:1，状态不能只靠颜色区分（配文字）；
- 键盘可完成登录、Tab 切换、审批、保存规则；
- 焦点环清晰可见；
- 表单有 label，错误用 `role="alert"`；
- 动效可关闭。

---

## 9. 当前不做的功能（避免设计过度）

- 不在 Web 端创建决策工单（工单由 Agent 通过 API 创建）；人 → Agent 的任务下发走独立的「下发任务」页；
- 不做多用户 / 角色权限（单 Token 全权限）；
- 不做服务端分页（一次最多加载 200 条，历史页已支持客户端搜索与筛选）；
- 不做深色模式（可作为后续版本）；
- 不做数据统计图表（后续可选）。

---

## 10. 可直接粘贴给 Stitch 的 Prompt

### 10.1 总 Prompt（英文，推荐）

```text
Design a responsive web app called "Zhunzou" (准奏), an async decision hub for AI coding agents. The interface is in Simplified Chinese. It is a single-page dashboard used by a developer to approve decisions that AI agents cannot make on their own.

Core idea: AI agents submit a "decision ticket" with a strict three-line brief — (1) what was completed, (2) the blocker question, (3) the next step — plus 2–4 closed options and one recommended option. A meta-agent auto-approves routine tickets using team rules; only the rest reach the human. The human clicks one option and the waiting agent is unblocked immediately.

Design these screens:
1. Login gate: brand seal with the character "准", product name "准奏", subtitle "Agent 决策中枢 · 批奏折", a token password field with show/hide, primary button "进入看板", inline error state, and a small privacy note.
2. Main dashboard with a sticky top bar: brand seal + "准奏", three tabs "待批奏折" (with count badge), "历史决策", "规则配置"; right side shows connection status dot ("已连接"), last sync time, refresh icon button, and "退出".
3. Pending tab (primary): a row of horizontal env status cards (env name, online dot, Running/Blocked/Idle badge, project, current task, last heartbeat), then a list of decision cards. Each card has: "#104", project name, env tag, amber status badge, relative time; a three-line brief where line 2 (the blocker) is the visual focus in a warm amber panel; an optional 2-line custom instruction textarea; 2–4 option buttons with key, label, optional pros/cons, and a "推荐" badge on the recommended one; clicking an option submits immediately; footer hint "点击选项即提交审批 · 推荐方案仅作参考". Include empty state "暂无待批奏折".
4. History tab: compact list of resolved tickets with status badge, relative update time, blocker question, chosen option, resolver ("总管自动" / "人工审批"), and reason or custom instruction. Include empty state.
5. Rules tab: a Markdown editor for "GLOBAL_RULES.md" with filename label, "有未保存修改" badge, character count, "重新加载" and "保存规则" buttons, plus a right-hand tips card "怎么写更省事".
6. Global states: offline red banner with retry, toast notifications, loading and disabled states.

Visual direction: "modern memorial / vermilion endorsement" reinterpreted minimally. Warm paper background (#F5F1E8), ink black (#1C1917), vermilion accent (#C2410C), amber for pending (#F59E0B), jade for success (#047857). Serif display type for the brand and section headings (Noto Serif SC), clean sans-serif for body (Inter / PingFang SC), monospace for ticket IDs and env names. Subtle paper texture, thin borders, 12–16px radii, soft shadows. A small seal-like logo. No dragons, no gold gradients, no imperial clichés. Calm, editorial, developer-tool quality.

Make it responsive: desktop max width 1152px, single-column cards; tablet horizontal-scroll env cards; mobile two-row header, stacked option buttons, 44px touch targets, bottom-centered toasts. Ensure clear focus states, sufficient contrast, and status conveyed by text + color.
```

### 10.2 分屏 Prompt（如果 Stitch 一次只生成一个页面）

**登录页：**

```text
Design a login screen for "准奏" (Zhunzou), an async decision hub for AI agents. Simplified Chinese UI. Centered card on a deep slate background. Brand seal with the character "准" in amber, product name "准奏", subtitle "Agent 决策中枢 · 批奏折". A token password input labeled "访问 Token" with show/hide, primary button "进入看板", inline error "Token 无效，请检查服务端配置", and a small privacy note. Minimal, warm, editorial; amber accent, Noto Serif SC headings, Inter body.
```

**待批奏折主屏：**

```text
Design the primary dashboard of "准奏" (Zhunzou), an async decision hub for AI agents. Simplified Chinese. Sticky top bar with seal logo, "准奏", tabs "待批奏折 / 历史决策 / 规则配置", connection dot, refresh and logout. Below, horizontal env status cards. Main content: decision cards, each with #ID, project, env tag, amber status badge, relative time, and a three-line brief: completed (green 1), blocker (amber highlighted panel, visual focus), next step (gray 3). Optional custom instruction textarea, option buttons with keys and "推荐" badge, one-click approve. Warm paper background, ink black, vermilion accent, serif headings, subtle paper texture. Responsive, mobile-friendly, 44px touch targets.
```

**历史 + 规则：**

```text
Design two tabs for "准奏" (Zhunzou) in Simplified Chinese. History tab: compact resolved-ticket list with #ID, project, env, green/gray status badge, relative time, blocker question, chosen option, resolver label "总管自动 / 人工审批", and reason. Rules tab: full-width Markdown editor for "GLOBAL_RULES.md" with filename label, unsaved-changes badge, character count, reload and save buttons, plus a right-side tips card "怎么写更省事". Same warm paper / ink / vermilion visual language, clean and editorial.
```
