# 准奏（Zhunzou）：跨设备多 Agent 异步调度与决策中枢开发计划

## 1. 项目背景与目标

在同时使用多个 AI 编码工具（如公司电脑的 Cursor、家里电脑的 OpenCode）并行开发多个项目时，开发者面临严重的上下文切换与高频微观决策疲劳。
准奏旨在构建一套“端侧 MCP/CLI 桥接 + 云端总管预审 + 单点批处理看板”的轻量级系统，实现：

1. **拦截无意义提问**：通过云端“总管 Agent（Meta-Agent）”结合预设架构偏好，自动回复 80% 的常规技术选型与规范问题。
2. **异步集中批处理**：将必须由人类拍板的卡点转化为标准化的“三行简报”卡片，汇总至单一 Web 面板（或移动端通知）集中审批。
3. **跨网络稳定阻塞**：通过短超时心跳与 CLI 轮询机制，解决 Cursor / OpenCode 工具调用超时限制，实现后台无感挂起与恢复。

---

## 2. 技术栈与 Monorepo 目录结构

采用 **pnpm workspace Monorepo** 架构，确保云端与端侧共享核心类型定义与通信协议。

* **包管理器**：`pnpm`
* **运行时与语言**：Node.js (>= 20) + TypeScript (严格模式)
* **云端服务端 (`packages/server`)**：Fastify (或 Hono) + SQLite (`better-sqlite3` + Drizzle ORM) + OpenAI SDK (兼容 DeepSeek / Claude API 用于总管预审)
* **端侧桥接工具 (`packages/bridge`)**：`@modelcontextprotocol/sdk` (标准 `stdio` MCP 服务) + `commander` (提供终端 CLI 阻塞等待命令)
* **前端审批看板 (`packages/web`)**：Vue 3 + Vite + TailwindCSS (极简响应式单页应用，兼顾 PC 与手机浏览器操作)
* **共享协议层 (`packages/shared`)**：Zod Schema 校验与 TypeScript 接口定义

```text
zhunzou/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── packages/
    ├── shared/          # 共享类型、Zod Schema、常量状态机
    ├── server/          # 云端中枢 API、SQLite 存储、Meta-Agent 预审引擎
    ├── bridge/          # 本地 MCP Server + CLI 轮询工具 (部署于公司/家里电脑)
    └── web/             # 批奏折 Web 看板 (部署于云服务器)
```

---

## 3. 核心数据结构与接口协议 (`packages/shared`)

### 3.1 核心数据表/实体：`DecisionTicket` (决策工单)

```typescript
export type TicketStatus =
  | 'PENDING_META'    // 刚提交，等待云端总管 Agent 预审
  | 'PENDING_HUMAN'   // 总管无法决定，挂起等待人类审批
  | 'AUTO_RESOLVED'   // 已被总管 Agent 自动拍板回复
  | 'HUMAN_RESOLVED'  // 已被人类审批回复
  | 'CANCELLED';      // 客户端超时取消或主动终止

export interface DecisionTicket {
  id: string;                 // UUID 或短 ID (如 #104)
  env: string;                // 来源环境标识，如 'company-cursor' | 'home-opencode'
  projectName: string;        // 项目名称，如 'yikuaomed-erp'
  status: TicketStatus;

  // 强制三行简报结构
  doneSummary: string;        // 1. 刚刚完成了什么 (一句话)
  blockerQuestion: string;    // 2. 当前卡点与具体分歧问题
  nextStepPlan: string;       // 3. 确认后的下一步计划

  // 结构化选项 (禁止开放式问答)
  options: {
    key: string;              // 如 'A', 'B'
    label: string;            // 方案简述
    prosCons?: string;        // 简短利弊说明
  }[];
  recommendedOption: string;  // Agent 倾向的默认方案 key (如 'A')

  // 审批结果
  selectedOption?: string;    // 最终选定的方案 key
  customInstruction?: string; // 人类或总管补充的额外指令
  resolvedBy?: 'META_AGENT' | 'HUMAN';

  createdAt: number;
  updatedAt: number;
}
```

### 3.2 核心 REST API (`packages/server`)

所有接口需校验 Header：`Authorization: Bearer <HUB_SECRET_TOKEN>`。

1. `POST /api/tickets`：端侧提交新卡点工单。服务端接收后立即触发 Meta-Agent 预审逻辑。
2. `GET /api/tickets/:id/wait?timeout=40000`：**长轮询接口（Long-Polling）**。若工单已处于 `AUTO_RESOLVED` 或 `HUMAN_RESOLVED`，立即返回决策结果；否则挂起请求最多 40 秒，期间一旦人类在看板点击审批，立即唤醒并返回。
3. `GET /api/tickets`：Web 看板获取工单列表（支持按 `status` 和 `projectName` 过滤）。
4. `POST /api/tickets/:id/resolve`：人类在 Web 看板提交审批决定（传入 `selectedOption` 和可选的 `customInstruction`），同时唤醒正在长轮询该工单的连接。
5. `POST /api/status/heartbeat`：端侧汇报项目当前存活与运行状态（Running / Blocked / Idle）。

---

## 4. 关键模块实现细节

### 4.1 端侧桥接器 (`packages/bridge`) —— 解决超时与阻塞

端侧包编译后提供两个入口：

1. **MCP Server 入口 (`bin/mcp.js`)**：供 Cursor 和 OpenCode 挂载，暴露以下核心 Tool：
* `agent_hub_escalate`：参数对应 `DecisionTicket` 的必填项（强制要求传入 `doneSummary`、`blockerQuestion`、`options`、`recommendedOption`）。
* **分段等待逻辑**：调用 `POST /api/tickets` 创建工单后，自动紧接着请求一次 `GET /api/tickets/:id/wait?timeout=40000`。
* 如果 40 秒内拿到结果（例如总管秒回，或人类恰好在电脑前秒批），直接向大模型返回最终指令：`"Decision Approved: Option [A]. Instruction: ..."`。
* 如果 40 秒超时仍未审批，为了防止 MCP 管道断开，**正常返回特定引导文本**（提供两种保底策略，由配置决定）：
  * **策略 1（CLI 终端无限阻塞，推荐配合 Cursor Yolo 白名单）**：返回 `"Ticket #104 is pending human approval. Please execute terminal command: npx zhunzou-bridge wait --ticket 104 and wait for its stdout output before proceeding."`
  * **策略 2（MCP 纯工具接力轮询）**：返回 `"[STATUS: STILL_WAITING] Human has not replied to Ticket #104 yet. Call tool 'agent_hub_wait(ticketId: 104)' immediately to continue waiting."`
* `agent_hub_notify_done`：任务彻底完成或进入空闲时调用，更新云端看板状态灯为 `Idle`。

2. **CLI 入口 (`bin/cli.js`)**：
* 实现命令 `zhunzou-bridge wait --ticket <id>`。内部采用 `while(true)` 循环每 15 秒请求一次服务端状态，直到状态变为已解决，将最终决策结果打印到 `stdout` 并以 `process.exit(0)` 退出，从而把指令无缝喂回给 Cursor/OpenCode。

### 4.2 云端总管预审引擎 (`packages/server/src/meta-agent.ts`)

* 服务端维护一份 Markdown 格式的《全局工程与架构规范》（`GLOBAL_RULES.md`，支持在 Web 看板在线编辑，例如：“状态管理一律优先 Pinia”、“工具函数禁止引入 lodash 全量包”、“遇到非破坏性重构一律同意推荐方案”）。
* 当新 Ticket 进入时，Meta-Agent 将 `Ticket` 内容与 `GLOBAL_RULES.md` 拼接，调用高性价比模型（如 `deepseek-chat`）。
* Prompt 要求模型输出严格 JSON：`{ "canResolve": boolean, "selectedOption": string, "reason": string }`。
* 若 `canResolve === true`，工单状态直接改为 `AUTO_RESOLVED`，端侧在 2~3 秒内即可收到回复继续干活，完全不打扰人类。
* 若 `canResolve === false`，工单状态流转为 `PENDING_HUMAN`，并触发 Webhook（如飞书/企微/Bark 推送）提醒人类有待批奏折。

---

## 5. 分阶段开发实施计划（Milestones）

请严格按照以下 4 个阶段推进，每个阶段完成后需通过验证再进入下一阶段：

### Milestone 1：基础工程搭建与共享协议

* **任务**：
1. 初始化 `pnpm` Monorepo 工作区与基础 `tsconfig.base.json`。
2. 完成 `packages/shared`：编写 `DecisionTicket`、API 请求/响应的 Zod Schema 与 TypeScript 类型导出。
3. 编写基础单元测试验证 Schema 校验逻辑。

* **交付物**：可编译通过的 `packages/shared` 模块。

### Milestone 2：云端核心服务与长轮询队列

* **任务**：
1. 初始化 `packages/server`，配置 SQLite 数据库与 Ticket 表结构。
2. 实现内存级 `EventEmitter` 唤醒机制，配合 `GET /api/tickets/:id/wait` 实现高效长轮询（避免频繁查库）。
3. 实现工单创建、列表查询、人工审批 (`resolve`) 接口及 Bearer Token 鉴权中间件。
4. 集成 Meta-Agent 预审模块：读取本地 `GLOBAL_RULES.md`，调用 LLM API 判断是否自动放行，并预留 Webhook 通知钩子。

* **验收标准**：使用 `curl` 或测试脚本模拟提交 Ticket，能正常触发长轮询阻塞；在另一个终端调用 `resolve` 接口后，长轮询连接能在 100ms 内立即返回审批结果。

### Milestone 3：端侧 MCP Server 与 CLI 桥接器

* **任务**：
1. 初始化 `packages/bridge`，引入 `@modelcontextprotocol/sdk`。
2. 实现 `agent_hub_escalate`、`agent_hub_wait`、`agent_hub_notify_done` 三个 MCP Tools（通过环境变量 `HUB_URL`、`HUB_TOKEN`、`AGENT_ENV` 配置连接信息）。
3. 实现 CLI 命令 `wait --ticket <id>` 的死循环轮询与优雅退出逻辑。
4. 输出一份标准的目标项目 `.cursorrules` 接入模板文件。

* **验收标准**：在本地 Cursor 或通过 MCP Inspector 挂载该脚本，触发 `agent_hub_escalate` 后能成功在服务端生成记录并阻塞等待结果。

### Milestone 4：Web “批奏折”控制台与部署配置

* **任务**：
1. 初始化 `packages/web` (Vue 3 + TailwindCSS)。
2. 开发顶部状态栏：展示各个接入端（如 `company-cursor`、`home-opencode`）的在线心跳与当前状态（Running / Blocked / Idle）。
3. 开发核心审批流列表：以精简卡片展示 `PENDING_HUMAN` 状态的工单，高亮展示“三行简报”（已完成、卡点问题、下一步），提供一键点击选项按钮（如 `[同意推荐方案 A]`、`[改用方案 B]`）及附加指令输入框。
4. 开发规则配置页：支持在线查看与修改云端 `GLOBAL_RULES.md`（动态扩充总管 Agent 的题库/偏好）。
5. 编写服务端静态资源托管配置（将 `web/dist` 挂载到 `server` 下单端口统一暴露）及 `Dockerfile` / `pm2` 部署脚本。

---

## 6. 给开发 Agent 的执行约束

```markdown
你现在负责开发 `zhunzou`（准奏）项目。请严格遵循以上《开发计划》按 Milestone 顺序推进：
1. 当前仅执行我指定的 Milestone，未经确认不要跨阶段生成所有代码。
2. 保持极简主义（KISS 原则）：服务端优先使用原生或轻量库（Fastify/Hono + better-sqlite3），不要引入沉重的消息队列（如 RabbitMQ/Kafka），长轮询唤醒直接使用 Node.js 原生 `EventEmitter` 配合 SQLite 持久化即可。
3. 端侧 `packages/bridge` 必须保证零外部原生编译依赖（纯 JS/TS 网络请求），确保在 Windows 和 macOS 环境下通过 `node` 直接运行无兼容性问题。
4. 先从 Milestone 1 和 Milestone 2 的核心骨架开始。
```

---

## 7. 实施状态

| Milestone | 状态 | 说明 |
| --- | --- | --- |
| M1 基础工程 + 共享协议 | ✅ 完成 | pnpm workspace、严格 TS、Zod Schema、14 个单测 |
| M2 云端服务 + 长轮询 | ✅ 完成 | Fastify + SQLite/Drizzle、EventEmitter 唤醒、Meta-Agent、Webhook、65 个测试 + 真实 HTTP 冒烟测试 |
| M3 端侧 MCP + CLI | ✅ 完成 | MCP SDK stdio、3 个 Tools、CLI 15s 轮询、两种超时策略、.cursorrules / Cursor / OpenCode 模板、32 个测试 + MCP stdio 端到端验收 |
| M4 Web 看板 + 部署 | ✅ 完成 | Vue 3 + Vite 8 + TailwindCSS 4、状态栏 / 待批卡片 / 历史 / 规则编辑、Fastify 单端口静态托管 + SPA fallback、Dockerfile / docker-compose / pm2、16 个前端测试 + 单端口冒烟验收 |
| M5 开源化 + 可插拔 | ✅ 完成 | 品牌统一为「准奏」；Meta-Agent 支持 openai/http/none；通知支持 8 种渠道；外部插件钩子；npm 包更名 `@zhunzou/*` / `zhunzou-bridge`；MIT License、CI、扩展文档 |
| M6 决策记忆 + 规则沉淀 | ✅ 完成 | 同项目历史判例注入 Meta-Agent；零依赖字符 bigram 召回；人工批复后自动提炼候选规则；规则页一键采纳/忽略；待批卡片展示总管转人工理由 |
| M7 超时裁决 + 批量审批 + 陈旧任务治理 | ✅ 完成 | `expiresAt` SLA 与后台 sweeper；卡片倒计时与暂缓 10 分钟；批量准奏 + 3 秒撤销；`risk` 高风险二次确认；CLAIMED 任务离线重排/硬超时；`/api/resume` 与 `agent_hub_resume` |
| M8 通知一键批复 + 接入向导 + 英文文档 | ✅ 完成 | HMAC 签名审批页 `/a/:token`；通知带选项与审批链接；`zhunzou-bridge init` 自动写 Cursor/OpenCode/Claude 配置；英文 README |

> 与原始计划的偏差：Meta-Agent 使用 Node 内置 `fetch` 直连 OpenAI 兼容接口（DeepSeek/OpenAI），未引入 `openai` SDK，减少依赖并保持跨平台零原生编译；接口协议完全兼容。开源化阶段进一步把模型、通知与业务扩展做成配置/插件接口，核心协议保持稳定。
