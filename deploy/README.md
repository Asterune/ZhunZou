# 准奏 服务器部署

目标服务器与 pte-dojo 相同：`154.219.111.22`（Ubuntu 24.04，nginx 已占用 80/443）。
准奏 作为独立站点运行：

- 目录：`/opt/zhunzou`
- 进程：systemd `zhunzou.service`，监听 `127.0.0.1:8899`
- 入口：nginx `hub.l1uqi.com` → `127.0.0.1:8899`（网页与 API 同源）
- 数据：`/opt/zhunzou/data/zhunzou.db`、`data/GLOBAL_RULES.md`
- WebSocket：nginx 配置包含 `/ws/*` 的 `Upgrade` / `Connection` 头；对已有 certbot 配置，`setup.sh` 会在原文件上补齐，不会覆盖证书配置
- 首次部署会复用 `/opt/pte-dojo/server/.env` 中的 `AI_*` 配置作为 Meta-Agent

## 一键部署

```bash
# 首次需要先加 DNS：hub.l1uqi.com A 154.219.111.22
bash deploy/deploy.sh

# DNS 生效后申请证书并启用 HTTPS
bash deploy/enable-https.sh
```

部署完成后会打印 `HUB_SECRET_TOKEN`，浏览器打开 `https://hub.l1uqi.com/` 粘贴即可。
通知里的签名审批链接默认使用 `https://<domain>`；如需改到别的公开地址，编辑 `.env` 的 `PUBLIC_BASE_URL`。

## 常用运维

```bash
systemctl status zhunzou
journalctl -u zhunzou -f
systemctl restart zhunzou

# 更新代码
bash deploy/deploy.sh

# 证书续期检查
certbot renew --dry-run
```

## 注意事项

- 长轮询依赖进程内 `EventEmitter`，**只能单实例**；不要给 systemd 配多进程。
- `data/` 与 `.env` 不在发布包内，重新部署不会覆盖数据库、规则与 Token。
- nginx 配置仅在首次部署时写入；之后由 certbot 维护 443 配置，`setup.sh` 不会覆盖。
- 若 8899 端口被占用，用 `--app-port` 换一个端口重新部署。
