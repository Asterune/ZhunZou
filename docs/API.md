# API 参考

本文是准奏 hub 的完整 HTTP / WebSocket 接口参考，由 README 迁出。
产品总览与快速上手见 [README.md](../README.md)（[中文](../README.zh-CN.md)），配置变量见 [docs/CONFIGURATION.md](./CONFIGURATION.md)。

## 约定

- 除 `GET /healthz`、签名审批页 `/a/:token`、签名任务放行页 `/t/:token`、安装脚本与静态看板外，所有接口都需要 `Authorization: Bearer <token>`。
- 所有响应为 JSON。错误统一返回 `{ "error": { "code": "...", "message": "...", "details"?: ... } }`；`400` 校验失败，`404` 未知 id，`409` 状态冲突（重复审批，或迟到的 Meta-Agent 结果不得覆盖人工决定）。

### 鉴权分层

| 层 | 谁能调用 | 说明 |
| --- | --- | --- |
| `public` | 无需鉴权 | `/healthz`、`/install.sh`、`/install.ps1`、`/api/enroll`、`/api/bridge/latest`、签名审批页 `/a/:token`、签名放行页 `/t/:token`、`/releases/bridge/*`、静态看板 |
| `admin` | `HUB_SECRET_TOKEN` | 看板侧操作：审批、下发、批量批复、会话、规则、接入端、接入码、终端 |
| `agent` | 管理员 Token **或**该 env 的专属 Token（`zz_…`） | 按 env（fleet 上报按 host）钉住，只能操作自己的环境：`POST /api/tickets`、`/wait`、`/cancel`、`/api/decisions`、任务领取与日志、`/api/exchanges`、心跳、`/api/resume`、`/api/fleet/*` 上报 |

专属 Token 存储为哈希，轮换 / 吊销无需重启服务端；未配置专属 Token 的旧客户端继续使用管理员 Token，完全兼容。

## 健康与公开端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 健康检查（免鉴权） |
| `GET` · `POST` | `/a/:token` | 签名审批页与其无 JS 提交入口（免 Bearer，链接自带能力与有效期） |
| `GET` · `POST` | `/t/:token` | 签名任务放行页；`POST /t/:token/release` 是唯一状态变更入口，destructive 勾选在服务端复核 |
| `GET` | `/install.sh` · `/install.ps1` | 服务端渲染的一键安装脚本（`?code=ABCDE-FGHIJ`，免鉴权） |
| `POST` | `/api/enroll` | 接入码换取专属 Agent Token（免鉴权，码本身是能力凭证） |
| `GET` | `/api/bridge/latest` | standalone bridge 发布清单，供 `upgrade` / 自更新使用（免鉴权） |

## 工单与决策

| 方法 | 路径 | 层 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/api/tickets` | agent | 创建工单，返回 `201`；挂在 parked run 上的 permission 工单先由 Supervisor L1 用学习规则做确定性裁决，其余异步触发 Meta-Agent 预审 |
| `GET` | `/api/tickets` | agent | 列表，支持 `?status=&projectName=&env=&limit=`；agent Token 自动收敛到自己的 env |
| `GET` | `/api/tickets/:id` | agent | 查询单个工单 |
| `GET` | `/api/tickets/:id/wait?timeout=40000` | agent | 长轮询；返回 `{ resolved, timedOut, ticket }` |
| `POST` | `/api/tickets/:id/resolve` | admin | 人工审批 `{ selectedOption, customInstruction?, confirmDestructive? }` |
| `POST` | `/api/tickets/batch-resolve` | admin | 批量审批 `{ ticketIds, selectedOption?, confirmDestructive? }` |
| `POST` | `/api/tickets/:id/extend` | admin | 暂缓自动裁决 `{ minutes? }`，默认 10 分钟 |
| `POST` | `/api/tickets/:id/cancel` | agent | 取消仍在等待的工单（bridge 超时 / 中断） |
| `POST` | `/api/decisions` | agent | 统一裁决入口：`{ kind, proposal, context?, risk?, options? }` → `APPROVED` 或 `PENDING` 工单 |
| `GET` | `/api/resume?env=...&since=...` | agent | 端侧重启恢复：未决/近期工单 + 活跃任务 |

### 工单状态机

```text
POST /tickets
      │
      ▼
PENDING_META ──(规范覆盖，自动拍板)──▶ AUTO_RESOLVED
      │
      └──(需人工 / 预审失败 / 未配置 LLM)──▶ PENDING_HUMAN ──(看板审批)──▶ HUMAN_RESOLVED
      │
      └──(端侧取消)──▶ CANCELLED
```

人工决定永远优先：即使 Meta-Agent 的回复迟到，也不会覆盖已完成的 `HUMAN_RESOLVED`（数据库条件更新保证）。

挂在 parked run 上的 permission 工单在进入预审前先过 Supervisor L1 的确定性裁决：命中人工授予过的放行规则立即 `AUTO_RESOLVED`（0ms、不调模型），命中提权、强推等不可逆动作签名则直接拒；L1 覆盖不了的灰区原样落回 `PENDING_META` → 人工的通路。

## 任务、实时输出与 Supervisor

任务状态：`PENDING` → `CLAIMED` → `DONE` / `FAILED`，另有 `CANCELLED`，以及两个需要人处理的 `BLOCKED`（熔断拦下，等人放行）与 `HEALING`（Supervisor 已下令重试）。

| 方法 | 路径 | 层 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/api/tasks` | admin | 下发任务到指定 env `{ env, title, instruction, projectName? }` |
| `POST` | `/api/tasks/dispatch` | admin | 按 `{ repoName?, env?, engine?, tags? }` 路由：hub 选定节点并返回 `{ task, route }`；无可行节点时报 `NO_ROUTE_TARGET` 并逐台列出拒绝原因 |
| `POST` | `/api/tasks/local` | agent | `run` 包裹的本机 CLI 把自己注册为 `LOCAL_WRAP` 任务（env 锁定为调用方） |
| `GET` | `/api/tasks` | admin | 任务列表，支持 `?env=&status=&limit=` |
| `GET` | `/api/nodes` | admin | 调度器视角下的机群：按节点心跳窗口（而非看板 90s 窗口）判活 |
| `GET` | `/api/tasks/:id` | agent | 查询单个任务 |
| `GET` | `/api/tasks/next?env=...&timeout=40000` | agent | 端侧长轮询领取任务（`PENDING` 与 `HEALING` 同队） |
| `POST` | `/api/tasks/:id/complete` | agent | 回报完成 / 失败 `{ status, result? }` |
| `POST` | `/api/tasks/:id/takeover` | agent | 本地 watcher 把自己盯着的 run 移交给 hub supervisor（`reason` 必填，幂等） |
| `POST` | `/api/tasks/:id/release` | agent \| public | 端侧唤不醒时交回任务 `{ requeue?, reason? }`；人类放行走签名页 `/t/:token/release` |
| `POST` | `/api/tasks/:id/retry` | admin | 人工覆盖失败熔断：把 `BLOCKED` 重开回队列，重试预算清零 |
| `POST` | `/api/tasks/:id/cancel` | admin | 取消尚未结束的任务 |
| `POST` | `/api/tasks/:id/log` | agent | 追加执行输出 `{ stream: stdout / stderr / system, chunk }`；wrapped run 与 wake 的输出发送前已降噪 |
| `GET` | `/api/tasks/:id/logs?after=&limit=` | agent | 增量读取执行输出 |
| `POST` | `/api/tasks/:id/events` | agent | 追加归一化 engine events（`tool_call` / `permission_required` / `session`）；仅在 `CLAIMED` 期间受理 |
| `GET` | `/api/tasks/:id/events?after=&limit=` | agent | 增量读取 engine events——parked run 续跑就靠它 |
| `GET` | `/api/supervisor/inbox` | admin | 决策收件箱读模型：还欠人看一眼的任务与 Supervisor 的解释 |
| `GET` · `POST` | `/api/learned-rules` | admin | 查看 / 授予 L1 放行规则：命中的 permission 工单不再调模型 |
| `PATCH` | `/api/learned-rules/:id` | admin | 启用 / 停用一条放行规则（授予是唯一写入方式，收回就是这把开关） |

### 任务状态机（人 → Agent）

```text
任务创建：POST /api/tasks · POST /api/tasks/dispatch · POST /api/tasks/local（origin LOCAL_WRAP）
      │
      ▼
PENDING ──(领取：agent_hub_next_task / wake，条件更新)──▶ CLAIMED ──(agent_hub_complete_task)──▶ DONE / FAILED

CLAIMED ──(release：端侧唤不醒，交回)────────────▶ PENDING / FAILED
FAILED  ──(熔断：同一失败重演 / 工作树无变化 / 重试满 3 次)──▶ BLOCKED
FAILED  ──(Supervisor 判定可自愈：RETRY_WITH_FIX)──▶ HEALING
HEALING ──(与 PENDING 同队被领取，engine 续跑同一 session)──▶ CLAIMED
BLOCKED ──(retry · 签名放行页：重新排队，retryCount 清零)──▶ PENDING
PENDING / CLAIMED ──(看板取消)──▶ CANCELLED

CLAIMED 期间还可被 POST /api/tasks/:id/takeover：本地 wrapped run 主动移交，
此后它的权限请求由 hub supervisor 裁决，不再等终端前的人。
```

- 任务按 `env` 隔离：只有同一 `AGENT_ENV` 的桥接能领取；领取是条件更新，并发领取只有一个赢家。`HEALING` 领取时带出 Supervisor 的修复指令（`fixPrompt`，一次性消费）。
- 每次领取累加 `attempts`；端侧离线超过 `TASK_CLAIM_TIMEOUT_MS` 自动放回 `PENDING`，超过 `TASK_MAX_ATTEMPTS` 或 `TASK_HARD_TIMEOUT_MS` 标记 `FAILED`。
- `BLOCKED` 永远不会被系统替人解开：`POST /api/tasks/:id/retry` 或签名放行页是唯一出口。

## 会话、草稿与镜像轮次

| 方法 | 路径 | 层 | 说明 |
| --- | --- | --- | --- |
| `POST` · `GET` | `/api/sessions` | admin | 新建 `{ env, projectName?, title?, model? }` / 列表（`?env=&limit=`）。`model` 为客户端原生模型 ID，省略则用端侧默认（`ZHUNZOU_CHAT_MODEL` / fleet 项目 `model`） |
| `GET` | `/api/sessions/:id` | agent | 会话详情与消息 |
| `DELETE` | `/api/sessions/:id` | admin | 删除会话（连带消息与输出记录） |
| `POST` | `/api/sessions/:id/close` | admin | 关闭会话 |
| `POST` | `/api/sessions/:id/messages` | admin | 发送用户消息 `{ content }` |
| `PATCH` | `/api/sessions/:id/messages/:messageId` | admin | 改写仍在排队的用户消息（仅 `PENDING` 人工消息） |
| `POST` | `/api/sessions/:id/messages/:messageId/cancel` | admin | 取消排队消息，保留为 `CANCELLED` 审计记录 |
| `GET` | `/api/sessions/:id/events` | agent | 增量读取会话输出 `?after=&messageId=` |
| `GET` | `/api/sessions/next?env=...&timeout=40000` | agent | 端侧 runner 领取下一条消息 |
| `POST` | `/api/sessions/:id/messages/:messageId/events` | agent | 追加流式输出 `{ stream, chunk }` |
| `POST` | `/api/sessions/:id/messages/:messageId/complete` | agent | 完成一轮 `{ status, content?, externalId?, error? }` |
| `POST` | `/api/sessions/:id/messages/:messageId/retry` | admin | 重试失败轮次（重置为待领取） |
| `POST` | `/api/sessions/proposals` | agent | Agent 起草下一句回复 `{ env, sessionId?, content, rationale? }`，存为 `PROPOSED` |
| `POST` | `/api/sessions/:id/proposals/:messageId/adopt` | admin | 采纳草稿（可带改写后的 `content`）并排队发送 |
| `POST` | `/api/sessions/:id/proposals/:messageId/discard` | admin | 丢弃草稿（保留记录用于审计） |
| `POST` | `/api/exchanges` | agent | 镜像一轮问答 `{ env, question?, conclusion?, projectName? }`（后两者至少填一项） |
| `GET` | `/api/exchanges` | admin | 镜像列表，支持 `?env=&projectName=&limit=` |

## 状态、实时与终端

| 方法 | 路径 | 层 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/api/status/heartbeat` | agent | 端侧上报 `{ env, status, projectName?, currentTask?, agent? }`，同时续租该端执行中的任务 |
| `GET` | `/api/status` | admin | 各接入端在线状态（90s 内有心跳视为在线） |
| `GET` | `/api/sync` | admin | 看板整表快照长轮询（`rev` / `changed`）；`/ws/realtime` 可用时自动暂停 |
| `POST` | `/api/realtime/ticket` | admin | 管理员 Token 换取短期看板 WebSocket ticket |
| `GET` | `/api/realtime/status` | admin | 实时网关状态（设备 / 看板 / bridge 连接数） |
| `POST` · `GET` | `/api/terminals` | admin | 在在线设备上创建 PTY 终端 / 列表（`env`、`status`、`limit`） |
| `GET` | `/api/terminals/stats` | admin | 终端指标（活跃数 / 窗口数 / 字节数） |
| `GET` | `/api/terminals/:id` | admin | 单个终端会话 |
| `POST` | `/api/terminals/:id/close` | admin | 关闭终端并终止 shell |
| `GET` | `/api/terminals/:id/events?after=` | admin | 有界 scrollback 回放 |
| `GET` | `/api/terminals/:id/audit?after=` | admin | 终端审计（输入 / 接管 / resize / 信号 / 关闭） |
| `GET` | `/api/terminals/:id/audit/export?format=csv` | admin | 导出审计为 CSV / JSONL |

## 接入端、规则与 fleet

| 方法 | 路径 | 层 | 说明 |
| --- | --- | --- | --- |
| `GET` · `POST` | `/api/agents` | admin | 接入端列表（`?status=active|disabled`）/ 手动登记 `{ env, name?, kind? }` |
| `GET` | `/api/devices` | admin | 设备列表：每台机器及其承载的接入端，附调度器路由所用的节点 profile |
| `GET` | `/api/projects` | admin | 项目视图：项目名对应的接入端、设备与工单/任务数量 |
| `PATCH` · `DELETE` | `/api/agents/:env` | admin | 改名 / 改类型 / 停用；删除接入端（历史工单保留，在线连接立即断开） |
| `POST` · `DELETE` | `/api/agents/:env/token` | admin | 签发或轮换专属 Token（明文只返回一次）/ 吊销 |
| `POST` | `/api/enrollments` | admin | 生成一次性接入码与安装命令（默认 15 分钟有效、最多 10 个客户端） |
| `GET` · `PUT` | `/api/rules` | admin | 读取 / 在线更新 `GLOBAL_RULES.md` |
| `GET` | `/api/rules/candidates` | admin | 候选规则列表，`?status=PENDING|ACCEPTED|DISMISSED&limit=` |
| `POST` | `/api/rules/candidates/:id/accept` · `/dismiss` | admin | 采纳候选规则并入 `GLOBAL_RULES.md` / 忽略 |
| `GET` · `POST` | `/api/workspace-projects` | admin | 工作区项目绑定列表（`?env=`）/ 绑定 `{ env, projectName }`（幂等） |
| `DELETE` | `/api/workspace-projects/:id` | admin | 解除一条工作区项目绑定 |
| `POST` · `GET` | `/api/fleet/candidates` | agent / admin | bridge 上报本机可关联目录（按 host 覆盖）/ 列表（`?host=`） |
| `POST` · `GET` | `/api/fleet/workspaces` | admin | 从候选目录创建关联 `{ candidateId }` / 关联任务列表（`?host=`） |
| `POST` | `/api/fleet/workspaces/:id/retry` | admin | 重试失败的关联 |
| `DELETE` | `/api/fleet/workspaces/:id` | admin | 解除目录关联并删除其 env |
| `GET` | `/api/fleet/desired` | agent | bridge 拉取本机待关联目录（含一次性 Token）与目录浏览请求 |
| `POST` | `/api/fleet/desired/:id/status` | agent | bridge 回报 `APPLIED` / `FAILED` |
| `POST` | `/api/fleet/browse` | admin | 请求 bridge 列出目录 `{ host, path? }` |
| `GET` | `/api/fleet/browse/:id` | admin | 读取目录浏览结果 |
| `POST` | `/api/fleet/browse/:id/result` | agent | bridge 回报目录列表 |

## WebSocket 端点

仅在 `REALTIME_ENABLED=true` 时启用；关闭后上面的 HTTP 路径原样可用作回退。帧级细节见 [docs/REALTIME.md](./REALTIME.md)。

| 路径 | 方向 | 用途与鉴权 |
| --- | --- | --- |
| `/ws/device` | 设备 → 中心 | 反向长连：`hello` + `heartbeat`（两者都可携带节点 profile，心跳另带空闲内存）、节点发来的 `permission.request` 与 hub 回下的 `supervisor.decision`，以及 `pty.*` 帧。管理员 Token（带 `?env=`）或设备专属 Token，走 Bearer 头或 `?token=` |
| `/ws/bridge` | bridge → 中心 | 任务 / 工单 / 会话领取（`task.claim` / `ticket.wait` / `chat.claim`），对应 `ZHUNZOU_TRANSPORT=auto`；鉴权同 `/ws/device` |
| `/ws/realtime` | 中心 → 浏览器 | 看板推送 `sync.snapshot` / `sync.changed`；需要 `POST /api/realtime/ticket` 换来的 `?ticket=`，或管理员 Bearer |
| `/ws/terminal` | 浏览器 ↔ 中心 | 一个 PTY 会话：`?ticket=&sessionId=&afterSeq=` 回放 scrollback，输入 / resize / 接管 / 关闭都会审计 |

未知 WS 路径直接以 `401` / `404` 拒绝。

## 长轮询约定

- 单次请求最长 55s（`MAX_WAIT_TIMEOUT_MS`），默认 40s，可用 `WAIT_TIMEOUT_MS` 调整。
- 已 resolved / cancelled 的工单会**立即**返回，不占用等待时间。
- 唤醒完全走内存 `EventEmitter`，等待期间**不会轮询数据库**；SQLite 只负责持久化。
- 超时返回 `{ resolved: false, timedOut: true, ticket }`，客户端可据此重试。
- 进程内唤醒意味着部署**必须单实例**；多实例需把唤醒层替换为 Redis pub/sub。
