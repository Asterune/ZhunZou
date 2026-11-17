# 配置参考

本文收录准奏的全部环境变量参考表，由 README 迁出。
`.env.example` 是服务端变量的带注释源头（相对路径统一以仓库根目录为基准解析）；
总览与快速上手见 [README.md](../README.md)（[中文](../README.zh-CN.md)），接口细节见 [docs/API.md](./API.md)。

## 服务端核心

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` 要求显式设置 `HUB_SECRET_TOKEN`，并把默认日志级别调到 `info` |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 监听地址 |
| `HUB_SECRET_TOKEN` | 开发环境 `dev-token` | **生产环境必须显式设置**（管理员 Token） |
| `DATABASE_PATH` | `./data/zhunzou.db` | SQLite 文件路径（`:memory:` 用于测试） |
| `GLOBAL_RULES_PATH` | `./GLOBAL_RULES.md` | 规则文件路径 |
| `LOG_LEVEL` | dev `debug` / prod `info` | Pino 日志级别 |
| `WAIT_TIMEOUT_MS` | `40000` | 缺省长轮询窗口（上限 55s） |
| `SERVE_WEB` / `WEB_DIST_PATH` | `true` / `./packages/web/dist` | 由 API 端口同端口托管看板 |
| `BRIDGE_RELEASES_PATH` | `./release/bridge` | standalone bridge 发布目录，公开托管在 `/releases/bridge/`，清单在 `/api/bridge/latest` |

## Meta-Agent 与决策权

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `META_AGENT_ENABLED` | `true` | `false` 等同 `META_AGENT_PROVIDER=none` |
| `META_AGENT_PROVIDER` | `openai` | `openai` / `http` / `none` |
| `OPENAI_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容接口（DeepSeek / OpenAI / Ollama / Moonshot…） |
| `OPENAI_API_KEY` | 空 | 为空时跳过自动预审，全部转人工 |
| `META_AGENT_MODEL` | `deepseek-chat` | 预审模型 |
| `META_AGENT_SECOND_MODEL` | 空 | 反方审计专用模型；空表示复用 `META_AGENT_MODEL`（提示词仍不同，两次调用相互独立） |
| `META_AGENT_TIMEOUT_MS` | `15000` | LLM 请求超时（1s–120s） |
| `META_AGENT_ENDPOINT` | 空 | `provider=http`：`POST { ticket, rules, mode }` → `{ canResolve, selectedOption?, confidence?, category?, reason }` |
| `META_AGENT_HEADERS` | `{}` | 两种 provider 都可用的额外 JSON 请求头，如 `{"x-api-key":"…"}` |
| `DECISION_POLICY` | `reply` | 裁决权归属：`off` 全部问人 / `reply` 只自动裁决会话回复 / `all` 连下一步动作也由 hub 裁决（destructive 永远问人） |

## L2 裁决限额

自动放行不是空白支票。每一张自动通过的工单都要过完这四道闸，任意一道不满足就转人工：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DECISION_MIN_CONFIDENCE` | `0.7` | 裁判自报置信度下限；模型不返回 `confidence` 时按 1 处理（兼容旧的 HTTP provider） |
| `DECISION_DUAL_REVIEW` | `high` | `off` / `high` / `all`。`high` 只对高风险类目启用反方审计；`all` 全部双审 |
| `DECISION_HIGH_RISK_CATEGORIES` | `dependency,api-contract,schema,product,deploy,security` | 必须双审一致的类目 |
| `DECISION_DAILY_QUOTA` | `0` | 每个项目每滚动 24h 的自动放行上限；`0` 不限额 |
| `DECISION_AUDIT_RATE` | `0.1` | 自动放行后抽样送人工复核的概率；命中后工单标记「待审计」，不影响放行 |
| `DECISION_DEMOTION_MINUTES` | `1440` | 人工推翻某个类目的自动裁决后，该类目暂停自动放行的时长 |

流程细节：

1. **正审**按 `GLOBAL_RULES.md` + 相似判例给出 `canResolve` / `selectedOption` / `confidence` / `category`；
2. 置信度低于阈值 → 转人工，工单上仍保留总管的建议与理由；
3. 高风险类目进入**反方审计**：默认立场是拒绝，且看不到正审的结论；两边必须选中同一个选项；
4. **配额**按项目滚动 24h 统计 `AUTO_RESOLVED`；
5. **抽样审计**只打标记，人在历史里点「确认无误」或「推翻」；推翻会把该类目降级一段时间。

类目枚举：`refactor` / `docs` / `test` / `dependency` / `api-contract` / `schema` / `product` / `deploy` / `security` / `other`。

`provider=http` 会收到 `mode: "judge" | "challenger"`。自定义服务应据此切换立场；若两种模式返回同一份答案，双审就退化成一次调用。

## Supervisor 与节点路由

这部分还太新，旋钮放在代码常量里而不是 `.env`：

- parked 的权限请求只在 `SUPERVISOR_PERMISSION_TIMEOUT_MS`（55s）内值得自动作答；
- 失败熔断在 `SUPERVISOR_RETRY_CEILING`（3 次）处放弃；
- 归一化错误签名相似度超过 `SUPERVISOR_SIGNATURE_SIMILARITY`（0.85）即判定两次是同一个错；
- 节点在 `NODE_HEARTBEAT_TIMEOUT_MS`（30s）内有心跳才算活着；
- 空闲内存低于 `ROUTE_MIN_FREE_MEMORY_MB`（2 GB）直接不派。

Supervisor 裁决取值为 `APPROVE` / `DENY` / `RETRY_WITH_FIX` / `ESCALATE_TO_HUMAN`，归属层 `L1`（0ms、确定性规则）、`L2`（模型）或 `HUMAN`；学习放行规则来自人工批复（`HUMAN_APPROVAL`）、批复沉淀（`RULE_DISTILLER`）或种子（`SEED`）。

## 通知与插件

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NOTIFY_CHANNELS` | 有 `WEBHOOK_URL` 时 `webhook`，否则无 | 逗号分隔并行 fan-out：`webhook,bark,feishu,wecom,slack,discord,ntfy,telegram,console` |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` | 空 | 通用 Webhook，接收 `{ type, text, ticket \| task, actions }` |
| `BARK_KEY` / `BARK_URL` | 空 | Bark（iOS）；只给 KEY 时自动拼 `https://api.day.app/<key>` |
| `FEISHU_WEBHOOK_URL` · `WECOM_WEBHOOK_URL` · `SLACK_WEBHOOK_URL` · `DISCORD_WEBHOOK_URL` | 空 | 各 IM incoming webhook；飞书与企微把任务渲染成带链接按钮的卡片 |
| `NTFY_URL` / `NTFY_TOKEN` | 空 | ntfy 主题与访问 Token |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 空 | Telegram Bot 发送 |
| `HUB_PLUGINS` | 空 | 逗号分隔的插件模块路径，见 [docs/PLUGINS.md](./PLUGINS.md) |
| `PUBLIC_BASE_URL` | 空 | 通知里签名链接的公开地址，如 `https://hub.example.com` |
| `APPROVAL_LINK_SECRET` | `HUB_SECRET_TOKEN` | 审批链接 HMAC 密钥 |
| `APPROVAL_LINK_TTL_MS` | `1800000` | 审批链接有效期（1 分钟–7 天） |

所有渠道单次超时 5 秒，失败只记日志，不阻塞审批主流程。

## SLA 与恢复

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AUTO_RESOLVE_TIMEOUT_MS` | `0` | 超时默认裁决；`0` 关闭。到期按推荐方案自动准奏，标记 destructive 的永不自动执行 |
| `AUTO_RESOLVE_PROJECTS` | 空 | 允许自动裁决的项目白名单；空表示全部 |
| `SWEEP_INTERVAL_MS` | `5000` | 超时与陈旧任务清理扫描间隔（10ms–60s） |
| `TASK_CLAIM_TIMEOUT_MS` | `1800000` | 端侧离线超过该时长后，`CLAIMED` 任务自动重新排队 |
| `TASK_HARD_TIMEOUT_MS` | `21600000` | `CLAIMED` 任务硬超时，即使在线也标记失败 |
| `TASK_MAX_ATTEMPTS` | `3` | 任务最多被领取次数，超过后标记 `FAILED` |
| `CHAT_MESSAGE_TIMEOUT_MS` | `300000` | 会话轮次 `RUNNING` 且该端离线超过此时长后判定失败；`0` 关闭恢复 |

## 实时网关与终端

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REALTIME_ENABLED` | `true` | 启用设备 / 看板 WebSocket 网关；`false` 完全回退 HTTP 心跳与长轮询 |
| `REALTIME_TICKET_TTL_MS` | `60000` | 浏览器 WebSocket ticket 有效期 |
| `REALTIME_HEARTBEAT_MS` | `15000` | 服务端向设备通告的心跳间隔（默认取 `NODE_HEARTBEAT_REPORT_MS`）；节点静默超过 30s 即移出可路由集合。注意 `.env.example` 仍写着 `30000`——显式设置它，或不管它、拿默认 15s |
| `REALTIME_HEARTBEAT_TIMEOUT_MS` | `90000` | 设备 WS 静默多久后关闭连接（看板 env 在线状态仍按 90s 心跳窗口判定） |
| `TERMINAL_ENABLED` | `true` | 启用交互式 PTY 终端 |
| `TERMINAL_MAX_SESSIONS` | `32` | 全局终端会话上限 |
| `TERMINAL_MAX_SESSIONS_PER_DEVICE` | `4` | 每台设备的终端会话上限 |
| `TERMINAL_IDLE_TIMEOUT_MS` | `1800000` | 终端空闲多久后自动关闭 |
| `TERMINAL_DETACH_TTL_MS` | `300000` | 设备断线后保留会话的时长 |
| `TERMINAL_SCROLLBACK_BYTES` | `1048576` | 每个终端的回放缓冲大小 |
| `TERMINAL_MAX_VIEWERS` | `8` | 单个终端的并发浏览器窗口上限 |
| `TERMINAL_INPUT_BYTES_PER_SEC` | `65536` | 单个终端的输入速率上限 |
| `TERMINAL_ALLOWED_ENVS` | 空 | 允许开终端的设备 env 白名单；空表示全部 |

## bridge（MCP / CLI 端侧）

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `HUB_TOKEN` | 是 | — | 与服务端 `HUB_SECRET_TOKEN` 一致，或该 env 的专属 Token |
| `HUB_URL` | 否 | `http://127.0.0.1:8787` | 服务端地址 |
| `AGENT_ENV` | 否 | `unknown-<hostname>` | 看板环境标识；`init` 会按项目写入 `<客户端>-<项目名>`，多个工作区请勿共用 |
| `ZHUNZOU_AGENT_KIND` | 否 | `other` | 客户端类型：`cursor` / `opencode` / `claude-code` / `codex` / `gemini` / `qoder` / `windsurf` / `other`；`init` 自动写入 |
| `ZHUNZOU_PROJECT` | 否 | 自动推断 | 心跳上报的项目名；依次尝试显式值、编辑器工作区（Cursor `WORKSPACE_FOLDER_PATHS`、MCP `roots/list`）、git 根目录 / cwd 名 |
| `ZHUNZOU_FALLBACK` | 否 | `cli` | 长轮询超时后的保底策略：`cli` 或 `mcp`（旧名 `AGENT_HUB_FALLBACK`） |
| `ZHUNZOU_WAIT_TIMEOUT_MS` | 否 | `40000` | 单次长轮询窗口，钳制 1s–55s（旧名 `AGENT_HUB_WAIT_TIMEOUT_MS`） |
| `ZHUNZOU_CLI_COMMAND` | 否 | `npx zhunzou-bridge` | CLI 保底策略展示的命令；直接运行 `bin/mcp.js` 时自动指向同目录 `cli.js` / `cli.mjs` |
| `ZHUNZOU_HEARTBEAT_INTERVAL_MS` | 否 | `30000` | 心跳间隔，钳制 5s–5min |
| `ZHUNZOU_TRANSPORT` | 否 | `auto` | 任务/工单/会话领取传输：`auto` / `ws` / `http`；`auto` 优先 `/ws/bridge` 并自动回退 HTTP |
| `ZHUNZOU_CHAT_SESSION_ID` | 否 | — | 会话 runner 注入，把本轮接回正确的聊天会话 |
| `ZHUNZOU_AUTO_UPGRADE` | 否 | 开启 | 设 `0` / `false` / `off` / `no` 关闭后台自更新 |
| `ZHUNZOU_AUTO_UPGRADE_INTERVAL_MS` | 否 | `21600000` | 自更新检查间隔（最小 60s） |
| `ZHUNZOU_MCP_BIN` / `ZHUNZOU_CLI_BIN` | 否 | — | 覆盖 `init` 写进编辑器配置的入口路径 |
| `CODEX_HOME` | 否 | `~/.codex` | `init --target codex` 读写 `config.toml` 的位置 |
| `QODER_CONFIG_DIR` | 否 | `~/.qoder` | `init --target qoder` 读写 `settings.json` 的位置 |

### `wake` / `fleet` / `run` 守护进程变量（各有同名 CLI flag）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ZHUNZOU_WAKE_ADAPTER` | `auto` | 领取任务后使用的适配器 |
| `ZHUNZOU_WAKE_COMMAND` | — | `command` 适配器的命令模板，如 `claude -p {prompt}` |
| `ZHUNZOU_WAKE_ARGS` | — | 追加给 CLI 适配器的参数（空格分隔） |
| `ZHUNZOU_WAKE_CWD` | 当前目录 | 一次性适配器的工作目录 |
| `ZHUNZOU_WAKE_RUN_TIMEOUT_MS` | `1800000` | 单次任务运行最长执行时间 |
| `ZHUNZOU_WAKE_POLL_TIMEOUT_MS` | `40000` | 领取任务的长轮询窗口 |
| `ZHUNZOU_WAKE_NOTIFY_INTERVAL_MS` | `15000` | `notify` 适配器重复提醒的间隔 |
| `ZHUNZOU_CHAT_MODEL` | CLI 默认 | 交互式会话使用的模型；看板新建会话时可针对单个会话覆盖 |
| `ZHUNZOU_WORKTREES` | 关闭 | 取 `1` / `true` / `yes` / `on` 时，每个被领取的任务在 `.zhunzou/wt/<taskId>` 的独立 worktree（`wip/zz-<taskId>` 分支）里运行；仅环境变量，无 CLI flag |
| `ZHUNZOU_WRAP_IDLE_MS` | `300000` | `run` wrapper：多久没有按键才向 hub 提出移交，钳制 30s–2h（`--idle-timeout` 优先） |

## 设备节点（`zhunzou-device join` / `run`，均可用同名 flag 覆盖，flag 优先）

| 变量 | Flag | 默认值 | 说明 |
| --- | --- | --- | --- |
| `ZHUNZOU_NODE_ROLE` | `--role` | `worker` | `worker` / `portal` / `hybrid`；`portal` 只上报在线、永不接活 |
| `ZHUNZOU_NODE_TAGS` | `--tags` | 空 | 逗号分隔、最多 10 个——下发时可要求全部命中 |
| `ZHUNZOU_MAX_CONCURRENCY` | `--max-concurrency` | `1` | 该节点同时接几个任务，钳制 1–16；到顶后调度器跳过 |
| `ZHUNZOU_SCAN_DIRS` | `--scan-dir`（可重复） | 空 | 扫描 git checkout 的根目录，供 `repoName` 路由匹配；为空表示只按 env 路由 |
| `ZHUNZOU_HEARTBEAT_INTERVAL_MS` | `--heartbeat` | `15000` | 设备上报节奏，与服务端节点窗口对齐 |

`--token` 依次回退 `ZHUNZOU_DEVICE_TOKEN` → `HUB_TOKEN` → `HUB_SECRET_TOKEN`，`--hub` 回退 `ZHUNZOU_HUB_URL` → `HUB_URL`，`--env` 回退 `ZHUNZOU_DEVICE_ENV` → `AGENT_ENV`（默认 `device-<hostname>`）；重连退避用 `ZHUNZOU_RECONNECT_MIN_MS` / `ZHUNZOU_RECONNECT_MAX_MS`。
