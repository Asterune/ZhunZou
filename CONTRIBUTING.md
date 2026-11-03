# 参与贡献

欢迎 Issue 与 Pull Request。准奏的目标是保持核心小而稳定，把差异留在扩展点里。

## 开发环境

```bash
corepack enable pnpm
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

本地联调：

```bash
pnpm dev       # 服务端 :8787
pnpm dev:web   # 看板 :5173
```

## 改动约定

- 保持 KISS：不引入消息队列、不引入重量级前端状态库；新增依赖前先说明必要性。
- 核心协议（`DecisionTicket`、REST API、MCP 工具名）尽量向后兼容；破坏性变更需要写迁移说明。
- 外部能力优先做成扩展点：预审模型用 `META_AGENT_PROVIDER`，通知用 `NOTIFY_CHANNELS`，自定义逻辑用 `HUB_PLUGINS`，见 [docs/PLUGINS.md](./docs/PLUGINS.md)。
- 新增行为必须带测试；提交前确保 `pnpm typecheck && pnpm test && pnpm build` 通过。
- 提交信息用祈使句，说明「为什么」而不只是「改了什么」。

## 目录速览

| 目录 | 职责 |
| --- | --- |
| `packages/shared` | Zod Schema、类型、状态机常量（协议层） |
| `packages/server` | Fastify API、SQLite、长轮询、Meta-Agent、通知、插件 |
| `packages/bridge` | MCP Server + CLI（端侧） |
| `packages/web` | Vue 3 看板 |
| `deploy/` | systemd + nginx 生产部署 |
| `examples/plugins/` | 扩展插件示例 |

## 安全

- 永远不要提交 `.env`、数据库、Token 或 API Key。
- 插件模块以服务进程权限运行，评审时请特别留意文件与网络访问。
- 生产环境必须设置强随机 `HUB_SECRET_TOKEN`，并建议放在 HTTPS 反向代理之后。
