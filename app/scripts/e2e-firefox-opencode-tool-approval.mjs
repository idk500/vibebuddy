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
const expectedText = 'VIBE_FORCE_TOOL_APPROVAL_E2E_OK'
const prompt = process.env.OPENCODE_APPROVAL_E2E_PROMPT || `Run this shell command exactly and report its output: echo ${expectedText}`
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
  <title>Real OpenCode Forced Tool Approval E2E</title>
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
    function text(id) { return document.getElementById(id).textContent }
    async function ready() {
      await fetch('/__ready', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) })
    }
    async function report(body) {
      await fetch('/__test-result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    }
    function clickAllowOnce() {
      var buttons = document.getElementsByTagName('button')
      for (var i = buttons.length - 1; i >= 0; i--) {
        if (buttons[i].textContent === 'Allow Once' && !buttons[i].disabled) {
          buttons[i].click()
          return true
        }
      }
      return false
    }
    ;(async function () {
      try {
        while (!window.__vibeTest || document.getElementById('connect-status').textContent !== '已连接!') await delay(100)
        await ready()
        var deadline = Date.now() + 120000
        var permissionId = ''
        var sourceId = ''
        var sawTool = false
        var clicked = false
        var ackAccepted = false
        while (Date.now() < deadline) {
          for (var i = 0; i < window.__messages.length; i++) {
            var msg = window.__messages[i]
            if (!msg || !msg.sourceId || String(msg.sourceId).indexOf('opencode:') !== 0) continue
            if (msg.type === 'permission' && !permissionId) {
              permissionId = msg.id || ''
              sourceId = msg.sourceId || ''
            }
            if (msg.type === 'tool') sawTool = true
          }
          if (permissionId && !clicked) clicked = clickAllowOnce()
          for (var j = 0; j < window.__acks.length; j++) {
            var ack = window.__acks[j]
            if (ack.requestId === permissionId && ack.sourceId === sourceId && ack.status === 'accepted') ackAccepted = true
          }
          if (permissionId && clicked && ackAccepted && sawTool && Number(text('stat-tools')) >= 1) break
          await delay(150)
        }
        if (!permissionId) throw new Error('Firefox did not receive forced OpenCode tool approval prompt')
        if (!clicked) throw new Error('Firefox did not click Allow Once for forced tool approval')
        if (!ackAccepted) throw new Error('Firefox did not receive accepted ACK for forced tool approval')
        if (!sawTool) throw new Error('Firefox did not receive tool event after forced approval')
        if (Number(text('stat-tools')) < 1) throw new Error('Tools did not increment after approved OpenCode tool: ' + text('stat-tools'))
        await report({ ok: true, permissionId: permissionId, sourceId: sourceId, tools: text('stat-tools'), errors: text('stat-errors'), duration: text('stat-duration'), messages: window.__messages.length, userAgent: navigator.userAgent })
      } catch (err) {
        await report({ ok: false, error: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : '', messages: window.__messages.length, acks: window.__acks.length })
      }
    })()
  </script>
</body>
</html>`
}

async function main() {
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
    if (req.method === 'GET' && url.pathname === '/__force-tool-approval-e2e.html') {
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
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-firefox-force-tool-'))
  const firefox = spawn(firefoxPath, ['--headless', '--new-instance', '--profile', profileDir, `http://127.0.0.1:${port}/__force-tool-approval-e2e.html`], { stdio: ['ignore', 'pipe', 'pipe'] })
  const timeout = setTimeout(() => {
    firefox.kill()
    rejectReady(new Error('Timed out waiting for forced tool approval Firefox readiness'))
    rejectResult(new Error('Timed out waiting for forced tool approval E2E'))
  }, 180000)

  try {
    await readyPromise
    const oc = spawn('opencode.cmd', ['run', '--dir', opencodeDir, '--model', opencodeModel, '--format', 'json', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env, VIBE_FORCE_TOOL_APPROVAL: '1' },
    })
    let ocStdout = ''
    let ocStderr = ''
    oc.stdout.on('data', chunk => { ocStdout += chunk.toString('utf8') })
    oc.stderr.on('data', chunk => { ocStderr += chunk.toString('utf8') })
    const ocExit = new Promise(resolve => oc.on('exit', code => resolve(code)))

    const [result, exitCode] = await Promise.all([resultPromise, ocExit])
    clearTimeout(timeout)
    if (!result.ok) throw new Error(`Firefox forced tool approval E2E failed: ${result.error}\n${result.stack || ''}\nopencode stdout=${ocStdout}\nopencode stderr=${ocStderr}`)
    if (exitCode !== 0) throw new Error(`opencode run failed with code ${exitCode}\nstdout=${ocStdout}\nstderr=${ocStderr}`)
    if (!ocStdout.includes(expectedText)) throw new Error(`opencode output did not contain ${expectedText}\nstdout=${ocStdout}`)
    console.log(`ok force-tool-approval firefox permission=${result.permissionId} tools=${result.tools} errors=${result.errors} duration=${result.duration} messages=${result.messages}`)
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
