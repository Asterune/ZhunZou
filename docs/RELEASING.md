# 发布与版本

## 版本号来源

只有一个地方需要改：`packages/bridge/package.json` 的 `version`。

- `scripts/build-standalone.mjs` 会用 esbuild `define` 把它烘进 bundle（`BRIDGE_VERSION`）；
- npm 包、自更新清单 `release/bridge/latest.json`、`zhunzou-bridge --version` 都读取同一个值；
- GitHub Release 工作流会校验 tag 与它一致，不一致直接失败。

## 发布 npm 包

前提：仓库 Secrets 中配置 `NPM_TOKEN`（npm Automation Token，拥有 `zhunzou-bridge` 的发布权限）。

```bash
# 1. 改版本号（遵循 semver）
pnpm --filter zhunzou-bridge version patch   # 或 minor / major

# 2. 本地验证打包内容
pnpm --filter zhunzou-bridge build
pnpm --filter zhunzou-bridge pack --dry-run

# 3. 提交并打 tag
git add -A && git commit -m "release: zhunzou-bridge v0.1.1"
git tag v0.1.1
git push origin main --tags
```

push tag 后 `.github/workflows/release.yml` 会执行 typecheck / test / build，
发布 `zhunzou-bridge` 到 npm，并创建 GitHub Release。

> npm 包内只有 `bin/`、`dist-standalone/`、`templates/`，依赖已被 esbuild 打进 bundle，
> 因此 `dependencies` 为空，安装时不会拉取 `@zhunzou/shared` / MCP SDK / zod。
> `prepack` 会自动重新构建，不要在仓库里手改 `dist-standalone`。

## 发布自更新渠道（独立包 / Windows zip）

`zhunzou-bridge upgrade` 走的是 hub 自己的 `/api/bridge/latest`，与 npm 渠道相互独立：

```bash
pnpm publish:bridge                       # 使用 package.json 版本
pnpm publish:bridge -- --version 0.1.1 --notes "修复心跳重连"
```

产物写入 `release/bridge/<version>/` 和 `release/bridge/latest.json`（已被 `.gitignore` 忽略），
再执行 `bash deploy/deploy.sh` 上传到服务器即可。

## 发布前检查清单

- [ ] `pnpm typecheck && pnpm test && pnpm build` 全部通过
- [ ] `pnpm smoke && pnpm smoke:bridge && pnpm smoke:web`（涉及服务端 / 端侧改动时）
- [ ] README 的版本/功能描述与实际一致
- [ ] 破坏性协议变更已写迁移说明
- [ ] 没有把 `.env`、数据库、Token、`dist-standalone` 提交进 Git
