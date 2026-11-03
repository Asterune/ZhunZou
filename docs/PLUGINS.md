# 扩展与插件（Plugins）

准奏把「决策协议」和「执行细节」分开：核心只负责工单、长轮询、审批与规则，外部能力全部通过配置或小型接口接入。你可以替换模型、通知渠道、接入端，甚至挂载自己的插件模块，而不必修改核心代码。

## 扩展点一览

| 扩展点 | 接入方式 | 适合场景 |
| --- | --- | --- |
| 预审模型 | `META_AGENT_PROVIDER=openai\|http\|none` | DeepSeek / OpenAI / Ollama / 自建决策服务 |
| 通知渠道 | `NOTIFY_CHANNELS=...` | Bark、飞书、Slack、Discord、ntfy、Telegram、自定义 Webhook |
| 自定义逻辑 | `HUB_PLUGINS=./plugin.mjs` | 审计日志、IM 机器人、工单同步、指标上报 |
| 端侧 Agent | MCP Server / CLI / 直接 HTTP | Cursor、OpenCode、Claude Code、自研 Agent |
| 存储 | SQLite（默认） | 单机零依赖；核心仓储与 HTTP 层解耦，便于后续替换 |

所有扩展都遵循一个原则：**外部副作用失败不能阻断审批主流程**。通知与插件钩子都是异步、失败只记日志；只有显式配置的插件模块加载失败会让服务启动失败，避免「以为装上了其实没装」。

---

## 1. 预审模型（Meta-Agent）

### OpenAI 兼容（默认）

适用于 DeepSeek、OpenAI、Moonshot、OpenRouter、Ollama、vLLM 等：

```bash
META_AGENT_PROVIDER=openai
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=sk-...
META_AGENT_MODEL=deepseek-chat
```

`META_AGENT_HEADERS` 可追加任意请求头（JSON 对象），用于网关鉴权或路由：

```bash
META_AGENT_HEADERS={"x-tenant":"team-a"}
```

### 通用 HTTP 决策服务

把预审逻辑放到任意服务里，只需实现一个 POST：

```bash
META_AGENT_PROVIDER=http
META_AGENT_ENDPOINT=https://brain.internal/decide
META_AGENT_HEADERS={"authorization":"Bearer internal-token"}
```

请求体：

```json
{
  "ticket": { "id": "104", "blockerQuestion": "...", "options": [] },
  "rules": "# 全局工程规范 ..."
}
```

响应体（严格 JSON）：

```json
{ "canResolve": true, "selectedOption": "A", "reason": "命中规范第 3 条" }
```

`canResolve=false` 或选项不存在时会转人工。超时、非 2xx、非法 JSON 同样转人工，不会丢单。

当人工审批完成后，同一个端点还会收到一次规则提炼请求：

```json
{ "type": "distill_rule", "ticket": { "id": "104", "selectedOption": "B" } }
```

返回 `{ "rule": "- 表单错误提示优先使用行内文案。" }` 或纯文本即可；返回 `SKIP`
表示这次决策没有复用价值。端点失败时会自动退回确定性模板，不影响审批主流程。

### 关闭预审

```bash
META_AGENT_PROVIDER=none
# 或旧写法：META_AGENT_ENABLED=false
```

所有工单直接进入 `PENDING_HUMAN`。

---

## 2. 通知渠道

`NOTIFY_CHANNELS` 是逗号分隔的渠道列表，服务端会**并行 fan-out**：

```bash
NOTIFY_CHANNELS=bark,feishu,console
```

不配置时保持旧行为：有 `WEBHOOK_URL` 就发通用 Webhook，否则不通知。

| 渠道 | 必填变量 | 说明 |
| --- | --- | --- |
| `webhook` | `WEBHOOK_URL` | 通用 JSON POST，可带 `WEBHOOK_SECRET`（`x-webhook-secret`） |
| `bark` | `BARK_KEY` 或 `BARK_URL` | iOS Bark 推送 |
| `feishu` / `lark` | `FEISHU_WEBHOOK_URL` | 飞书群机器人 |
| `slack` | `SLACK_WEBHOOK_URL` | Slack Incoming Webhook |
| `discord` | `DISCORD_WEBHOOK_URL` | Discord Webhook |
| `ntfy` | `NTFY_URL` | ntfy 主题，可带 `NTFY_TOKEN` |
| `telegram` | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Telegram Bot |
| `console` | 无 | 写入服务日志，适合本地调试 |

通用 Webhook 的请求体：

```json
{
  "type": "ticket.pending_human",
  "text": "【准奏 · 待批奏折 #104】...",
  "ticket": { "...": "完整 DecisionTicket" },
  "approvalUrl": "https://hub.example.com/a/104.1700000000000.xxx"
}
```

`approvalUrl` 只在设置 `PUBLIC_BASE_URL` 时出现，是带 HMAC 签名和有效期的移动端审批页。
Webhook 接收方可以直接把它渲染成按钮；其他内置渠道会自动把链接放进消息正文。

每个渠道单次超时 5 秒；失败只记 `warn` 日志，不影响工单创建与长轮询。

---

## 3. 外部插件模块

插件是一个普通 ES Module，默认导出一个工厂函数（或直接导出插件对象），服务启动时加载：

```bash
HUB_PLUGINS=./examples/plugins/audit-log.mjs
# 多个用逗号分隔；相对路径基于仓库根目录
```

最小示例：

```js
export default function createPlugin({ config, logger, version }) {
  return {
    name: 'my-plugin',

    onReady(app) {
      logger.info({ version }, 'my-plugin ready');
    },

    async onTicketCreated(ticket) {
      // 工单刚创建（PENDING_META）
    },

    async onTicketPendingHuman(ticket) {
      // 总管无法决定 / 预审失败，转人工
    },

    async onTicketResolved(ticket) {
      // AUTO_RESOLVED 或 HUMAN_RESOLVED
    },

    async onTicketCancelled(ticket) {
      // 端侧取消
    },

    async onClose() {
      // 服务优雅退出
    },
  };
}
```

也可以导出 `createPlugin` 或 `plugin`。钩子可以是同步或异步函数；抛错只会记录日志，不会影响请求。

完整示例见：

- [`examples/plugins/audit-log.mjs`](../examples/plugins/audit-log.mjs)：JSONL 审计日志
- [`examples/plugins/custom-notifier.mjs`](../examples/plugins/custom-notifier.mjs)：自定义 HTTP 通知

> 插件以服务进程权限运行，等同于服务端代码。只加载你信任的模块。

---

## 4. 接入端（Agent 侧）

端侧不绑定具体 IDE，任何能发 HTTP 或挂 MCP 的 Agent 都能接入：

- **MCP**：`zhunzou-bridge` 暴露 `agent_hub_next_task` / `agent_hub_complete_task` /
  `agent_hub_report_task` / `agent_hub_escalate` / `agent_hub_wait` /
  `agent_hub_notify_done`，适用于 Cursor、OpenCode、Claude Code 等。
- **CLI**：`zhunzou-bridge wait --ticket 104` 阻塞到审批完成，把结果打印到 stdout。
- **直接 HTTP**：按需实现工单与任务接口即可，见 [README](../README.md#api)。

MCP 工具名保持 `agent_hub_*` 不变，视为稳定协议；产品品牌与工具名解耦，方便已有模板继续使用。

---

## 5. 存储

默认使用 SQLite（`better-sqlite3` + Drizzle），零外部依赖，适合单机单实例。HTTP 层只依赖 `TicketStore` 接口；通过 `buildApp({ repo })` 可以注入任意实现（Postgres / MySQL / 内存 / 远程 API），不需要改路由与协议：

```ts
import { buildApp, loadConfig, type TicketStore } from '@zhunzou/server';

const repo: TicketStore = createMyStore();
const app = await buildApp({ config: loadConfig(), repo });
```

单实例约束来自长轮询的进程内 `EventEmitter`；未来多实例部署需要把唤醒层替换为 Redis pub/sub 等跨进程总线。
