import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
const relayHost = process.env.VIBE_RELAY_HOST || '127.0.0.1:4097'
const sourceId = `firefox-relay-prompt-${process.pid}`
const sessionId = `relay-prompt-${Date.now()}`
const requestId = `per-${process.pid}-${Date.now()}`
const firefoxCandidates = [
  process.env.FIREFOX_BIN,
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
].filter(Boolean)
const firefoxPath = firefoxCandidates.find((candidate) => fs.existsSync(candidate))
if (!firefoxPath) throw new Error('Firefox executable not found. Set FIREFOX_BIN or install Firefox locally.')

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.html') return 'text/html; charset=utf-8'
  if (ext === '.js') return 'application/javascript; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.json' || ext === '.webmanifest') return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${url} failed: ${res.status} ${await res.text()}`)
  return await res.json()
}

async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} failed: ${res.status} ${await res.text()}`)
  return await res.json()
}

function testPage() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Relay Prompt Firefox E2E</title>
  <link rel="stylesheet" href="/css/main.css">
</head>
<body>
  <div id="js-error"></div>
  <div id="connect-screen" class="screen active"></div>
  <div id="andon-screen" class="screen"></div>
  <section id="andon-panel" data-status="DISCONNECTED">
    <div id="andon-status-text">DISCONNECTED</div>
    <div id="andon-task">等待连接...</div>
    <div id="stat-tools">0</div>
    <div id="stat-errors">0</div>
    <div id="stat-duration">00:00</div>
  </section>
  <div id="log-container"></div>
  <input id="server-url" value="${relayHost}">
  <button id="connect-btn"></button>
  <div id="connect-status"></div>
  <div id="connection-dot"></div>
  <div id="session-label"></div>
  <div id="clock"></div>
  <button id="disconnect-btn"></button>
  <button id="fullscreen-btn"></button>
  <script>
    window.__VIBE_TEST_MODE__ = true
    window.__VIBE_TEST_SERVER_HOST__ = '${relayHost}'
    window.__messages = []
    window.__acks = []
    window.__VIBE_TEST_ON_MESSAGE__ = function (msg) {
      window.__messages.push(msg)
      if (msg && msg.type === 'reply_ack') window.__acks.push(msg)
    }
  </script>
  <script src="/js/legacy-app.js"></script>
  <script>
    function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
    async function ready() {
      await fetch('/__ready', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) })
    }
    async function report(body) {
      await fetch('/__test-result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    }
    ;(async function () {
      try {
        while (!window.__vibeTest || document.getElementById('connect-status').textContent !== '已连接!') await delay(100)
        await ready()
        var deadline = Date.now() + 60000
        var sawPermission = false
        var ackAccepted = false
        while (Date.now() < deadline) {
          var messages = window.__messages
          for (var i = 0; i < messages.length; i++) {
            var msg = messages[i]
            if (msg && msg.type === 'permission' && msg.id === '${requestId}' && msg.sourceId === '${sourceId}') {
              sawPermission = true
              var buttons = document.getElementsByTagName('button')
              for (var b = 0; b < buttons.length; b++) {
                if (buttons[b].textContent === 'Allow Once') {
                  buttons[b].click()
                  break
                }
              }
            }
          }
          var acks = window.__acks
          for (var j = 0; j < acks.length; j++) {
            if (acks[j].requestId === '${requestId}' && acks[j].sourceId === '${sourceId}' && acks[j].status === 'accepted') ackAccepted = true
          }
          if (sawPermission && ackAccepted) break
          await delay(100)
        }
        if (!sawPermission) throw new Error('Firefox did not receive relay permission prompt ${requestId}')
        if (!ackAccepted) throw new Error('Firefox did not receive accepted reply_ack for ${requestId}')
        await report({ ok: true, sawPermission: sawPermission, ackAccepted: ackAccepted, messages: window.__messages.length, userAgent: navigator.userAgent })
      } catch (err) {
        await report({ ok: false, error: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : '', messages: window.__messages.length })
      }
    })()
  </script>
</body>
</html>`
}

async function main() {
  await postJson(`http://${relayHost}/api/register`, { sourceId, tool: 'test-adapter', name: 'Firefox Relay Prompt E2E', capabilities: ['permission.ask'] })

  let resolveResult
  let rejectResult
  let resolveReady
  let rejectReady
  const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const resultPromise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/__ready') {
      req.resume()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      resolveReady()
      return
    }
    if (req.method === 'POST' && url.pathname === '/__test-result') {
      let body = ''
      req.on('data', chunk => { body += chunk.toString('utf8') })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
          resolveResult(parsed)
        } catch (err) {
          rejectResult(err)
        }
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/__relay-prompt-e2e.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(testPage())
      return
    }
    const rawPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const filePath = path.resolve(appRoot, `.${rawPath}`)
    if (!filePath.startsWith(appRoot) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }
    res.writeHead(200, { 'Content-Type': contentType(filePath) })
    fs.createReadStream(filePath).pipe(res)
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-firefox-relay-prompt-'))
  const firefox = spawn(firefoxPath, ['--headless', '--new-instance', '--profile', profileDir, `http://127.0.0.1:${port}/__relay-prompt-e2e.html`], { stdio: ['ignore', 'pipe', 'pipe'] })

  const timeout = setTimeout(() => {
    firefox.kill()
    rejectReady(new Error('Timed out waiting for Firefox relay prompt E2E readiness'))
    rejectResult(new Error('Timed out waiting for Firefox relay prompt E2E'))
  }, 90000)

  try {
    await readyPromise
    await postJson(`http://${relayHost}/api/event`, {
      type: 'permission',
      sourceId,
      sessionId,
      sessionID: sessionId,
      id: requestId,
      tool: 'bash',
      message: 'Allow relay prompt E2E command?',
      patterns: ['echo relay-prompt-e2e'],
    })

    const result = await resultPromise
    clearTimeout(timeout)
    if (!result.ok) throw new Error(`Firefox relay prompt E2E failed: ${result.error}\n${result.stack || ''}`)

    const replies = await getJson(`http://${relayHost}/api/replies?sourceId=${encodeURIComponent(sourceId)}`)
    const reply = Array.isArray(replies.replies) ? replies.replies.find(item => item.requestId === requestId) : null
    if (!reply) throw new Error(`No reply queued for ${requestId}: ${JSON.stringify(replies)}`)
    if (reply.kind !== 'permission' || reply.reply !== 'once') throw new Error(`Unexpected reply: ${JSON.stringify(reply)}`)
    if (reply.sessionId !== sessionId) throw new Error(`Unexpected reply sessionId: ${JSON.stringify(reply)}`)

    console.log(`ok relay-prompt firefox request=${requestId} reply=${reply.reply} messages=${result.messages}`)
    console.log(result.userAgent)
  } finally {
    clearTimeout(timeout)
    firefox.kill()
    server.close()
    await new Promise(resolve => setTimeout(resolve, 500))
    try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch {}
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
