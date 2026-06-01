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
const firefoxCandidates = [
  process.env.FIREFOX_BIN,
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
].filter(Boolean)
const firefoxPath = firefoxCandidates.find((candidate) => fs.existsSync(candidate))
if (!firefoxPath) throw new Error('Firefox executable not found. Set FIREFOX_BIN or install Firefox locally.')

const scenarios = [
  { key: 'permission-allow', type: 'permission', requestId: `per-allow-${process.pid}-${Date.now()}`, buttonText: 'Allow Once', expect: { kind: 'permission', reply: 'once' } },
  { key: 'permission-reject', type: 'permission', requestId: `per-reject-${process.pid}-${Date.now()}`, buttonText: 'Reject', expect: { kind: 'permission', reply: 'reject' } },
  { key: 'question-answer', type: 'question', requestId: `que-answer-${process.pid}-${Date.now()}`, buttonText: 'Yes', expect: { kind: 'question', answers: [['Yes']] } },
  { key: 'question-skip', type: 'question', requestId: `que-skip-${process.pid}-${Date.now()}`, buttonText: 'Skip', expect: { kind: 'question', answers: [] } },
]
const wrongRequestId = `missing-${process.pid}-${Date.now()}`

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

function eventForScenario(scenario) {
  if (scenario.type === 'permission') {
    return {
      type: 'permission',
      sourceId,
      sessionId,
      sessionID: sessionId,
      id: scenario.requestId,
      tool: 'bash',
      message: `Allow relay prompt E2E command for ${scenario.key}?`,
      patterns: [`echo ${scenario.key}`],
    }
  }
  return {
    type: 'question',
    sourceId,
    sessionId,
    sessionID: sessionId,
    id: scenario.requestId,
    questions: [{
      header: `Question ${scenario.key}`,
      question: `Choose an option for ${scenario.key}`,
      options: [
        { label: 'Yes', description: 'Approve this scenario' },
        { label: 'No', description: 'Do not approve this scenario' },
      ],
    }],
  }
}

function testPage() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Relay Prompt Firefox E2E Matrix</title>
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
    window.__scenarioResults = []
    window.__scenarios = ${JSON.stringify(scenarios)}
    window.__wrongRequestId = '${wrongRequestId}'
    window.__sourceId = '${sourceId}'
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
    function clickButton(text) {
      var buttons = document.getElementsByTagName('button')
      for (var i = buttons.length - 1; i >= 0; i--) {
        if ((buttons[i].textContent === text || buttons[i].textContent.indexOf(text) === 0) && !buttons[i].disabled) {
          buttons[i].click()
          return true
        }
      }
      return false
    }
    function sawAck(requestId, status) {
      for (var i = 0; i < window.__acks.length; i++) {
        if (window.__acks[i].requestId === requestId && window.__acks[i].sourceId === window.__sourceId && window.__acks[i].status === status) return true
      }
      return false
    }
    function sawPrompt(scenario) {
      for (var i = 0; i < window.__messages.length; i++) {
        var msg = window.__messages[i]
        if (msg && msg.type === scenario.type && msg.id === scenario.requestId && msg.sourceId === window.__sourceId) return true
      }
      return false
    }
    async function runScenario(scenario) {
      var deadline = Date.now() + 60000
      var clicked = false
      while (Date.now() < deadline) {
        if (sawPrompt(scenario) && !clicked) clicked = clickButton(scenario.buttonText)
        if (clicked && sawAck(scenario.requestId, 'accepted')) return { key: scenario.key, ok: true }
        await delay(100)
      }
      throw new Error('Scenario failed: ' + scenario.key + ', clicked=' + clicked + ', sawPrompt=' + sawPrompt(scenario))
    }
    async function runWrongRequest() {
      if (!window.__vibeTest || !window.__vibeTest.sendTestMessage) throw new Error('test send hook unavailable')
      window.__vibeTest.sendTestMessage({ type: 'permission_reply', ackId: 'ack-wrong-e2e', sourceId: window.__sourceId, sessionId: '${sessionId}', requestID: window.__wrongRequestId, reply: 'once' })
      var deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        if (sawAck(window.__wrongRequestId, 'failed')) return { key: 'wrong-request', ok: true }
        await delay(100)
      }
      throw new Error('Wrong request did not receive failed ACK')
    }
    ;(async function () {
      try {
        while (!window.__vibeTest || document.getElementById('connect-status').textContent !== '已连接!') await delay(100)
        await ready()
        for (var i = 0; i < window.__scenarios.length; i++) {
          var scenario = window.__scenarios[i]
          await fetch('/__send-scenario', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: scenario.key }) })
          window.__scenarioResults.push(await runScenario(scenario))
          await delay(650)
        }
        window.__scenarioResults.push(await runWrongRequest())
        await report({ ok: true, results: window.__scenarioResults, messages: window.__messages.length, acks: window.__acks.length, userAgent: navigator.userAgent })
      } catch (err) {
        await report({ ok: false, error: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : '', results: window.__scenarioResults, messages: window.__messages.length, acks: window.__acks.length })
      }
    })()
  </script>
</body>
</html>`
}

async function main() {
  await postJson(`http://${relayHost}/api/register`, { sourceId, tool: 'test-adapter', name: 'Firefox Relay Prompt E2E', capabilities: ['permission.ask', 'question.asked'] })

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
    if (req.method === 'POST' && url.pathname === '/__send-scenario') {
      let body = ''
      req.on('data', chunk => { body += chunk.toString('utf8') })
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body)
          const scenario = scenarios.find(item => item.key === payload.key)
          if (!scenario) throw new Error(`unknown scenario ${payload.key}`)
          await postJson(`http://${relayHost}/api/event`, eventForScenario(scenario))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: err.message }))
        }
      })
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
  }, 120000)

  try {
    await readyPromise
    const result = await resultPromise
    clearTimeout(timeout)
    if (!result.ok) throw new Error(`Firefox relay prompt E2E failed: ${result.error}\n${result.stack || ''}`)

    const replies = await getJson(`http://${relayHost}/api/replies?sourceId=${encodeURIComponent(sourceId)}`)
    const queue = Array.isArray(replies.replies) ? replies.replies : []
    for (const scenario of scenarios) {
      const reply = queue.find(item => item.requestId === scenario.requestId)
      if (!reply) throw new Error(`No reply queued for ${scenario.key}: ${JSON.stringify(queue)}`)
      if (reply.kind !== scenario.expect.kind) throw new Error(`Unexpected kind for ${scenario.key}: ${JSON.stringify(reply)}`)
      if (scenario.expect.reply && reply.reply !== scenario.expect.reply) throw new Error(`Unexpected reply for ${scenario.key}: ${JSON.stringify(reply)}`)
      if (scenario.expect.answers && JSON.stringify(reply.answers) !== JSON.stringify(scenario.expect.answers)) throw new Error(`Unexpected answers for ${scenario.key}: ${JSON.stringify(reply)}`)
      if (reply.sessionId !== sessionId) throw new Error(`Unexpected sessionId for ${scenario.key}: ${JSON.stringify(reply)}`)
    }

    console.log(`ok relay-prompt firefox scenarios=${result.results.map(item => item.key).join(',')} queued=${queue.length} messages=${result.messages} acks=${result.acks}`)
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
