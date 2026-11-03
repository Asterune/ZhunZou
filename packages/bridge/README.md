# zhunzou-bridge

端侧桥接器：把 Cursor / OpenCode / 任意 MCP 客户端接到「准奏」。提供 **MCP Server**（stdio）与 **CLI 阻塞等待** 两个入口，纯 JS/TS + `fetch`，无原生编译依赖，Windows / macOS 均可直接运行。

## 安装 / 构建

在仓库根目录：

```bash
pnpm install
pnpm build          # 构建 shared + server + bridge
```

### 一键接入向导

```bash
npx zhunzou-bridge init
```

向导会询问 `HUB_URL` / `HUB_TOKEN` / `AGENT_ENV` / 项目名，检测 Cursor / OpenCode / Claude Code，
写入对应 MCP 配置（保留其他 server），安装决策规则（Cursor 复制 `.cursorrules`，OpenCode 写入或追加 `AGENTS.md`），并校验服务端连通性。

> 在仓库内本地使用（尚未发布 npm）时：先 `pnpm build`，再运行
> `node packages/bridge/bin/cli.js init`。

非交互用法：

```bash
npx zhunzou-bridge init \
  --hub-url https://hub.example.com \
  --token "$HUB_SECRET_TOKEN" \
  --env company-cursor \
  --project yikuaomed-erp \
  --target all \
  --yes
```

`--dry-run` 只打印配置不落盘，`--skip-check` 跳过连通性检查。Token 会写入本地配置，注意不要提交到公开仓库。

### Windows 零依赖包（推荐给外部电脑）

Windows 机器不需要克隆仓库或安装 pnpm，只需要 Node.js 20+：

```bash
# 在 macOS / Linux 上生成
pnpm package:bridge:windows
# 产物：release/zhunzou-bridge-windows.zip
```

把 zip 拷到 Windows 解压，按包内 `README-WINDOWS.md` 配置 Cursor 的
`.cursor/mcp.json` 即可。包内是单文件 `mcp.mjs` / `cli.mjs`，已内置全部依赖。

生成逻辑见 `scripts/build-standalone.mjs`，完整说明见
[templates/WINDOWS.md](./templates/WINDOWS.md)。

### 发布与自更新

服务端会把 `release/bridge/` 下的产物以公开静态资源托管：

| 路径 | 用途 |
| --- | --- |
| `GET /api/bridge/latest` | 发布清单（含 `version` / `sha256` / `baseUrl`） |
| `GET /releases/bridge/<version>/mcp.mjs` | 单文件 MCP Server |
| `GET /releases/bridge/<version>/cli.mjs` | 单文件 CLI |

发布一个新版本（在仓库根目录，version 取自 `packages/bridge/package.json`）：

```bash
pnpm publish:bridge                                   # 构建 + 写入 release/bridge + 刷新 zip
pnpm publish:bridge -- --version 0.2.0 --notes "修复心跳重连"
bash deploy/deploy.sh                                  # 随仓库一起上传到 hub
```

端侧升级（不需要 npm、不需要重启 Cursor，下次启动生效）：

```bash
node cli.mjs upgrade --check
node cli.mjs upgrade
node cli.mjs upgrade --rollback
```

磁盘布局：`mcp.mjs` / `cli.mjs` 是引导器，真正运行的是 `versions/<version>/mcp.mjs`，
`current.json` 指向当前版本。升级只写 `versions/` 与 `current.json`，因此不会和
Windows 上的文件占用打架，回滚也只是改一行指针。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `HUB_TOKEN` | 是 | - | 与服务端 `HUB_SECRET_TOKEN` 一致 |
| `HUB_URL` | 否 | `http://127.0.0.1:8787` | 云端地址 |
| `AGENT_ENV` | 否 | `unknown-<hostname>` | 看板上的环境标识，如 `company-cursor`；`init` 会按项目写入 `<客户端>-<项目名>`，多个工作区请勿共用 |
| `ZHUNZOU_AGENT_KIND` | 否 | `other` | 客户端类型：`cursor` / `opencode` / `claude-code` / `codex` / `gemini` / `windsurf` / `other`；`init` 自动写入 |
| `ZHUNZOU_PROJECT` | 否 | 空 | 当前工作区的项目名，如 `agent-hub`；每次心跳自动绑定到该环境，下发任务的项目下拉框可直接选择 |
| `ZHUNZOU_FALLBACK`（旧名 `AGENT_HUB_FALLBACK`） | 否 | `cli` | 超时策略：`cli`（策略 1）或 `mcp`（策略 2） |
| `ZHUNZOU_WAIT_TIMEOUT_MS`（旧名 `AGENT_HUB_WAIT_TIMEOUT_MS`） | 否 | `40000` | 单次长轮询窗口，1s ~ 55s |
| `ZHUNZOU_CLI_COMMAND` | 否 | `npx zhunzou-bridge` | `cli` 策略下提示模型执行的命令；直接运行 `bin/mcp.js` 时自动指向同目录 `cli.js` / `cli.mjs` |
| `ZHUNZOU_HEARTBEAT_INTERVAL_MS` | 否 | `30000` | 在线心跳间隔，5s ~ 5min；启动 MCP 后立即上报一次 |
| `ZHUNZOU_WAKE_ADAPTER` | 否 | `auto` | `wake` 守护进程使用的适配器，见「自动唤醒」 |
| `ZHUNZOU_WAKE_COMMAND` | 否 | 空 | `command` 适配器的命令模板，如 `claude -p {prompt}` |
| `ZHUNZOU_WAKE_ARGS` | 否 | 空 | 追加给 CLI 适配器的参数，按空格分隔 |
| `ZHUNZOU_WAKE_CWD` | 否 | 当前目录 | 一次性适配器的工作目录 |
| `ZHUNZOU_WAKE_RUN_TIMEOUT_MS` | 否 | `1800000` | 一次性适配器最长执行时间 |
| `ZHUNZOU_WAKE_POLL_TIMEOUT_MS` | 否 | `40000` | 领取任务的长轮询窗口，1s ~ 55s |
| `ZHUNZOU_WAKE_NOTIFY_INTERVAL_MS` | 否 | `15000` | `notify` 适配器扫描待领取任务的间隔 |

## MCP Tools

| Tool | 作用 |
| --- | --- |
| `agent_hub_resume` | 重启/重连后恢复上下文：未决与近期工单 + 活跃任务 |
| `agent_hub_next_task` | 长轮询领取看板下发的任务；拿到后把环境标记为 `Running` 并返回任务指令 |
| `agent_hub_complete_task` | 回报下发任务 `DONE` / `FAILED`，环境回到 `Idle` |
| `agent_hub_report_task` | 上报当前正在做的普通任务，让看板显示真实状态 |
| `agent_hub_escalate` | 创建工单，然后长轮询最多 40s；拿到结果直接返回最终决策 |
| `agent_hub_wait` | 继续等待已有工单（策略 2 接力轮询） |
| `agent_hub_notify_done` | 上报 `Idle`，更新看板状态灯 |

超时返回两种引导文本（由 `ZHUNZOU_FALLBACK` 决定）：

- `cli`：`Ticket #104 is pending human approval. Please execute terminal command: npx zhunzou-bridge wait --ticket 104 ...`
- `mcp`：`[STATUS: STILL_WAITING] ... Call tool 'agent_hub_wait(ticketId: 104)' immediately ...`

## 挂载到 Cursor

把 `templates/cursor-mcp.json.example` 复制为项目或全局的 `.cursor/mcp.json`，修改绝对路径与 token。再把 `templates/.cursorrules` 复制到目标项目根目录（或合并进已有 `.cursorrules`）。

```bash
cp packages/bridge/templates/.cursorrules /path/to/target-project/.cursorrules
```

## 挂载到 OpenCode

参考 `templates/opencode.json.example`，在 `opencode.json` 的 `mcp.servers` 中注册本地 MCP Server。
然后把 `templates/AGENTS.md` 复制或合并到目标项目根目录的 `AGENTS.md`，让 OpenCode 在遇到决策时调用
`agent_hub_escalate` 而不是只在对话里提问（`init --target opencode` 会自动完成这一步）。

## CLI

```bash
# 直接使用
node packages/bridge/bin/cli.js wait --ticket 104

# 或安装为全局命令后（包已发布/已 link）
zhunzou-bridge wait --ticket 104
```

行为：每 15s 发起一次长轮询，直到工单被解决；把最终决策打印到 **stdout**，Cursor 终端可直接读取：

```text
Decision Approved: Option [B] - 行内文案
Instruction: 先只改登录页
Ticket: #104 (HUMAN_RESOLVED, resolved by HUMAN)
```

退出码：`0` 已解决、`1` 致命错误（如 401/404）、`2` 已取消、`130` Ctrl+C。
网络抖动/5xx 会自动重试；401 等不可重试错误立即退出，避免死循环。

## 自动唤醒（wake）

MCP 工具只能在**对话回合内**被调用。如果没有人操作编辑器，端侧不会主动去领任务，
看板就会一直显示「待领取」。`wake` 守护进程补上另一半：它常驻长轮询，任务一到就
把本机任意一个 AI 客户端唤醒。

```bash
# 自动选择：OpenCode → claude / codex / gemini / cursor-agent / aider / goose / amp → 桌面通知
zhunzou-bridge wake

# 指定客户端
zhunzou-bridge wake --adapter opencode
zhunzou-bridge wake --adapter claude --args "--model sonnet"
zhunzou-bridge wake --adapter command --command 'my-agent --task {taskId} {prompt}'

# 只跑一轮（冒烟测试 / cron）
zhunzou-bridge wake --once
```

### 适配器

| 适配器 | 唤醒方式 | 说明 |
| --- | --- | --- |
| `auto` | 自动探测 | 优先 OpenCode，其次常见 CLI Agent，最后退化为桌面通知 |
| `opencode` | 注入 | 通过 `opencode api` 把任务注入当前项目最近的会话；没有服务时回退 `opencode run` |
| `opencode-run` | 一次性 | `opencode run --auto "<prompt>"` |
| `claude` | 一次性 | `claude -p "<prompt>"`（Claude Code） |
| `codex` | 一次性 | `codex exec "<prompt>"` |
| `gemini` | 一次性 | `gemini -p "<prompt>"` |
| `cursor-agent` | 一次性 | `cursor-agent -p "<prompt>"` |
| `aider` | 一次性 | `aider --message "<prompt>"` |
| `goose` | 一次性 | `goose run -t "<prompt>"` |
| `amp` | 一次性 | `amp -x "<prompt>"` |
| `command` | 自定义 | 任意命令，支持 `{prompt}` `{instruction}` `{title}` `{taskId}` `{project}` `{env}` `{cwd}` 占位符 |
| `notify` | 桌面通知 | 只提醒、不领取，任务仍留在看板等人工触发 |

### 两种交付语义

- **注入（inject）**：守护进程先原子领取任务（`CLAIMED`），再把任务塞进当前会话。
  Agent 看到的是「已领取」提示，执行完自己调用 `agent_hub_complete_task` 回报。
- **一次性（run）**：守护进程领取后启动一个 CLI Agent，等待进程退出；
  退出码 `0` → `DONE`，否则 `FAILED`，并把输出尾部写进任务结果。
  `ZHUNZOU_WAKE_ARGS` / `--args` 可追加客户端参数。

两种方式失败时都会调用 `POST /api/tasks/:id/release` 把任务**重新排队**并弹通知，
不会把任务卡死在 `CLAIMED`。

### 常驻运行

macOS 用 `templates/launchd.plist.example` 放到 `~/Library/LaunchAgents/`；
Linux 用 systemd `ExecStart=/path/to/node /path/to/cli.js wake`；也可以交给 pm2：

```bash
pm2 start "zhunzou-bridge wake" --name zhunzou-wake
```

### 多项目托管（fleet）

`wake` 一次只管一个目录。`fleet` 在一个进程里为每个项目跑一条 wake 循环：

```bash
cp templates/fleet.example.json ~/.zhunzou/fleet.json
# 编辑 hubUrl / adminToken / projects
zhunzou-bridge fleet
```

```json
{
  "hubUrl": "https://hub.example.com",
  "adminToken": "HUB_SECRET_TOKEN，仅用于首次登记与签发",
  "adapter": "cursor-agent",
  "projects": [
    { "env": "cursor-yikuaomed-erp", "path": "~/code/yikuaomed-erp" },
    { "env": "opencode-zhunzou", "path": "~/code/zhunzou", "adapter": "opencode-run" }
  ]
}
```

- 每个项目对应 Hub 里的一个 `env`，可以独立下发任务、看状态、停用/轮换 Token。
- 没有 `token` 时会自动登记并签发专属 Token，缓存在
  `~/.zhunzou/fleet-tokens.json`（`0600`）；`--refresh-tokens` 强制轮换。
- 子循环崩溃会以 2 秒退避自动重启；`--once` 适合 cron 式调用。
- 看板「接入端」页按 host 汇总运行节点：托管项目数、在线数、bridge 版本。
- 开机自启：

  ```bash
  # macOS
  zhunzou-bridge fleet --print-launchd > ~/Library/LaunchAgents/com.zhunzou.fleet.plist
  launchctl load ~/Library/LaunchAgents/com.zhunzou.fleet.plist

  # pm2
  pm2 start "zhunzou-bridge fleet" --name zhunzou-fleet && pm2 save
  ```

  `--print-launchd` 使用当前 node/CLI 的绝对路径，请用全局安装或独立包，
  不要指向 npx 临时目录。

## 验证

```bash
pnpm --filter zhunzou-bridge test    # 单元 + 集成测试
pnpm smoke:bridge                      # 真实服务 + MCP stdio + CLI 端到端
```

也可以用 MCP Inspector 手动验证：

```bash
HUB_URL=http://127.0.0.1:8787 HUB_TOKEN=dev-token AGENT_ENV=company-cursor \
  npx @modelcontextprotocol/inspector node packages/bridge/bin/mcp.js
```
