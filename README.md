# VibeCoding Companion

VibeCoding Companion turns an old Android phone into a web-first companion terminal for PC AI coding tools.

Current Phase 1.5 scope:

- Andon-style status display for AI coding sessions.
- Remote prompt and permission confirmation from a phone/PWA.
- Multi-source Relay Hub protocol for OpenCode now and Claude Code/Kilo/ZCode later.
- OpenCode plugin path for real TUI events and `permission.ask` approval loop.

Target devices:

- Minimum: Android 6+ / Chrome 53+.
- Layout: landscape-first.
- Frontend: plain HTML/CSS/JS, no build step.
- Server: Node.js + TypeScript + `ws`.

## Quick start

### 1. Start the PC relay

```cmd
cd /d E:\AI\vibe-companion\server
npm install
npm run dev
```

Default relay URL:

```text
http://127.0.0.1:4097/
```

Phone URL on the same WiFi, for example:

```text
http://<PC-LAN-IP>:4097/
```

Find your LAN IP on Windows:

```cmd
ipconfig | findstr /i "IPv4"
```

### 2. Open the PWA on the phone

Open the relay URL in the phone browser. If the page is served by the relay it auto-connects to the current host. Otherwise enter `PC-IP:4097` manually.

### 3. Use with OpenCode

The OpenCode plugin should be installed under:

```text
E:\AI\.opencode\node_modules\vibe-companion-opencode-plugin\index.js
```

And configured from `E:\AI\.opencode\opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "./node_modules/vibe-companion-opencode-plugin/index.js"
  ]
}
```

When OpenCode loads the plugin, the plugin registers a source with the relay and forwards events to the phone UI. For OpenCode `permission.ask`, the plugin waits for the phone reply and then sets the original hook output to `allow` or `deny`.

## Architecture

```text
Android Phone / PWA
  - Andon UI
  - Prompt UI
  - ACK feedback
        ⇅ WebSocket
PC Relay Hub :4097
  - source registry
  - pending request registry
  - per-source reply queues
  - reply ACK broadcast
        ⇅ HTTP Adapter API
Adapters / tools
  - OpenCode plugin
  - future Claude Code adapter
  - future Kilo adapter
  - future ZCode adapter
```

Important identifiers:

| Name | Meaning |
|------|---------|
| `sourceId` | One adapter/tool instance, e.g. one OpenCode plugin process |
| `sessionId` | One tool session/conversation/task |
| `requestId` | One permission/question request |
| `ackId` | One phone reply acknowledgement correlation ID |

Remote approval flow:

```text
OpenCode permission.ask
  → plugin POST /api/event permission
  → Relay Hub stores pending request and broadcasts to PWA
  → user taps Allow/Reject on phone
  → PWA sends WS permission_reply with sourceId/sessionId/requestID/ackId
  → Relay Hub queues reply for the same source and broadcasts reply_ack
  → plugin polls /api/replies and resolves permission.ask
```

## Project layout

```text
vibe-companion/
├── README.md
├── AGENTS.md
├── app/                     # Phone PWA, no build step
│   ├── index.html
│   ├── css/main.css
│   └── js/*.js
├── docs/
│   ├── requirements.md      # SYS.1/SYS.2 requirements
│   ├── architecture.md      # SYS.3/SWE.2 architecture
│   ├── plan.md              # phase plan
│   ├── operations.md        # runbook and troubleshooting
│   ├── protocol.md          # Relay Hub adapter protocol
│   └── acceptance-phase-1.5.md
├── opencode-plugin/         # OpenCode adapter plugin source
└── server/                  # PC Relay Hub
    ├── src/index.ts
    ├── src/types.ts
    └── package.json
```

## Common commands

```cmd
cd /d E:\AI\vibe-companion\server

npm run dev          # run relay in watch mode
npm run build        # compile TypeScript to dist/
npm run typecheck    # TypeScript check without output
npm run lint         # ESLint server sources
```

Git baseline:

```cmd
cd /d E:\AI\vibe-companion
git log --oneline -3
git status --short
```

## Documentation map

- `docs/requirements.md` — product/system requirements.
- `docs/architecture.md` — architecture and major design decisions.
- `docs/plan.md` — phase plan and acceptance criteria.
- `docs/protocol.md` — Relay Hub HTTP/WebSocket protocol.
- `docs/operations.md` — how to start, verify, install, and troubleshoot.
- `docs/acceptance-phase-1.5.md` — validation evidence for current closed-loop implementation.

## Current known limitations

- Phase 2 voice input is planned but not implemented as a complete relay path.
- OpenCode `question.asked` is source-bound and ACKed at the relay/UI level, but true synchronous resolution depends on OpenCode exposing an appropriate hook/API.
- No authentication is enabled by default; use only on trusted LAN until token pairing is added.
- Relay state is in memory and resets on restart.
