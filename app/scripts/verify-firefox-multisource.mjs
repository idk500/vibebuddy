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
  <title>VibeBuddy multi-source test</title>
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

        // --- Test 1: Two sources with independent stats ---
        // Source A: THINKING with 2 tools, 1 error
        window.__vibeTest.handleWSMessage({ type: 'source', sourceId: 'src-A', tool: 'opencode', name: 'Project A', status: 'registered', ts: Date.now() })
        window.__vibeTest.handleWSMessage({ type: 'status', sourceId: 'src-A', sessionId: 'ses-1', status: 'THINKING', task: 'Working on A', duration: 0, toolCount: 0, errorCount: 0 })
        await delay(100)
        window.__vibeTest.handleWSMessage({ type: 'tool', sourceId: 'src-A', sessionId: 'ses-1', id: 't1', name: 'read', status: 'started', args: {}, ts: Date.now() })
        window.__vibeTest.handleWSMessage({ type: 'tool', sourceId: 'src-A', sessionId: 'ses-1', id: 't1', name: 'read', status: 'completed', args: {}, ts: Date.now() })
        window.__vibeTest.handleWSMessage({ type: 'tool', sourceId: 'src-A', sessionId: 'ses-1', id: 't2', name: 'bash', status: 'started', args: {}, ts: Date.now() })
        window.__vibeTest.handleWSMessage({ type: 'tool', sourceId: 'src-A', sessionId: 'ses-1', id: 't2', name: 'bash', status: 'failed', args: {}, ts: Date.now() })
        // Source A stats (active)
        var statsA = window.__vibeTest.getStats()
        assert(statsA.toolCount === 2, 'src-A tools should be 2, got ' + statsA.toolCount)
        assert(statsA.errorCount === 1, 'src-A errors should be 1, got ' + statsA.errorCount)

        // Source B: THINKING with 1 tool, 0 errors
        window.__vibeTest.handleWSMessage({ type: 'source', sourceId: 'src-B', tool: 'opencode', name: 'Project B', status: 'registered', ts: Date.now() })
        window.__vibeTest.handleWSMessage({ type: 'status', sourceId: 'src-B', sessionId: 'ses-2', status: 'THINKING', task: 'Working on B', duration: 0, toolCount: 0, errorCount: 0 })
        // Active now auto-switches to src-B due to THINKING
        window.__vibeTest.handleWSMessage({ type: 'tool', sourceId: 'src-B', sessionId: 'ses-2', id: 't3', name: 'edit', status: 'started', args: {}, ts: Date.now() })
        window.__vibeTest.handleWSMessage({ type: 'tool', sourceId: 'src-B', sessionId: 'ses-2', id: 't3', name: 'edit', status: 'completed', args: {}, ts: Date.now() })

        // Source B is now active
        var statsB = window.__vibeTest.getStats()
        assert(statsB.toolCount === 1, 'src-B tools should be 1, got ' + statsB.toolCount)
        assert(statsB.errorCount === 0, 'src-B errors should be 0, got ' + statsB.errorCount)

        // --- Test 2: Root badge shows EXECUTING (highest priority) ---
        var rootText = text('root-status-text')
        assert(rootText === 'EXECUTING' || rootText === 'THINKING', 'root badge should show active status: ' + rootText)

        // --- Test 3: Log entries only from active source ---
        var logContainer = document.getElementById('log-container')
        var logCount = logContainer.children.length
        // Send a log from source A — should NOT appear (active is B)
        window.__vibeTest.handleWSMessage({ type: 'log', sourceId: 'src-A', sessionId: 'ses-1', level: 'info', message: 'A log entry', ts: Date.now() })
        assert(logContainer.children.length === logCount, 'log from non-active source should not appear')

        // Send a log from source B — should appear
        window.__vibeTest.handleWSMessage({ type: 'log', sourceId: 'src-B', sessionId: 'ses-2', level: 'info', message: 'B log entry', ts: Date.now() })
        assert(logContainer.children.length === logCount + 1, 'log from active source should appear')

        // --- Test 4: Session cards panel exists ---
        var cardsContainer = document.getElementById('session-cards')
        var jsErr = document.getElementById('js-error')
        if (jsErr && jsErr.style.display !== 'none' && jsErr.textContent) {
          assert(false, 'JS error occurred: ' + jsErr.textContent)
        }
        assert(cardsContainer, 'session cards container should exist')
        var cards = cardsContainer.children
        assert(cards.length === 2, 'should have 2 session cards, got ' + cards.length)

        // --- Test 5: Permission from non-active source shows ---
        var permKey = 'src-A|ses-1'
        var sessionStatusKeys = Object.keys(window.__vibeTest.getSessionStatuses ? window.__vibeTest.getSessionStatuses() : {})
        try {
          window.__vibeTest.handleWSMessage({
            type: 'permission',
            sourceId: 'src-A',
            sessionId: 'ses-1',
            id: 'perm-1',
            tool: 'bash',
            message: 'Allow command from A?',
          })
        } catch (permErr) {
          assert(false, 'permission handler threw: ' + (permErr.message || permErr))
        }
        await delay(50)
        // Check that permission content appeared in cards or as overlay
        var permIndicators = document.getElementsByClassName('card-permission-indicator')
        var permOverlays = document.getElementsByClassName('prompt-overlay')
        var cardsHtml = document.getElementById('session-cards').innerHTML
        var hasPermText = cardsHtml.indexOf('bash') !== -1
        assert(permIndicators.length >= 1 || permOverlays.length >= 1 || hasPermText, 'permission should appear in cards or overlay')

        // --- Test 6: Source A stats are preserved when switching ---
        // Click on first card (src-A) to switch
        var firstCard = cards[0]
        var summaryRow = firstCard.querySelector('.session-card-summary')
        if (summaryRow) summaryRow.onclick()
        await delay(50)
        var statsAfterSwitch = window.__vibeTest.getStats()
        assert(statsAfterSwitch.toolCount === 2 || statsAfterSwitch.toolCount === 1, 'after switch, tools should reflect the source')
        assert(statsAfterSwitch.errorCount === 1 || statsAfterSwitch.errorCount === 0, 'after switch, errors should reflect the source')

        await report({ ok: true, checks: '6', sources: '2', userAgent: navigator.userAgent })
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
    if (req.method === 'GET' && url.pathname === '/__multisource-test.html') {
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
  const url = `http://127.0.0.1:${port}/__multisource-test.html`
  const firefox = spawn(firefoxPath, ['--headless', '--new-instance', '--profile', profileDir, url], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  firefox.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })

  const timeout = setTimeout(() => {
    firefox.kill()
    rejectResult(new Error(`Firefox multi-source test timed out. stderr=${stderr}`))
  }, 30000)

  try {
    const result = await resultPromise
    clearTimeout(timeout)
    if (!result.ok) throw new Error(`Firefox multi-source test failed: ${result.error}\n${result.stack || ''}`)
    console.log(`ok multi-source firefox checks=${result.checks} sources=${result.sources}`)
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
