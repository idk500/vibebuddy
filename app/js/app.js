/**
 * VibeCoding Companion — Main Application
 *
 * Initializes the PWA, manages application state,
 * wires WebSocket to Andon display and activity log.
 *
 * Auto-connect logic:
 * - If page is served from the relay server (same origin), auto-connect immediately
 * - If opened as a standalone file or from a different server, show connect form
 */

import { $ } from './util.js'
import { WSClient } from './ws.js'
import { AndonRenderer } from './andon.js'
import { LogRenderer } from './log.js'

const errorBar = $('js-error')

function showErr(msg) {
  if (errorBar) { errorBar.style.display = 'block'; errorBar.textContent = msg }
}

window.onerror = (msg, _url, line) => { showErr(`Error: ${msg} (L${line})`) }
window.onunhandledrejection = (e) => { showErr(`Promise: ${e.reason?.message ?? e.reason}`) }

const ws = new WSClient()
const andon = new AndonRenderer()
const log = new LogRenderer()

let connected = false
const pendingPromptOverlays = new Map()

// ── DOM References ──────────────────────────────────────

const connectScreen = $('connect-screen')
const andonScreen = $('andon-screen')
const serverUrlInput = $('server-url')
const connectBtn = $('connect-btn')
const connectStatus = $('connect-status')
const connectionDot = $('connection-dot')
const sessionLabel = $('session-label')
const clock = $('clock')
const disconnectBtn = $('disconnect-btn')
const fullscreenBtn = $('fullscreen-btn')

// ── Initialize ──────────────────────────────────────────

function init() {
  registerSW()

  // Restore last server URL or detect from current page
  const lastUrl = localStorage.getItem('vibe-server-url')
  const currentHost = detectServerHost()

  if (currentHost) {
    // Page is served from a relay server — auto-connect
    serverUrlInput.value = currentHost
    localStorage.setItem('vibe-server-url', currentHost)
    setTimeout(() => handleConnect(), 300)
  } else if (lastUrl) {
    serverUrlInput.value = lastUrl
  }

  // Wire up event handlers
  connectBtn.addEventListener('click', handleConnect)
  serverUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleConnect()
  })
  disconnectBtn.addEventListener('click', handleDisconnect)
  fullscreenBtn.addEventListener('click', toggleFullscreen)

  // Wire WebSocket callbacks
  ws.onStateChange(handleWSStateChange)
  ws.onMessage(handleWSMessage)

  // Start clock
  updateClock()
  setInterval(updateClock, 30000)

  // Set initial Andon state
  andon.reset()

  console.log('[app] VibeCoding Companion initialized')
}

/**
 * Detect if the current page is served from a relay server.
 * Returns "host:port" if detectable, null otherwise.
 */
function detectServerHost() {
  const loc = window.location
  // If port is 4097 or matches our server pattern, it's likely our server
  // Also accept any non-standard port (not 80/443) served over HTTP
  if (loc.protocol === 'http:' && loc.port && loc.port !== '80') {
    return loc.host  // "hostname:port"
  }
  // HTTPS with explicit port
  if (loc.protocol === 'https:' && loc.port && loc.port !== '443') {
    return loc.host
  }
  return null
}

// ── Event Handlers ──────────────────────────────────────

function handleConnect() {
  const url = serverUrlInput.value.trim()
  if (!url) {
    setConnectStatus('请输入服务器地址', 'error')
    return
  }

  // Save for next time
  localStorage.setItem('vibe-server-url', url)

  setConnectStatus('正在连接...', '')
  connectBtn.disabled = true

  ws.connect(url)
}

function handleDisconnect() {
  ws.disconnect()
  connected = false
  andon.reset()
  log.clear()
  showScreen('connect')
}

function handleWSStateChange(state) {
  console.log(`[app] WS state: ${state}`)

  switch (state) {
    case 'CONNECTED':
      connected = true
      setConnectStatus('已连接!', 'success')
      showScreen('andon')
      connectionDot.classList.add('connected')
      break

    case 'CONNECTING':
      setConnectStatus('正在连接...', '')
      break

    case 'RECONNECTING':
      connectionDot.classList.remove('connected')
      andon.update({ status: 'DISCONNECTED', task: '重连中...' })
      break

    case 'DISCONNECTED':
      connected = false
      connectionDot.classList.remove('connected')
      connectBtn.disabled = false
      setConnectStatus('连接断开', 'error')
      break
  }
}

function handleWSMessage(msg) {
  const type = msg['type']

  switch (type) {
    case 'connected':
      // Server confirmed connection
      if (msg['sessionId']) {
        sessionLabel.textContent = `Session: ${msg['sessionId'].slice(0, 8)}`
      }
      console.log(`[app] Server version: ${msg['serverVersion']}`)
      break

    case 'status':
      andon.update(msg)
      if (msg['sessionId']) {
        sessionLabel.textContent = `Session: ${msg['sessionId'].slice(0, 8)}`
      }
      break

    case 'tool':
      log.addToolEvent(msg)
      // If tool started, update Andon with tool title
      if (msg['status'] === 'started') {
        andon.update({
          status: 'EXECUTING',
          task: msg['title'] || `Running: ${msg['name']}`,
        })
      }
      break

    case 'log':
      log.addLogEntry(msg)
      break

    case 'question':
      log.addLogEntry({ level: 'warn', message: `Question: ${msg.questions?.[0]?.header ?? ''}`, ts: Date.now() })
      showQuestionOverlay(msg)
      break

    case 'permission':
      log.addLogEntry({ level: 'warn', message: `Permission: ${msg.tool ?? 'unknown'}`, ts: Date.now() })
      showPermissionOverlay(msg)
      break

    case 'reply_ack':
      handleReplyAck(msg)
      break

    default:
      console.log(`[app] Unknown message type: ${type}`, msg)
  }
}

// ── UI Helpers ──────────────────────────────────────────

function showScreen(/** @type {'connect'|'andon'} */ screen) {
  connectScreen.classList.toggle('active', screen === 'connect')
  andonScreen.classList.toggle('active', screen === 'andon')
}

function setConnectStatus(text, cssClass) {
  connectStatus.textContent = text
  connectStatus.className = `connect-status ${cssClass}`
}

function updateClock() {
  const now = new Date()
  clock.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.()
      .catch((err) => console.warn('[app] Fullscreen failed:', err))
  } else {
    document.exitFullscreen?.()
  }
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(() => console.log('[app] Service Worker registered'))
      .catch((err) => console.warn('[app] SW registration failed:', err))
  }
}

function showQuestionOverlay(msg) {
  const overlay = document.createElement('div')
  overlay.className = 'prompt-overlay'

  const card = document.createElement('div')
  card.className = 'prompt-card'

  const header = document.createElement('div')
  header.className = 'prompt-header'
  const headerIcon = document.createElement('span')
  headerIcon.className = 'prompt-header-icon'
  headerIcon.textContent = '?'
  const headerTitle = document.createElement('span')
  headerTitle.className = 'prompt-header-title'
  headerTitle.textContent = 'OpenCode Question'
  header.appendChild(headerIcon)
  header.appendChild(headerTitle)
  card.appendChild(header)

  addPromptMeta(card, msg)
  const statusLine = addPromptStatus(card)

  for (const q of (msg.questions || [])) {
    const qHeader = document.createElement('div')
    qHeader.className = 'prompt-question-header'
    qHeader.textContent = q.header || ''
    card.appendChild(qHeader)

    const qText = document.createElement('div')
    qText.className = 'prompt-question-text'
    qText.textContent = q.question || ''
    card.appendChild(qText)

    if (q.options && q.options.length > 0) {
      const optionsDiv = document.createElement('div')
      optionsDiv.className = 'prompt-options'
      for (const opt of q.options) {
        const btn = document.createElement('button')
        btn.className = 'prompt-option'
        const label = document.createElement('span')
        label.className = 'prompt-option-label'
        label.textContent = opt.label || opt
        btn.appendChild(label)
        if (opt.description) {
          const desc = document.createElement('span')
          desc.className = 'prompt-option-desc'
          desc.textContent = ` — ${opt.description}`
          btn.appendChild(desc)
        }
        btn.addEventListener('click', () => {
          sendPromptReply(overlay, statusLine, msg, { type: 'question_reply', requestID: msg.id, answers: [[opt.label || opt]] })
        })
        optionsDiv.appendChild(btn)
      }
      card.appendChild(optionsDiv)
    }
  }

  const actions = document.createElement('div')
  actions.className = 'prompt-actions'
  const rejectBtn = document.createElement('button')
  rejectBtn.className = 'prompt-btn prompt-btn-secondary'
  rejectBtn.textContent = 'Skip'
  rejectBtn.addEventListener('click', () => {
    sendPromptReply(overlay, statusLine, msg, { type: 'question_reject', requestID: msg.id })
  })
  actions.appendChild(rejectBtn)
  card.appendChild(actions)

  overlay.appendChild(card)
  document.body.appendChild(overlay)
}

function showPermissionOverlay(msg) {
  const overlay = document.createElement('div')
  overlay.className = 'prompt-overlay'

  const card = document.createElement('div')
  card.className = 'prompt-card'

  const header = document.createElement('div')
  header.className = 'prompt-header'
  const headerIcon = document.createElement('span')
  headerIcon.className = 'prompt-header-icon'
  headerIcon.textContent = '\u26A0'
  const headerTitle = document.createElement('span')
  headerTitle.className = 'prompt-header-title'
  headerTitle.textContent = 'Permission Request'
  header.appendChild(headerIcon)
  header.appendChild(headerTitle)
  card.appendChild(header)

  addPromptMeta(card, msg)
  const statusLine = addPromptStatus(card)

  const toolName = document.createElement('div')
  toolName.className = 'perm-tool-name'
  toolName.textContent = msg.tool || 'unknown'
  card.appendChild(toolName)

  const desc = document.createElement('div')
  desc.className = 'prompt-question-text'
  desc.textContent = msg.message || 'Allow this action?'
  card.appendChild(desc)

  const actions = document.createElement('div')
  actions.className = 'prompt-actions'

  const allowOnce = document.createElement('button')
  allowOnce.className = 'prompt-btn prompt-btn-primary'
  allowOnce.textContent = 'Allow Once'
  allowOnce.addEventListener('click', () => {
    sendPromptReply(overlay, statusLine, msg, { type: 'permission_reply', requestID: msg.id, reply: 'once' })
  })
  actions.appendChild(allowOnce)

  const allowAlways = document.createElement('button')
  allowAlways.className = 'prompt-btn prompt-btn-primary'
  allowAlways.textContent = 'Allow Always'
  allowAlways.addEventListener('click', () => {
    sendPromptReply(overlay, statusLine, msg, { type: 'permission_reply', requestID: msg.id, reply: 'always' })
  })
  actions.appendChild(allowAlways)

  const rejectBtn = document.createElement('button')
  rejectBtn.className = 'prompt-btn prompt-btn-danger'
  rejectBtn.textContent = 'Reject'
  rejectBtn.addEventListener('click', () => {
    sendPromptReply(overlay, statusLine, msg, { type: 'permission_reply', requestID: msg.id, reply: 'reject' })
  })
  actions.appendChild(rejectBtn)

  card.appendChild(actions)
  overlay.appendChild(card)
  document.body.appendChild(overlay)
}

function addPromptMeta(card, msg) {
  const meta = document.createElement('div')
  meta.className = 'prompt-meta'
  const sessionId = msg.sessionId || msg.sessionID || '—'
  meta.textContent = `Source: ${msg.sourceId || 'legacy'} | Session: ${String(sessionId).slice(0, 12)} | Request: ${msg.id || '—'}`
  card.appendChild(meta)
}

function addPromptStatus(card) {
  const status = document.createElement('div')
  status.className = 'prompt-ack-status'
  status.textContent = ''
  card.appendChild(status)
  return status
}

function sendPromptReply(overlay, statusLine, promptMsg, replyMsg) {
  const ackId = `ack_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const fullReply = Object.assign({}, replyMsg, {
    ackId,
    sourceId: promptMsg.sourceId,
    sessionId: promptMsg.sessionId || promptMsg.sessionID,
  })
  pendingPromptOverlays.set(ackId, { overlay, statusLine })
  statusLine.textContent = 'Sending reply...'
  setPromptButtonsDisabled(overlay, true)
  ws.send(fullReply)
}

function handleReplyAck(msg) {
  const pending = pendingPromptOverlays.get(msg.ackId)
  const text = msg.status === 'accepted' ? 'Accepted' : msg.status === 'expired' ? 'Expired' : `Failed: ${msg.message || ''}`
  log.addLogEntry({ level: msg.status === 'accepted' ? 'info' : 'error', message: `Reply ${text} (${msg.requestId || ''})`, ts: Date.now() })
  if (!pending) return
  pending.statusLine.textContent = text
  if (msg.status === 'accepted') {
    setTimeout(() => pending.overlay.remove(), 450)
  } else {
    setPromptButtonsDisabled(pending.overlay, false)
  }
  pendingPromptOverlays.delete(msg.ackId)
}

function setPromptButtonsDisabled(overlay, disabled) {
  const buttons = overlay.querySelectorAll('button')
  for (const btn of buttons) btn.disabled = disabled
}

// ── Start ───────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init)
