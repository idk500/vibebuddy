import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
const firefoxCandidates = [
  process.env.FIREFOX_BIN,
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
].filter(Boolean)
const firefoxPath = firefoxCandidates.find((candidate) => fs.existsSync(candidate))

if (!firefoxPath) {
  throw new Error('Firefox executable not found. Set FIREFOX_BIN or install Firefox locally.')
}

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
  <title>Vibe stats Firefox integration test</title>
  <link rel="stylesheet" href="/css/main.css">
</head>
<body>
  <div id="js-error"></div>
  <div id="connect-screen" class="screen active"></div>
  <div id="andon-screen" class="screen"></div>
  <section id="session-panel">
    <div id="root-badge" data-status="IDLE">
      <span id="root-status-icon" class="root-status-icon">●</span>
      <span id="root-status-text" class="root-status-text">IDLE</span>
      <span id="root-session-count" class="root-session-count">0 sessions</span>
    </div>
    <div id="session-cards" class="session-cards"></div>
  </section>
  <div id="log-container"></div>
  <input id="server-url" value="127.0.0.1:0">
  <button id="connect-btn"></button>
  <div id="connect-status"></div>
  <div id="connection-dot"></div>
  <div id="session-label"></div>
  <div id="clock"></div>
  <button id="disconnect-btn"></button>
  <button id="fullscreen-btn"></button>
  <script>
    window.__VIBE_TEST_MODE__ = true
    window.localStorage.clear()
    window.WebSocket = function WebSocketStub(url) {
      this.url = url
      this.readyState = WebSocketStub.OPEN
      setTimeout(() => { if (this.onopen) this.onopen() }, 0)
    }
    window.WebSocket.OPEN = 1
    window.WebSocket.CONNECTING = 0
    window.WebSocket.prototype.send = function () {}
    window.WebSocket.prototype.close = function () { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000, reason: 'test close' }) }
  </script>
  <script src="/js/legacy-app.js"></script>
  <script>
    function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
    function text(id) { return document.getElementById(id).textContent }
    function assert(condition, message) { if (!condition) throw new Error(message) }
    async function report(body) {
      await fetch('/__test-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    ;(async function () {
      try {
        await delay(50)
        assert(window.__vibeTest, 'test harness was not exposed')
        window.__vibeTest.handleWSStateChange('CONNECTED')
        window.__vibeTest.handleWSMessage({ type: 'status', sourceId: 'firefox-stats', sessionId: 's1', status: 'THINKING', task: 'Firefox stats test', duration: 0, toolCount: 0, errorCount: 0 })
        await delay(1150)
        window.__vibeTest.renderStatsTick()
        var stats = window.__vibeTest.getStats()
        assert(stats.elapsed > 0, 'duration did not advance in Firefox: ' + stats.elapsed)

        window.__vibeTest.handleWSMessage({ type: 'tool', sourceId: 'firefox-stats', sessionId: 's1', id: 'tool-1', name: 'bash', status: 'started', args: {}, ts: Date.now() })
        stats = window.__vibeTest.getStats()
        assert(stats.toolCount === 1, 'tool start not counted: ' + stats.toolCount)
        window.__vibeTest.handleWSMessage({ type: 'tool', sourceId: 'firefox-stats', sessionId: 's1', id: 'tool-1', name: 'bash', status: 'completed', args: {}, ts: Date.now() })
        stats = window.__vibeTest.getStats()
        assert(stats.toolCount === 1, 'tool completed double-counted: ' + stats.toolCount)
        window.__vibeTest.handleWSMessage({ type: 'tool', sourceId: 'firefox-stats', sessionId: 's1', id: 'tool-1', name: 'bash', status: 'failed', args: {}, ts: Date.now() })
        stats = window.__vibeTest.getStats()
        assert(stats.toolCount === 1, 'duplicate failed double-counted tool: ' + stats.toolCount)
        assert(stats.errorCount === 1, 'tool failed not counted as one error: ' + stats.errorCount)
        window.__vibeTest.handleWSMessage({ type: 'log', sourceId: 'firefox-stats', sessionId: 's1', level: 'error', message: 'Tool bash failed', ts: Date.now() })
        stats = window.__vibeTest.getStats()
        assert(stats.errorCount === 1, 'tool failure log double-counted: ' + stats.errorCount)
        window.__vibeTest.handleWSMessage({ type: 'log', sourceId: 'firefox-stats', sessionId: 's1', level: 'error', message: 'plain error', ts: Date.now() })
        stats = window.__vibeTest.getStats()
        assert(stats.errorCount === 2, 'plain error not counted: ' + stats.errorCount)

        window.__vibeTest.handleWSMessage({ type: 'status', sourceId: 'firefox-stats', sessionId: 's1', status: 'IDLE', task: 'Done', duration: 0, toolCount: 0, errorCount: 0 })
        var frozen = window.__vibeTest.getStats().elapsed
        await delay(1100)
        window.__vibeTest.renderStatsTick()
        stats = window.__vibeTest.getStats()
        assert(stats.elapsed === frozen, 'duration did not freeze after IDLE: ' + stats.elapsed + ' !== ' + frozen)
        await report({ ok: true, tools: stats.toolCount, errors: stats.errorCount, duration: stats.elapsed, userAgent: navigator.userAgent })
      } catch (err) {
        await report({ ok: false, error: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : '' })
      }
    })()
  </script>
</body>
</html>`
}

async function main() {
  let resolveResult
  let rejectResult
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

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
    if (req.method === 'GET' && url.pathname === '/__stats-test.html') {
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
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-firefox-profile-'))
  const url = `http://127.0.0.1:${port}/__stats-test.html`
  const firefox = spawn(firefoxPath, ['--headless', '--new-instance', '--profile', profileDir, url], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  firefox.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })

  const timeout = setTimeout(() => {
    firefox.kill()
    rejectResult(new Error(`Firefox stats test timed out. stderr=${stderr}`))
  }, 30000)

  try {
    const result = await resultPromise
    clearTimeout(timeout)
    if (!result.ok) throw new Error(`Firefox stats test failed: ${result.error}\n${result.stack || ''}`)
    console.log(`ok firefox tools=${result.tools} errors=${result.errors} duration=${result.duration}`)
    console.log(result.userAgent)
  } finally {
    clearTimeout(timeout)
    firefox.kill()
    server.close()
    await new Promise(resolve => setTimeout(resolve, 500))
    try {
      fs.rmSync(profileDir, { recursive: true, force: true })
    } catch (err) {
      console.warn(`warning: could not remove temporary Firefox profile ${profileDir}: ${err.message}`)
    }
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
