# Realtime device gateway

Phase 1 of the cross-device control plane. The gateway is **additive**: all
existing HTTP APIs and long polls keep working, and `REALTIME_ENABLED=false`
turns the WebSocket layer off completely.

## Endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /ws/device?env=<env>` | `Authorization: Bearer zz_...` (scoped agent token) or the admin token | Device reverse connection |
| `GET /ws/realtime?ticket=<ticket>` | Short-lived ticket from `POST /api/realtime/ticket` | Dashboard presence stream |
| `POST /api/realtime/ticket` | Admin Bearer token | Exchange for a 60s dashboard ticket |
| `GET /api/realtime/status` | Admin Bearer token | Device / dashboard connection counts |

Browsers cannot set an `Authorization` header on a WebSocket handshake, so the
dashboard never puts the long-lived admin token in a URL. `ticket` is an
HMAC-signed capability scoped to the `realtime` purpose and a short expiry.
Device daemons are Node processes and send a normal Bearer header.

## Device lifecycle

```text
zhunzou-device run
  → wss://hub/ws/device?env=home-mac
  → server: ready { role: "device", heartbeatMs }
  → client: hello { protocol, env, capabilities, stats }
  → server persists agents.capabilities / device_stats / transport = "ws"
  → dashboard receives device.updated
  → client: heartbeat { at, stats } every 30s
  → disconnect
  → server sets connected_at = NULL, online = false
  → dashboard receives device.offline
```

A newer connection for the same `env` closes the old socket with code `4001`.
A missing heartbeat closes the socket with code `4002` after
`REALTIME_HEARTBEAT_TIMEOUT_MS`.

## Frames

Client → server:

```json
{ "type": "hello", "protocol": 1, "env": "home-mac",
  "capabilities": { "os": "darwin", "arch": "arm64", "hostname": "macbook",
    "tools": [{ "name": "git", "version": "2.45.0" }],
    "features": ["ws", "heartbeat"] },
  "stats": { "cpuCount": 8, "load1": 1.2, "totalMemBytes": 17179869184 } }
```

```json
{ "type": "heartbeat", "at": 1730000000000,
  "stats": { "cpuCount": 8, "load1": 0.9 } }
```

```json
{ "type": "ping", "at": 1730000000000 }
```

Server → client:

- `ready` — handshake accepted; includes the heartbeat interval.
- `device.updated` — full `Agent` snapshot (dashboard only).
- `device.offline` — `{ env, at }` after a socket closes (dashboard only).
- `pong` — reply to `ping`.
- `error` — `{ code, message }` for malformed frames, protocol mismatch, etc.

All frames are JSON and capped at 64 KB. Unknown frame types are ignored by
clients so the protocol can add terminal frames without a version bump.

## Capability document

`packages/device/src/capabilities.ts` detects:

- OS / arch / hostname / kernel release / shell;
- CPU count, load average, total/free memory, uptime;
- local CLI inventory: `claude`, `cursor-agent`, `opencode`, `codex`, `gemini`,
  `aider`, `goose`, `amp`, `git`, `node`, `pnpm`, `npm`, `python3`, `docker`,
  `tmux`, `zsh`, `bash` (version probing is bounded to 1.5s per tool);
- PTY availability. `node-pty` is intentionally not installed in phase 1, so
  `pty.available` is `false` until the terminal runner lands.

## Security notes

- Remote terminals will be a high-risk surface. Keep device tokens scoped per
  `env`; rotate or revoke them from the 接入端 page.
- Use TLS (`wss://`) in production. The gateway does not bypass the existing
  bearer-token model.
- `REALTIME_HEARTBEAT_TIMEOUT_MS` bounds stale presence; the dashboard's HTTP
  long poll remains the source of truth.
- The gateway is in-process and single-instance by design, like the existing
  `EventEmitter` wakeups. Horizontal scaling needs sticky sessions + a shared
  pub/sub layer.

## Bridge claim sockets

Bridges can drop the HTTP long poll for claims by connecting to:

```text
GET /ws/bridge?env=<env>
Authorization: Bearer <scoped-agent-token>
```

The socket carries the same request-id frames used by devices:

| Client → hub | Hub → client |
| --- | --- |
| `task.claim { requestId, timeoutMs }` | `task.assigned { requestId, task, timedOut }` |
| `ticket.wait { requestId, ticketId, timeoutMs }` | `ticket.resolved { requestId, ticket, timedOut }` |
| `chat.claim { requestId, timeoutMs }` | `chat.assigned { requestId, session, message, timedOut }` |
| `task.complete` | `task.completed` |
| `task.log` | `ack` |
| `task.release` | `task.released` |
| `chat.event` | `ack` |
| `chat.complete` | `chat.completed` |

`zhunzou-bridge` uses `ZHUNZOU_TRANSPORT=auto` by default: it tries
`/ws/bridge`, and silently falls back to the existing
`/api/tasks/next`, `/api/tickets/:id/wait`, and `/api/sessions/next` long
polls. `http` disables the socket; `ws` prefers it but keeps the same fallback
for resilience.

## Dashboard realtime sync

`/ws/realtime` replaces the dashboard's fixed poll as the primary data plane:

```text
dashboard connects with a 60s ticket
  → server sends sync.snapshot { rev, state }
  → any DB change bumps the revision once per second
  → server broadcasts sync.changed { rev }
  → dashboard asks sync.request and receives a fresh snapshot
```

The existing `/api/sync` long poll remains enabled as a fallback. The web store
skips HTTP long polls while the socket is `online`, and resumes immediately
when it drops. `REALTIME_ENABLED=false` disables the socket and leaves the old
polling path untouched.

The same gateway carries device presence events (`device.updated`,
`device.offline`) and terminal frames.

## Interactive terminals

Phase 2 adds a PTY data plane on the same gateway:

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /ws/terminal?sessionId=&ticket=&afterSeq=` | Short-lived realtime ticket | Browser xterm viewer |
| `POST /api/terminals` | Admin | Spawn a shell on an online device |
| `GET /api/terminals` / `GET /api/terminals/:id` | Admin | Session metadata |
| `POST /api/terminals/:id/close` | Admin | Terminate the shell |
| `GET /api/terminals/:id/events?after=` | Admin | Bounded scrollback replay |

Server → device:

```json
{ "type": "pty.create", "sessionId": "7", "cols": 120, "rows": 30, "shell": "/bin/zsh", "cwd": "/repo" }
{ "type": "pty.attach", "sessionId": "7" }
{ "type": "pty.input", "sessionId": "7", "data": "ls\r" }
{ "type": "pty.resize", "sessionId": "7", "cols": 120, "rows": 40 }
{ "type": "pty.signal", "sessionId": "7", "signal": "SIGINT" }
{ "type": "pty.close", "sessionId": "7", "reason": "user closed" }
```

Device → server:

```json
{ "type": "pty.ready", "sessionId": "7", "pid": 1234, "shell": "/bin/zsh" }
{ "type": "pty.output", "sessionId": "7", "seq": 1, "data": "..." }
{ "type": "pty.exit", "sessionId": "7", "code": 0 }
{ "type": "pty.error", "sessionId": "7", "code": "PTY_UNAVAILABLE", "message": "..." }
```

Browser viewer frames are scoped to one session: `terminal.input`,
`terminal.resize`, `terminal.signal`, `terminal.close`, `terminal.detach`,
`terminal.claim`, `terminal.release` and `terminal.ping`. The hub answers with
`terminal.ready`, `terminal.control`, `terminal.updated`, `terminal.output`,
`terminal.exit`, `terminal.error` and `pong`.

### Lifecycle

```text
POST /api/terminals
  → repo row STARTING
  → pty.create to device
  → device spawns node-pty → pty.ready
  → session ACTIVE
  → pty.output (seq 1..N) → hub ring buffer + every viewer
  → browser closes / refreshes → replay chunks with seq > afterSeq
  → device WS drops → session DETACHED, viewers stay attached
  → device reconnects → pty.attach → same shell continues
  → pty.exit / close → CLOSED; no reconnect within TTL → LOST
```

### Limits

- `TERMINAL_MAX_SESSIONS` (global) and `TERMINAL_MAX_SESSIONS_PER_DEVICE`.
- `TERMINAL_MAX_VIEWERS` limits browser viewers per session.
- `TERMINAL_INPUT_BYTES_PER_SEC` rejects bursts with `RATE_LIMITED`.
- `TERMINAL_IDLE_TIMEOUT_MS` closes a shell with no input/output.
- `TERMINAL_DETACH_TTL_MS` bounds how long a detached shell is reserved.
- `TERMINAL_SCROLLBACK_BYTES` bounds the in-memory replay buffer.
- `TERMINAL_ALLOWED_ENVS` restricts which devices may open terminals.
- Each agent also has a `terminalEnabled` flag; disabling it from the 接入端 page
  returns `TERMINAL_FORBIDDEN` without affecting presence or task dispatch.
- Input frames are capped at 8 KB; output chunks are split at 16 KB.

Audit export is available at
`GET /api/terminals/:id/audit/export?format=csv` (or `jsonl`), capped at 5000
rows per download.

### Writer lease

A terminal has one input writer and any number of read-only viewers:

```text
first viewer attaches  → writer = viewer A
viewer B attaches      → terminal.ready { viewerId, writerId: A }
viewer B types         → terminal.error { code: "READ_ONLY" }
viewer B claims        → terminal.claim → terminal.control { writerId: B }
viewer B closes        → writer falls back to the next viewer (or null)
```

`terminal.ready` is sent per viewer and contains its own `viewerId` plus the
current `writerId`; `terminal.control` is broadcast whenever the lease changes.
Input, resize and signal frames are accepted only from the writer. Close is
allowed from any authenticated viewer.

### Audit trail

`terminal_audit` records `CREATE`, `INPUT`, `RESIZE`, `SIGNAL`, `CLAIM` and
`CLOSE` events with the session, env, viewer id and a bounded payload. Input is
flushed on newline or after 1 KB, so typing does not create one row per key.
Read it with `GET /api/terminals/:id/audit?after=<id>&limit=50`.

`GET /api/terminals/stats` returns active sessions, viewer count, created /
closed counters and total input/output bytes.

### node-pty

`node-pty` is an **optional dependency** of `@zhunzou/device`. The daemon still
runs presence/heartbeat without it, and `pty.create` returns
`PTY_UNAVAILABLE`. Install it with:

```bash
pnpm --filter @zhunzou/device add node-pty
```

On macOS/pnpm, the prebuilt `spawn-helper` sometimes loses its executable bit.
`packages/device/scripts/fix-pty-permissions.mjs` runs as a postinstall and
restores it; without that, node-pty fails with `posix_spawnp failed`.

## Next phase

Bridge claim sockets, dashboard snapshots, writer leases, audit export and
per-device terminal policy all ship. The remaining work is operational:
per-project policy rules, audit retention/export scheduling, terminal session
recording, and metrics dashboards.
