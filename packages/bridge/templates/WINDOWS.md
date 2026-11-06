# 准奏 Windows 接入包（Cursor / OpenCode / Claude Code / Codex）

这个文件夹已经打好包，**不需要安装 npm 依赖，也不需要克隆源码**。Windows 上只需要 Node.js。

> **更省事的方式**：看板「接入端 → 一键接入」生成 PowerShell 命令，在目标电脑直接执行
> ```powershell
> irm 'https://hub.example.com/install.ps1?code=ABCDE-FGHIJ' | iex
> ```
> 它会自动准备 Node、下载 bridge，并为 Cursor / OpenCode / Claude Code / Codex
> 各写一份配置（一台电脑 4 张卡，互不覆盖心跳），然后注册登录自启。
> 下面 2~4 节是**手动解压版**的做法。

## 1. 安装 Node.js

从 https://nodejs.org/ 下载 **LTS x64** 安装包，一路默认安装。

打开 PowerShell 验证：

```powershell
node -v
# 应输出 v20.x 或更高
```

## 2. 放置本文件夹

把整个文件夹放到例如：

```text
C:\Users\你的用户名\zhunzou-bridge\
├── mcp.mjs                  # MCP Server
├── cli.mjs                  # CLI（upgrade / wait）
├── cursor-mcp.json.example  # Cursor 配置示例
├── cursorrules.example      # 项目行为约束模板
└── README-WINDOWS.md
```

文件夹里必须能直接看到 `mcp.mjs`。

> 执行过 `node cli.mjs upgrade` 之后，这里会多出 `current.json` 和 `versions\`
> 目录：`mcp.mjs` / `cli.mjs` 只负责启动，真正的代码在各版本目录里，`current.json`
> 指出当前用哪个版本。所以**不要删这两个东西**，也不要手改 `mcp.mjs`。

## 3. 配置 Cursor

### 项目级（推荐）

在目标项目根目录新建：

```text
<你的项目>\.cursor\mcp.json
```

写入（把三处占位符换成你自己的）：

```json
{
  "mcpServers": {
    "zhunzou": {
      "command": "node",
      "args": [
        "C:/Users/你的用户名/zhunzou-bridge/mcp.mjs"
      ],
      "env": {
        "HUB_URL": "https://hub.l1uqi.com",
        "HUB_TOKEN": "替换成 HUB_SECRET_TOKEN",
        "AGENT_ENV": "company-windows",
        "ZHUNZOU_PROJECT": "your-project-name",
        "ZHUNZOU_FALLBACK": "cli",
        "ZHUNZOU_WAIT_TIMEOUT_MS": "40000"
      }
    }
  }
}
```

### 全局级

也可以放到：

```text
C:\Users\你的用户名\.cursor\mcp.json
```

这样所有项目都能用。

> Windows 路径建议使用正斜杠 `/`，JSON 里不用写 `\\`。
> 如果 Cursor 找不到 `node`，把 `"command": "node"` 改成 Node 的绝对路径，例如
> `"command": "C:/Program Files/nodejs/node.exe"`。

改完后**完全退出 Cursor 再重新打开**（不是只关窗口）。在 Cursor 的 MCP 面板应看到
`zhunzou`，以及以下工具：

- `agent_hub_next_task`：领取看板下发的任务（长轮询）
- `agent_hub_complete_task`：回报下发任务完成 / 失败
- `agent_hub_report_task`：上报当前正在做的任务
- `agent_hub_decide`：统一裁决入口，提交提案由 hub 决定放行还是转人工
- `agent_hub_escalate`：遇到需要拍板的卡点时上奏（低层工具）
- `agent_hub_wait`：继续等待审批结果
- `agent_hub_notify_done`：普通任务完成或进入空闲

MCP 启动后会立即上报一次心跳，并每 30 秒续期。因此看板里的
`company-windows` 应在几秒内变为「在线 / 空闲」，不需要先提交工单。
Agent 开始做事时调用 `agent_hub_report_task`，看板就会显示真实任务，
而不是一直停留在「MCP 已连接」。

### Codex（可选）

Codex 只读用户级配置 `C:\Users\<你>\.codex\config.toml`（可用 `CODEX_HOME` 改位置）。
在文件末尾追加（或让它覆盖已有的 `[mcp_servers.zhunzou]` 段）：

```toml
[mcp_servers.zhunzou]
command = "node"
args = ["C:/Users/你的用户名/zhunzou-bridge/mcp.mjs"]
env = { HUB_URL = "https://hub.l1uqi.com", HUB_TOKEN = "zz_xxx", AGENT_ENV = "codex-my-project", ZHUNZOU_PROJECT = "my-project", ZHUNZOU_AGENT_KIND = "codex", ZHUNZOU_FALLBACK = "cli" }
```

每个客户端用**不同的 `AGENT_ENV` 和 Token**（看板「接入端」里给每个 env 单独签发），
否则多开时心跳会互相覆盖，看板只剩一张卡。

## 4. 给项目加行为约束

把 `cursorrules.example` 复制到目标项目根目录，并改名为：

```text
<你的项目>\.cursorrules
```

它告诉模型：什么时候该升级、三行简报怎么写、超时后必须等待，而不是自己猜。

## 5. 验证

在 Cursor 里提出一个需要拍板的问题，例如：

> 登录页错误提示用 Toast 还是行内文案？请走准奏审批。

模型调用 `agent_hub_escalate` 后：

1. 看板 https://hub.l1uqi.com 出现新工单；
2. 环境状态出现 `company-windows`，状态为「等待决策」；
3. 你点一个方案；
4. Cursor 在 100ms 级收到结果继续执行。

## 6. 从看板下发任务

1. 打开看板「下发任务」页；
2. 目标环境填 `company-windows`，写清标题与详细指令；
3. 项目名可以直接从下拉框选择：配置了 `ZHUNZOU_PROJECT` 后，这个工作区会自动绑定该项目；也可在表单下方手动绑定更多项目；
4. 下发后 Agent 调用 `agent_hub_next_task` 领取，状态会变成「执行中」；
5. Agent 完成后调用 `agent_hub_complete_task`，看板状态回到「空闲」。

如果 Agent 正在做用户直接输入的任务，让它先调用
`agent_hub_report_task`，看板同样会显示真实任务。

## 7. CLI 用法

审批超时后，Cursor 可能提示执行终端命令。你也可以手动等待：

```powershell
cd C:\Users\你的用户名\zhunzou-bridge
node cli.mjs wait --ticket 104
```

它会阻塞到审批完成，把决定打印到终端，退出码为 0。

不开编辑器、只想让某个目录常驻领取任务：

```powershell
node cli.mjs fleet add D:\work\erp D:\work\crm --code ABCDE-FGHIJ
node cli.mjs fleet list
node cli.mjs fleet remove cursor-erp
node cli.mjs service status
node cli.mjs service restart
```

`fleet add` 会推断项目名、写 `~\.zhunzou\fleet.json`；`--code` 用看板接入码为每个项目签发专属 Token，不需要管理员 Token。已安装常驻服务时会自动重启用新配置。

## 8. 常见问题

| 现象 | 处理 |
| --- | --- |
| MCP 面板没有 `zhunzou` | 检查 JSON 路径、末尾逗号；完全重启 Cursor |
| `node` 不是内部或外部命令 | 重装 Node.js，或把 `command` 改成 node.exe 绝对路径 |
| `HUB_TOKEN is required` | `env` 没写进配置，或 JSON 结构错误 |
| 401 Unauthorized | `HUB_TOKEN` 与服务端 `HUB_SECRET_TOKEN` 不一致 |
| 连接超时 | `HUB_URL` 必须是 `https://hub.l1uqi.com`，不要带 `/api` |
| 工具调用后模型停了 | 确认 `.cursorrules` 已放入项目，且 `ZHUNZOU_FALLBACK=cli` |
| 公司网络有代理 | 需要允许访问 `hub.l1uqi.com` 的 443 端口 |

## 9. 更新与回滚

桥接包会从 hub 检查新版本，只写 `versions\` 和 `current.json`，**不覆盖正在运行的
`mcp.mjs`**，所以升级时不需要先关 Cursor（新版本在下次启动时生效）。

从 0.1.1 起默认开启自动更新：`mcp.mjs` / `wake` 启动时会在后台检查一次
`/api/bridge/latest`（每 6 小时最多一次），有新版就下载、校验 sha256 并切换，
**下次启动生效**。失败只写日志，不影响当前使用。

- 关闭自动更新：设置环境变量 `ZHUNZOU_AUTO_UPGRADE=0`
- 调整检查间隔：`ZHUNZOU_AUTO_UPGRADE_INTERVAL_MS=21600000`（毫秒）
- 仅对解压版生效；npm 安装和源码仓库请用 npm / git 更新

也可以随时手动执行：

```powershell
node cli.mjs upgrade --check    # 只看有没有新版本
node cli.mjs upgrade            # 下载 + 校验 sha256 + 切换
node cli.mjs upgrade --rollback # 回滚到上一个已安装版本
```

升级完成后**完全退出 Cursor 再打开**，MCP 会以新版本启动；启动日志里会多一行
`bootstrapping bridge x.y.z`。默认保留最近 3 个版本，更旧的在升级时自动清理。

`upgrade` 读的是 `HUB_URL`（不需要 `HUB_TOKEN`，发布包是公开的）；也可以临时指定：

```powershell
node cli.mjs upgrade --hub-url https://hub.l1uqi.com
```

| 现象 | 处理 |
| --- | --- |
| `服务器上还没有发布桥接包` | 运维侧还没执行 `pnpm publish:bridge` |
| `sha256 校验失败` | 下载被中断或被代理改写，重跑一次；仍失败请检查网络 |
| `EPERM` / `EBUSY` | 目标版本目录被占用，完全退出 Cursor 后重试 |
| 升级后行为没变 | 重启的是窗口而不是进程，需完全退出 Cursor |

## 10. 安全

- `HUB_TOKEN` 等同于看板登录密码，不要提交到 git、不要发到公开群。
- 只需要 Node.js，不需要管理员权限，也不会安装后台服务。
