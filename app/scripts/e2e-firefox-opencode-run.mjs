import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
const relayHost = process.env.VIBE_RELAY_HOST || '127.0.0.1:4097'
const opencodeModel = process.env.OPENCODE_E2E_MODEL || 'zhipuai-coding-plan/glm-4.6v'
const opencodeDir = process.env.OPENCODE_E2E_DIR || path.resolve(appRoot, '..')
const prompt = process.env.OPENCODE_E2E_PROMPT || 'Reply with exactly: VIBE_FIREFOX_REAL_OPENCODE_E2E_OK'
const expectedText = 'VIBE_FIREFOX_REAL_OPENCODE_E2E_OK'
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

function testPage() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Real OpenCode Firefox E2E</title>
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
    window.__opencodeMessages = []
    window.__VIBE_TEST_ON_MESSAGE__ = function (msg) {
      window.__opencodeMessages.push(msg)
    }
  </script>
  <script src="/js/legacy-app.js"></script>
  <script>
    function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
    function text(id) { return document.getElementById(id).textContent }
    async function report(body) {
      await fetch('/__test-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    ;(async function () {
      try {
        var deadline = Date.now() + 90000
        var sawOpenCode = false
        var sawActive = false
        var sawIdle = false
        var sessionId = ''
        while (Date.now() < deadline) {
          var messages = window.__opencodeMessages
          for (var i = 0; i < messages.length; i++) {
            var msg = messages[i]
            if (msg && msg.sourceId && String(msg.sourceId).indexOf('opencode:') === 0) {
              sawOpenCode = true
              if (msg.sessionId) sessionId = msg.sessionId
              if (msg.type === 'status' && (msg.status === 'THINKING' || msg.status === 'EXECUTING')) sawActive = true
              if (msg.type === 'status' && msg.status === 'IDLE' && sawActive) sawIdle = true
            }
          }
          if (sawOpenCode && sawActive && sawIdle) break
          await delay(250)
        }
        if (!sawOpenCode) throw new Error('Firefox did not receive any real OpenCode-sourced WebSocket message')
        if (!sawActive) throw new Error('Firefox did not receive THINKING/EXECUTING from real OpenCode')
        if (!sawIdle) throw new Error('Firefox did not receive IDLE after real OpenCode activity')
        await report({
          ok: true,
          status: text('andon-status-text'),
          task: text('andon-task'),
          tools: text('stat-tools'),
          errors: text('stat-errors'),
          duration: text('stat-duration'),
          sessionId: sessionId,
          messages: window.__opencodeMessages.length,
          userAgent: navigator.userAgent,
        })
      } catch (err) {
        await report({ ok: false, error: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : '', messages: window.__opencodeMessages.length })
      }
    })()
  </script>
</body>
</html>`
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${url} failed: ${res.status} ${await res.text()}`)
  return await res.json()
}

async function main() {
  await postJson(`http://${relayHost}/api/event`, {
    type: 'status', sourceId: 'e2e-reset', sessionId: 'reset', status: 'IDLE', task: 'Reset before real OpenCode E2E', duration: 0, toolCount: 0, errorCount: 0,
  })

  let resolveResult
  let rejectResult
  const resultPromise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
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
    if (req.method === 'GET' && url.pathname === '/__real-opencode-e2e.html') {
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
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-firefox-real-opencode-'))
  const firefox = spawn(firefoxPath, ['--headless', '--new-instance', '--profile', profileDir, `http://127.0.0.1:${port}/__real-opencode-e2e.html`], { stdio: ['ignore', 'pipe', 'pipe'] })
  const oc = spawn('opencode.cmd', ['run', '--dir', opencodeDir, '--model', opencodeModel, '--format', 'json', prompt], { stdio: ['ignore', 'pipe', 'pipe'], shell: true })
  let ocStdout = ''
  let ocStderr = ''
  oc.stdout.on('data', chunk => { ocStdout += chunk.toString('utf8') })
  oc.stderr.on('data', chunk => { ocStderr += chunk.toString('utf8') })
  const ocExit = new Promise(resolve => oc.on('exit', code => resolve(code)))

  const timeout = setTimeout(() => {
    firefox.kill()
    oc.kill()
    rejectResult(new Error('Timed out waiting for Firefox to observe real OpenCode activity'))
  }, 120000)

  try {
    const [result, exitCode] = await Promise.all([resultPromise, ocExit])
    clearTimeout(timeout)
    if (exitCode !== 0) throw new Error(`opencode run failed with code ${exitCode}\nstdout=${ocStdout}\nstderr=${ocStderr}`)
    if (!ocStdout.includes(expectedText)) throw new Error(`opencode output did not contain ${expectedText}\nstdout=${ocStdout}`)
    if (!result.ok) throw new Error(`Firefox real OpenCode E2E failed: ${result.error}\n${result.stack || ''}`)
    console.log(`ok real-opencode firefox status=${result.status} tools=${result.tools} errors=${result.errors} duration=${result.duration} messages=${result.messages} session=${result.sessionId}`)
    console.log(result.userAgent)
  } finally {
    clearTimeout(timeout)
    firefox.kill()
    oc.kill()
    server.close()
    await new Promise(resolve => setTimeout(resolve, 500))
    try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch {}
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
