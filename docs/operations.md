# VibeCoding Companion — Operations Guide

This runbook explains how to start, verify, and troubleshoot the current Phase 1.5 system.

## 1. Start the Relay Hub

From Windows `cmd.exe`:

```cmd
cd /d E:\AI\vibe-companion\server
npm install
npm run dev
```

Expected output includes:

```text
[vibe-companion] Starting server...
Port:       4097
[vibe-companion] Ready at http://0.0.0.0:4097
[vibe-companion] WebSocket at ws://0.0.0.0:4097/ws
```

### Detached/background start

Useful when the relay should keep running while you use another terminal:

```cmd
cd /d E:\AI\vibe-companion\server
start /b cmd /c "npm run dev > relay-test.log 2>&1"
```

Check the log:

```cmd
type E:\AI\vibe-companion\server\relay-test.log
```

## 2. Verify the relay is reachable

Check port 4097:

```cmd
netstat -ano | findstr ":4097"
```

Check the web page:

```cmd
curl -I http://127.0.0.1:4097/
```

Check Phase 1.5 adapter registration:

```cmd
curl -s -X POST http://127.0.0.1:4097/api/register ^
  -H "Content-Type: application/json" ^
  -d "{\"sourceId\":\"manual-check\",\"tool\":\"diagnostic\",\"name\":\"Manual Check\"}"
```

Expected response:

```json
{"ok":true,"sourceId":"manual-check"}
```

## 3. Open the phone PWA

Find the PC LAN IP:

```cmd
ipconfig | findstr /i "IPv4"
```

Open on phone browser:

```text
http://<PC-LAN-IP>:4097/
```

If the phone cannot open the page:

1. Confirm phone and PC are on the same WiFi/LAN.
2. Confirm the PC firewall allows inbound TCP 4097.
3. Try `http://127.0.0.1:4097/` on the PC first.
4. Use the other IPv4 address if Windows shows more than one adapter.

## 4. OpenCode plugin setup

The plugin source lives at:

```text
E:\AI\vibe-companion\opencode-plugin\index.js
```

The copy that OpenCode currently loads lives at:

```text
E:\AI\.opencode\node_modules\vibe-companion-opencode-plugin\index.js
```

OpenCode config should contain:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "./node_modules/vibe-companion-opencode-plugin/index.js"
  ]
}
```

Config path:

```text
E:\AI\.opencode\opencode.json
```

When changing the plugin source, sync it to the installed copy:

```cmd
copy /Y "E:\AI\vibe-companion\opencode-plugin\index.js" "E:\AI\.opencode\node_modules\vibe-companion-opencode-plugin\index.js"
```

If `copy` fails because OpenCode is using the file, close OpenCode and run the command again.

## 5. Verify OpenCode loads the plugin

```cmd
cd /d E:\AI
opencode run "Say OK only." --print-logs 2>&1 | findstr /i "vibe-companion loading plugin failed"
```

Good sign:

```text
service=plugin path=file:///E:/AI/.opencode/node_modules/vibe-companion-opencode-plugin/index.js loading plugin
```

Bad sign:

```text
failed to load plugin
```

Known unrelated blocker observed in the current environment:

```text
ProviderModelNotFoundError: zhipuai-coding-plan/glm-4.6
```

That model error can stop `opencode run`, but it is not a plugin load failure if the plugin load line appears and no `failed to load plugin` line appears.

## 6. Manual event injection

Broadcast a log event to connected phones:

```cmd
curl -s -X POST http://127.0.0.1:4097/api/test ^
  -H "Content-Type: application/json" ^
  -d "{\"type\":\"log\",\"level\":\"info\",\"message\":\"manual test\",\"ts\":1760000000000}"
```

Broadcast a permission prompt through the adapter API:

```cmd
curl -s -X POST http://127.0.0.1:4097/api/register ^
  -H "Content-Type: application/json" ^
  -d "{\"sourceId\":\"manual-source\",\"tool\":\"manual\",\"name\":\"Manual Source\"}"

curl -s -X POST http://127.0.0.1:4097/api/event ^
  -H "Content-Type: application/json" ^
  -d "{\"type\":\"permission\",\"sourceId\":\"manual-source\",\"sessionId\":\"manual-session\",\"sessionID\":\"manual-session\",\"id\":\"manual-perm-1\",\"tool\":\"demo\",\"message\":\"Allow manual test?\"}"
```

After approving on the phone, poll replies:

```cmd
curl -s "http://127.0.0.1:4097/api/replies?sourceId=manual-source"
```

Expected shape:

```json
{"ok":true,"replies":[{"kind":"permission","sourceId":"manual-source","requestId":"manual-perm-1","reply":"once"}]}
```

## 7. Troubleshooting

### Page opens but status never updates

- Confirm OpenCode plugin is loaded.
- Confirm relay log shows `/api/register` or source registration messages.
- Test with `/api/test` to isolate PWA/WebSocket from OpenCode integration.

### Phone prompt appears but approval does not affect OpenCode

- Confirm the prompt message includes `sourceId`.
- Confirm the phone receives `reply_ack: accepted`.
- Confirm the plugin is polling `/api/replies` and not an old global OpenCode URL path.
- Restart OpenCode after syncing the plugin installed copy.

### Port already in use

Find the process:

```cmd
netstat -ano | findstr ":4097"
tasklist /FI "PID eq <PID>"
```

If it is an old relay, stop that terminal/process and restart from `server/`.

### Browser compatibility issue

The active frontend uses plain script modules in `app/js/app.js`. Target is Android 6+ / Chrome 53+. If an old browser shows a blank page, open the PC browser console or the on-page red error bar and check module support/runtime errors.

## 8. Validation commands before committing

```cmd
cd /d E:\AI\vibe-companion\server
npx tsc --noEmit
npm run build
```

Then check Git state:

```cmd
cd /d E:\AI\vibe-companion
git status --short
```
