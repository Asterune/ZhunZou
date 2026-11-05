# Zhunzou (准奏)

**English** · [中文说明](./README.zh-CN.md)

> Agents submit a brief. The Meta-Agent drafts a ruling. You say “approved”.

**A cross-device, editor-agnostic decision hub for AI coding agents.**

<p align="center">
  <img src="./docs/assets/dashboard.png" alt="Zhunzou dashboard: environment status, pending decision tickets, meta-agent escalation reasons, and destructive-option confirmation" width="920" />
</p>

When Cursor, OpenCode, Claude Code, or any MCP-capable agent gets blocked on a decision that needs a human, it submits a compact “three-line brief + closed-form options” ticket to Zhunzou. A Meta-Agent resolves routine decisions automatically against your engineering rules. Everything else waits in a single dashboard, and the agent resumes the moment you click.

Self-hosted, single process, SQLite-backed, MIT licensed. No message queue, no native build step on the client.

---

## The problem

AI agents are fast until they need a human judgment call. In practice, that is where most of the promised speed disappears:

- **The agent stalls where you cannot see it.** It stops in a terminal or editor tab you are not watching, and the task waits for hours.
- **Or it guesses, and you review the damage later.** You discover the wrong assumption during code review, or in production.
- **The same question comes back.** A decision lives in one chat transcript, so the next agent (or the next week) asks it again.
- **Every tool has its own approval silo.** A Cursor window, a Claude Code session, and a CI job each handle “waiting for a human” differently. Multi-repo and multi-agent teams have no single queue.
- **Automation is all-or-nothing.** Either the agent blocks on every question, or “YOLO mode” rubber-stamps changes that should never be automatic.

Existing options do not solve this well: a chat message has no structure, no timeout, no audit trail, and no way to resume the exact agent that asked. Vendor-specific approval UIs only cover one editor or one cloud.

## What Zhunzou does

Zhunzou turns every human decision into a small, structured, asynchronous ticket:

```text
Agent hits a blocker
  → submits a 3-line brief + 2–6 closed-form options (+ risk metadata)
  → Meta-Agent applies GLOBAL_RULES.md and similar past decisions
      → routine decision: auto-ruling in seconds
      → everything else: one queue on your phone or desktop
  → your click wakes the waiting agent over a long poll
  → the ruling becomes a candidate rule for next time
```

No polling loops, no lost context, and no need to keep the editor in front of you.

## Why Zhunzou

- **Decisions, not chat.** Every ticket is constrained to a three-line brief and closed-form options, so “what exactly are you asking?” never becomes another round trip.
- **Rules first, humans where it matters.** The Meta-Agent applies your `GLOBAL_RULES.md` and recalls similar resolved tickets. Routine choices clear in seconds; judgment calls always reach you.
- **One inbox for every agent.** Cursor, OpenCode, Claude Code, Codex, Gemini, Windsurf, or any MCP client — desktop, phone, or a signed notification link. One queue, one audit trail.
- **Works when you are away.** Long-polling resumes the exact agent immediately after approval. If you close the editor, a headless `wake` or `fleet` daemon keeps the work moving.
- **Safe by construction.** Destructive options are never auto-approved, timeout rulings are opt-in, and human decisions always beat a late Meta-Agent or timeout verdict.
- **Recall instead of repetition.** Resolved decisions are stored and recalled as precedents; each human approval can be distilled into a reusable rule.
- **Tiny operational footprint.** One Node.js process, one SQLite file, one port. No Redis, no message queue, no native build step on the client.
- **Open and self-hosted.** MIT licensed, plain HTTP API, pluggable models, notification channels, and agent adapters. Your decisions stay on your server.

**When it is a good fit:** you run AI coding agents across more than one repo or editor, you are tired of being the bottleneck, and you want automation without giving up control.

**When it is not:** you only need a single-user, single-session “yes/no” prompt inside one editor, or you are looking for a fully autonomous coding agent.

## Features

| Area | What it does |
| --- | --- |
| Decision tickets | Three-line brief, 2–6 closed-form options, recommended option, optional `risk` metadata |
| Meta-Agent | OpenAI-compatible / custom HTTP / disabled; strict JSON verdict; historical precedents |
| Decision memory | Recalls similar resolved tickets in the same project and injects them into the prompt |
| Rule distillation | Turns each human approval into a candidate rule; one-click accept into `GLOBAL_RULES.md` |
| Timeout rulings | Optional SLA (`AUTO_RESOLVE_TIMEOUT_MS`) with a countdown and “snooze 10 minutes” |
| Batch approval | Approve many tickets with a 3-second undo window; destructive options are skipped by default |
| Notifications | Bark, Feishu, Slack, Discord, ntfy, Telegram, generic webhook, console |
| One-click approval | HMAC-signed, expiring mobile page that works from any notification channel |
| Human → Agent tasks | Dispatch work from the dashboard; bridges claim it with `agent_hub_next_task` |
| Stale task recovery | Offline `CLAIMED` tasks are requeued; hard timeouts fail them instead of blocking the queue |
| Agent registry | Every `env` is manageable: client type, version, host, current project, enable/disable/delete |
| Scoped tokens | Per-agent Bearer tokens can only touch their own env; rotate or revoke without restarting the hub |
| Live task output | Expand a task card to tail `stdout` / `stderr` / system events while it runs; retained after completion |
| Interactive sessions | Chat with any project's agent from the hub; each turn resumes the CLI session (`--session` / `--resume`) |
| Resume | `agent_hub_resume` restores pending decisions and active tasks after a restart |
| Plugins | Lifecycle hooks for audit logs, IM bots, metrics, custom integrations |
| Realtime dashboard | `/ws/realtime` pushes snapshots and change frames; the legacy `/api/sync` long poll stays as an automatic fallback |
| PWA | Installable dashboard (manifest + icons + service worker): network-first shell, cached assets, offline fallback page, and an in-app update prompt (update now / later) |

## Architecture

```text
Cursor / OpenCode / Claude Code / any MCP client
        │  agent_hub_escalate / wait / next_task / resume
        ▼
zhunzou-bridge (stdio MCP + CLI, zero native deps)
        │  HTTP long-poll
        ▼
Zhunzou server (Fastify + SQLite + in-process EventEmitter)
        │
        ├── Meta-Agent ── rules + similar past decisions
        ├── Web dashboard (Vue 3, same port)
        └── Notifications (signed approval links)
```

## Quick start

Requirements: Node.js >= 20, pnpm 9 (`corepack enable pnpm`).

```bash
pnpm install
cp .env.example .env          # set HUB_SECRET_TOKEN and (optionally) OPENAI_API_KEY
pnpm build
pnpm server                   # http://127.0.0.1:8787
```

Open the dashboard and paste `HUB_SECRET_TOKEN`.

Without an LLM key the Meta-Agent is skipped and every ticket goes to a human. Set `META_AGENT_PROVIDER=none` to make that explicit.

### Docker

```bash
cp .env.example .env
docker compose up -d --build
```

The image serves the dashboard and API from one port and persists SQLite + rules in a volume.

## Connect an agent

```bash
npx -y zhunzou-bridge init
```

The wizard asks for the hub URL and token, detects Cursor / OpenCode / Claude Code, writes the MCP config, copies a rules template, and verifies connectivity. It never overwrites unrelated MCP servers.

Run `init` once **per workspace**. The wizard derives `AGENT_ENV` from the project name (`cursor-yikuaomed-erp`) and provisions a scoped token, so multiple Cursor windows show up as separate agents instead of overwriting each other's heartbeat. Cursor can only read the workspace it has open; to work across repositories, use a multi-root workspace or run one agent per repository.

### Headless: keep working when the editor is closed

Cursor CLI runs the same agent without the editor (`agent`, with `cursor-agent` as an alias):

```bash
curl https://cursor.com/install -fsS | bash
agent login                     # or export CURSOR_API_KEY=...
agent -p --force "list TODOs"   # print mode; --force applies edits
```

Then keep one wake daemon per repository; it dispatches tasks even when Cursor is not running:

```bash
cd /path/to/project
AGENT_ENV=cursor-my-project HUB_URL=... HUB_TOKEN=zz_... \
  zhunzou-bridge wake --adapter cursor-agent --cwd /path/to/project
```

The daemon runs `cursor-agent -p --force "<task brief>"` and reports `DONE` / `FAILED` from the exit code. If the CLI sandbox blocks the hub, adjust `--sandbox` or allow the hub domain. Without Cursor CLI, `--adapter opencode-run` and `--adapter claude` work the same way.

### One process for every project (fleet)

`fleet` runs one wake loop per repository in a single process, so the hub can dispatch to any project without an editor or a terminal per repo:

```bash
cp packages/bridge/templates/fleet.example.json ~/.zhunzou/fleet.json
zhunzou-bridge fleet
```

The config lists `hubUrl`, an optional `adminToken` (used once to register agents and issue scoped tokens, cached at `~/.zhunzou/fleet-tokens.json` with `0600`), and `projects: [{ env, path, project?, adapter?, token?, args? }]`. Each project appears as its own agent in the dashboard; `--refresh-tokens` rotates tokens and `--once` handles a single cycle.

Start it at login:

```bash
# macOS
zhunzou-bridge fleet --print-launchd > ~/Library/LaunchAgents/com.zhunzou.fleet.plist
launchctl load ~/Library/LaunchAgents/com.zhunzou.fleet.plist

# pm2
pm2 start "zhunzou-bridge fleet" --name zhunzou-fleet && pm2 save
```

The "接入端" page groups agents by host, so one card shows how many projects that machine hosts and how many are online.

### Reverse connection: device daemon (Phase 1)

The MCP bridge above is pull-based. To give the hub a persistent reverse
connection (and the foundation for the upcoming PTY console), run the device
daemon on each machine:

```bash
pnpm --filter @zhunzou/device build

node packages/device/bin/device.js run \
  --hub https://hub.example.com \
  --token zz_xxx \
  --env home-mac

# Inspect what this machine reports (OS, load, CLI inventory, PTY support)
node packages/device/bin/device.js capabilities
```

The daemon opens `wss://<hub>/ws/device`, sends a `hello` with OS/arch,
CPU/memory/load and a local CLI inventory (`claude`, `cursor-agent`,
`opencode`, `git`, `node`, ...), then heartbeats every 30 seconds. The
dashboard's 接入端 page shows the realtime badge, CPU/load/memory and available
tools. Set `REALTIME_ENABLED=false` to keep using only the legacy HTTP
heartbeat path.

`node-pty` is an optional dependency: presence-only devices still run without
it, and `capabilities` reports `pty: unavailable` until the native module is
installed.

### Interactive terminals (PTY)

The device daemon can also host real PTY shells (macOS forkpty, Windows
ConPTY). Install the optional native module once on each device:

```bash
pnpm --filter @zhunzou/device add node-pty
```

Then start the daemon as usual. The dashboard's **终端 / Terminal** tab lists
live sessions, opens an xterm.js view, and streams input/output over
`/ws/terminal`. Each session is routed to the device that owns it:

```text
browser xterm  ──/ws/terminal──▶ hub ──/ws/device──▶ node-pty (ConPTY/forkpty)
```

Sessions survive a browser refresh (scrollback replay by seq) and a device
WebSocket reconnect (`pty.attach`). Server restarts rehydrate session metadata
and ask the device to reattach; if the device process is gone the session is
marked `LOST`.

Safety limits: `TERMINAL_ENABLED`, `TERMINAL_MAX_SESSIONS`,
`TERMINAL_MAX_SESSIONS_PER_DEVICE`, `TERMINAL_MAX_VIEWERS`,
`TERMINAL_IDLE_TIMEOUT_MS`, `TERMINAL_DETACH_TTL_MS`,
`TERMINAL_SCROLLBACK_BYTES`, `TERMINAL_INPUT_BYTES_PER_SEC` and
`TERMINAL_ALLOWED_ENVS`. Only one viewer holds the input lease at a time;
other viewers can click **Take control**. Input, resize, signal, claim and
close events are written to `terminal_audit`, exposed at
`/api/terminals/:id/audit`, and downloadable as CSV / JSONL. Each device also
has a **terminal enabled** toggle in the 接入端 page; disabling it returns
`TERMINAL_FORBIDDEN` for new sessions.

Or configure manually:

```bash
# MCP server (stdio)
npx -y zhunzou-mcp

# CLI: block until a decision, print it to stdout
npx -y zhunzou-bridge wait --ticket 104

# From a local checkout (before npm publish):
node packages/bridge/bin/mcp.js
node packages/bridge/bin/cli.js init
```

### MCP tools

| Tool | Purpose |
| --- | --- |
| `agent_hub_escalate` | Create a ticket, long-poll, return the decision or a waiting instruction |
| `agent_hub_decide` | Ask the hub to rule on the next reply/step/action; returns a permit or opens a ticket |
| `agent_hub_wait` | Continue waiting for an existing ticket |
| `agent_hub_resume` | Recover pending decisions and active tasks after a restart |
| `agent_hub_next_task` | Claim a task dispatched from the dashboard |
| `agent_hub_complete_task` | Report `DONE` / `FAILED` |
| `agent_hub_report_task` | Show the current real task on the dashboard |
| `agent_hub_propose_reply` | Draft the human's next chat reply; it stays pending until a human adopts it |
| `agent_hub_notify_done` | Mark the environment `Idle` |

Environment variables:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `HUB_TOKEN` | yes | — | Same as server `HUB_SECRET_TOKEN` |
| `HUB_URL` | no | `http://127.0.0.1:8787` | Server URL |
| `AGENT_ENV` | no | `unknown-<hostname>` | Environment label, e.g. `company-cursor`. `init` writes `<client>-<project>` so each workspace stays distinct |
| `ZHUNZOU_AGENT_KIND` | no | `other` | Client type: `cursor` / `opencode` / `claude-code` / `codex` / `gemini` / `windsurf` / `other`; written by `init` |
| `ZHUNZOU_PROJECT` | no | auto-detected | Project name reported in heartbeats; defaults to the git root / cwd basename |
| `ZHUNZOU_FALLBACK` | no | `cli` | `cli` or `mcp` after a 40s timeout |
| `ZHUNZOU_WAIT_TIMEOUT_MS` | no | `40000` | Single long-poll window |
| `ZHUNZOU_CLI_COMMAND` | no | `npx zhunzou-bridge` | Command shown in CLI fallback |
| `ZHUNZOU_HEARTBEAT_INTERVAL_MS` | no | `30000` | Heartbeat interval |
| `ZHUNZOU_TRANSPORT` | no | `auto` | `auto` / `ws` / `http` for task/ticket/chat claims. `auto` uses `/ws/bridge` and falls back to HTTP |

Templates live in [`packages/bridge/templates`](./packages/bridge/templates).

## API

All `/api/*` routes require `Authorization: Bearer <HUB_SECRET_TOKEN>`. `/healthz` and `/a/:token` are public.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/healthz` | Health check |
| `GET` | `/a/:token` | Signed mobile approval page |
| `POST` | `/a/:token/resolve` | Submit a decision from the page |
| `POST` | `/api/tickets` | Create a ticket |
| `POST` | `/api/decisions` | Hub-side judgment: `{ kind, proposal, context?, risk?, options? }` → `APPROVED` or a `PENDING` ticket |
| `GET` | `/api/tickets` | List tickets (`status`, `projectName`, `limit`) |
| `GET` | `/api/tickets/:id` | Get one ticket |
| `GET` | `/api/tickets/:id/wait?timeout=40000` | Long-poll for a decision |
| `POST` | `/api/tickets/:id/resolve` | Human approval (`selectedOption`, `customInstruction?`, `confirmDestructive?`) |
| `POST` | `/api/tickets/batch-resolve` | Batch approval (`ticketIds`, `selectedOption?`) |
| `POST` | `/api/tickets/:id/extend` | Snooze the timeout (`minutes?`, default 10) |
| `POST` | `/api/tickets/:id/cancel` | Cancel a pending ticket |
| `POST` | `/api/tasks` | Dispatch a task to an env |
| `GET` | `/api/tasks/next?env=...` | Bridge claims the next task |
| `POST` | `/api/tasks/:id/complete` | Report task result |
| `POST` | `/api/tasks/:id/log` | Append live output (`stdout` / `stderr` / `system`) |
| `GET` | `/api/tasks/:id/logs` | Incremental log tail (`?after=&limit=`) |
| `POST` | `/api/sessions` | Create a chat session |
| `GET` | `/api/sessions` | List sessions |
| `DELETE` | `/api/sessions/:id` | Delete a session with its transcript and output |
| `POST` | `/api/sessions/:id/messages` | Send a user message |
| `POST` | `/api/sessions/proposals` | Agent drafts the next reply (`env`, optional `sessionId`) — stored as `PROPOSED` |
| `POST` | `/api/sessions/:id/proposals/:messageId/adopt` | Adopt a draft, optionally with edited `content`, and queue it |
| `POST` | `/api/sessions/:id/proposals/:messageId/discard` | Reject a draft (kept for audit) |
| `GET` | `/api/sessions/next?env=...` | Runner claims the next message |
| `POST` | `/api/sessions/:id/messages/:messageId/events` | Append streamed output |
| `POST` | `/api/sessions/:id/messages/:messageId/complete` | Finish a turn (content + session id) |
| `POST` | `/api/sessions/:id/messages/:messageId/retry` | Requeue a failed turn |
| `POST` | `/api/status/heartbeat` | Bridge heartbeat |
| `GET` | `/api/status` | Online environments |
| `POST` | `/api/realtime/ticket` | Exchange the admin token for a short-lived dashboard WebSocket ticket |
| `GET` | `/api/realtime/status` | Realtime gateway status (devices / dashboards / bridges) |
| `POST` | `/api/terminals` | Create a PTY terminal on an online device |
| `GET` | `/api/terminals` | List terminal sessions (`env`, `status`, `limit`) |
| `GET` | `/api/terminals/:id` | Get one terminal session |
| `POST` | `/api/terminals/:id/close` | Close a terminal and terminate its shell |
| `GET` | `/api/terminals/:id/events?after=` | Bounded scrollback replay |
| `GET` | `/api/terminals/:id/audit?after=` | Terminal audit trail (input/claim/resize/signal/close) |
| `GET` | `/api/terminals/:id/audit/export?format=csv` | Download the audit trail as CSV or JSONL |
| `GET` | `/api/terminals/stats` | Terminal metrics (active/viewers/bytes) |
| `GET` | `/api/resume?env=...` | Pending/recent tickets + active tasks |
| `GET/PUT` | `/api/rules` | Read/update `GLOBAL_RULES.md` |
| `GET` | `/api/rules/candidates` | Distilled rule candidates |
| `POST` | `/api/rules/candidates/:id/accept` | Accept a candidate rule |
| `POST` | `/api/rules/candidates/:id/dismiss` | Dismiss a candidate rule |
| `GET` | `/api/workspace-projects` | Project bindings per env |
| `POST` | `/api/workspace-projects` | Bind a project to an env |
| `DELETE` | `/api/workspace-projects/:id` | Unbind |

## Configuration

Copy `.env.example` to `.env`. Common variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Listen address |
| `HUB_SECRET_TOKEN` | dev fallback | **Must be set in production** |
| `DATABASE_PATH` | `./data/zhunzou.db` | SQLite file |
| `GLOBAL_RULES_PATH` | `./GLOBAL_RULES.md` | Rule file |
| `META_AGENT_PROVIDER` | `openai` | `openai` / `http` / `none` |
| `OPENAI_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI-compatible endpoint |
| `OPENAI_API_KEY` | empty | Empty = skip auto-review |
| `META_AGENT_MODEL` | `deepseek-chat` | Review model |
| `DECISION_POLICY` | `reply` | Who decides: `off` (always ask), `reply` (hub auto-sends chat replies only), `all` (hub also rules on next steps; destructive always asks) |
| `AUTO_RESOLVE_TIMEOUT_MS` | `0` | Timeout SLA; `0` disables |
| `AUTO_RESOLVE_PROJECTS` | empty | Project allowlist; empty = all |
| `PUBLIC_BASE_URL` | empty | Origin used in signed approval links |
| `APPROVAL_LINK_SECRET` | `HUB_SECRET_TOKEN` | HMAC key for approval links |
| `APPROVAL_LINK_TTL_MS` | `1800000` | Approval link lifetime |
| `REALTIME_ENABLED` | `true` | Enable the device/dashboard WebSocket gateway |
| `REALTIME_TICKET_TTL_MS` | `60000` | Browser WebSocket ticket lifetime |
| `REALTIME_HEARTBEAT_MS` | `30000` | Device heartbeat interval |
| `REALTIME_HEARTBEAT_TIMEOUT_MS` | `90000` | Close a device socket after silence |
| `TERMINAL_ENABLED` | `true` | Enable interactive PTY terminals |
| `TERMINAL_MAX_SESSIONS` | `32` | Global active terminal cap |
| `TERMINAL_MAX_SESSIONS_PER_DEVICE` | `4` | Per-device active terminal cap |
| `TERMINAL_IDLE_TIMEOUT_MS` | `1800000` | Close an idle terminal |
| `TERMINAL_DETACH_TTL_MS` | `300000` | Keep a detached session while the device reconnects |
| `TERMINAL_SCROLLBACK_BYTES` | `1048576` | In-memory replay buffer per terminal |
| `TERMINAL_MAX_VIEWERS` | `8` | Concurrent browser viewers per terminal |
| `TERMINAL_INPUT_BYTES_PER_SEC` | `65536` | Per-terminal input rate limit |
| `TERMINAL_ALLOWED_ENVS` | empty | Device env allowlist; empty = all |
| `TASK_CLAIM_TIMEOUT_MS` | `1800000` | Requeue an offline `CLAIMED` task |
| `TASK_HARD_TIMEOUT_MS` | `21600000` | Fail a `CLAIMED` task regardless of heartbeat |
| `TASK_MAX_ATTEMPTS` | `3` | Max claims before failing |

## Safety model

- Human decisions always win over late Meta-Agent or timeout verdicts (conditional updates).
- `risk: "destructive"` options require explicit human confirmation and are never auto-approved.
- Approval links are HMAC-signed, scoped to one ticket, and expire; the ticket status prevents replay.
- Notifications and plugins are fire-and-forget: a broken channel never blocks approvals.
- Long-poll wakeups use an in-process `EventEmitter`, so deployment is **single instance** by design.

## Development

```bash
pnpm test          # 28 shared + 191 server + 113 bridge + 9 device + 39 web
pnpm typecheck
pnpm build
pnpm smoke         # real HTTP long-poll smoke test
pnpm smoke:web     # single-port dashboard smoke test
```

## Deployment

`deploy/` contains a systemd + nginx setup, HTTPS helper, and a one-command deploy script. `docker-compose.yml`, `Dockerfile`, and `ecosystem.config.cjs` (pm2) are also included.

Because wakeups are in-process, run **one** server instance. If you need horizontal scaling, replace the `EventEmitter` wakeup layer with Redis pub/sub.

## Contributing

MIT licensed. Issues and PRs are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) and [docs/PLUGINS.md](./docs/PLUGINS.md). If you add a model provider, notification channel, or agent adapter, please contribute it as an example.
