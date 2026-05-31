# VibeCoding Companion — Phase 1.5 Acceptance Record

Date: 2026-05-31

Scope: Multi-source Relay Hub + reliable remote approvals.

## 1. Acceptance criteria

From `docs/plan.md` Phase 1.5:

| ID | Criterion | Result |
|----|-----------|--------|
| AC1 | Two mock sources cannot cross-route replies | Passed |
| AC2 | Missing/wrong source or request returns `failed`/`expired` ACK | Passed for missing request `failed`; expired path implemented |
| AC3 | PWA prompt shows source/session/request and ACK feedback | Implemented |
| AC4 | OpenCode plugin registers source and `permission.ask` maps phone reply to hook output | Implemented; plugin load verified; full live LLM run blocked by unrelated model config |
| AC5 | `npx tsc --noEmit` passes | Passed |

## 2. Implemented artifacts

Documentation:

- `docs/requirements.md`
- `docs/architecture.md`
- `docs/plan.md`
- `docs/protocol.md`
- `docs/operations.md`

Relay server:

- `server/src/index.ts`
- `server/src/types.ts`

OpenCode plugin:

- `opencode-plugin/index.js`
- installed copy: `E:\AI\.opencode\node_modules\vibe-companion-opencode-plugin\index.js`

PWA:

- `app/js/app.js`
- `app/css/main.css`

## 3. Validation commands and evidence

### 3.1 Server typecheck

Command:

```cmd
cd /d E:\AI\vibe-companion\server
npx tsc --noEmit
```

Result:

```text
passed with no output
```

### 3.2 Server build

Command:

```cmd
cd /d E:\AI\vibe-companion\server
npm run build
```

Result:

```text
> vibe-companion-server@0.1.0 build
> tsc
```

### 3.3 Automated mock closed-loop test

A temporary script `server\tmp-phase15-e2e.cjs` was created and removed after validation.

Test setup:

1. Start built relay on isolated port `4197`.
2. Open a WebSocket client as a mock phone.
3. Register two sources:
   - `mock:A`
   - `mock:B`
4. Send one permission request from each source.
5. Send a phone `permission_reply` only for `mock:A`.
6. Poll `/api/replies` for both sources.
7. Verify:
   - `mock:A` receives exactly the reply for `perm-A`.
   - `mock:B` receives no reply.
   - WebSocket receives `reply_ack` with `status: accepted`.
8. Send reply for a missing request.
9. Verify WebSocket receives `reply_ack` with `status: failed`.

Observed output:

```text
[server] [vibe-companion] Starting server...
[server]   Port:       4197
[server] [vibe-companion] Ready at http://0.0.0.0:4197
[server] [ws] Client connected: 127.0.0.1
[hub] source registered: mock:A (mock)
[hub] source registered: mock:B (mock)
[ws] Received: permission_reply
[ws] Received: permission_reply
[test] phase 1.5 closed-loop routing passed
```

Result: passed.

### 3.4 OpenCode plugin load check

Command:

```cmd
cd /d E:\AI
opencode run "Say OK only." --print-logs 2>&1 | findstr /i "vibe-companion loading plugin failed source registered Plugin loaded"
```

Observed plugin load line:

```text
service=plugin path=file:///E:/AI/.opencode/node_modules/vibe-companion-opencode-plugin/index.js loading plugin
```

No `failed to load plugin` line was observed.

Known unrelated blocker:

```text
ProviderModelNotFoundError: zhipuai-coding-plan/glm-4.6
suggestions: ["glm-4.6v"]
```

Assessment: plugin load path is valid; full OpenCode LLM execution is blocked by model configuration, not by VibeCoding Companion.

## 4. Current behavior

### Relay Hub

- Stores sources in memory.
- Creates pending request entries for source-bound `permission` and `question` events.
- Accepts phone replies only when `sourceId + requestID` matches a pending request.
- Queues replies under the exact `sourceId`.
- Broadcasts `reply_ack` to connected PWA clients.

### PWA

- Shows prompt metadata:
  - source
  - session
  - request
- Sends replies with:
  - `ackId`
  - `sourceId`
  - `sessionId`
  - `requestID`
- Displays ACK result and logs reply status.

### OpenCode plugin

- Registers a source with the Relay Hub on load.
- Sends mapped events to `/api/event`.
- Implements `permission.ask` by:
  1. Sending a source-bound permission event.
  2. Polling `/api/replies` for its own `sourceId`.
  3. Mapping `once`/`always` to `output.status = "allow"`.
  4. Mapping `reject` or timeout to `output.status = "deny"`.

## 5. Limitations and follow-up

- Relay state is in memory and does not survive restart.
- OpenCode question synchronous resolution is not proven because a direct `question.ask` hook was not confirmed.
- Token/pairing authentication is not enabled by default.
- Full OpenCode live approval test should be repeated after fixing the local OpenCode model config.
- Phase 2 voice relay remains pending.
