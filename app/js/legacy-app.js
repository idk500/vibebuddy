/* VibeCoding Companion — legacy browser app bundle (no modules, no private fields) */
(function () {
  'use strict'

  function $(id) {
    var el = document.getElementById(id)
    if (!el) throw new Error('Element #' + id + ' not found')
    return el
  }

  function safeJsonParse(raw) {
    try { return JSON.parse(raw) } catch (e) { return null }
  }

  function pad2(n) { return String(n).length < 2 ? '0' + n : String(n) }

  function formatTime(ts) {
    var d = new Date(ts || Date.now())
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  }

  function formatDuration(ms) {
    if (!ms || ms <= 0) return '00:00'
    var totalSeconds = Math.floor(ms / 1000)
    var minutes = Math.floor(totalSeconds / 60)
    var seconds = totalSeconds % 60
    return pad2(minutes) + ':' + pad2(seconds)
  }

  function truncate(str, maxLen) {
    str = str == null ? '' : String(str)
    return str.length <= maxLen ? str : str.slice(0, maxLen - 1) + '\u2026'
  }

  function createElement(tag, attrs) {
    var el = document.createElement(tag)
    var i
    if (attrs) {
      for (var key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue
        if (key === 'className') el.className = attrs[key]
        else if (key.indexOf('data-') === 0) el.setAttribute(key, attrs[key])
        else el[key] = attrs[key]
      }
    }
    for (i = 2; i < arguments.length; i++) {
      var child = arguments[i]
      if (typeof child === 'string') el.appendChild(document.createTextNode(child))
      else if (child) el.appendChild(child)
    }
    return el
  }

  function showErr(msg) {
    var errorBar = document.getElementById('js-error')
    if (errorBar) {
      errorBar.style.display = 'block'
      errorBar.textContent = msg
    }
  }

  window.onerror = function (msg, _url, line) { showErr('Error: ' + msg + ' (L' + line + ')') }
  window.onunhandledrejection = function (e) { showErr('Promise: ' + (e && e.reason && e.reason.message ? e.reason.message : e && e.reason)) }

  function WSClient() {
    this.url = null
    this.ws = null
    this.state = 'DISCONNECTED'
    this.reconnectTimer = null
    this.reconnectAttempt = 0
    this.maxReconnectDelay = 30000
    this.baseReconnectDelay = 1000
    this.onStateChangeCallbacks = []
    this.onMessageCallbacks = []
  }

  WSClient.prototype.connect = function (host) {
    this.disconnect()
    this.url = 'ws://' + host + '/ws'
    this.setState('CONNECTING')
    this.reconnectAttempt = 0
    this.createConnection()
  }

  WSClient.prototype.disconnect = function () {
    this.clearReconnect()
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.onmessage = null
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'Client disconnect')
      }
      this.ws = null
    }
    this.setState('DISCONNECTED')
  }

  WSClient.prototype.send = function (message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(message))
    return true
  }

  WSClient.prototype.sendBinary = function (data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(data)
    return true
  }

  WSClient.prototype.onStateChange = function (callback) {
    this.onStateChangeCallbacks.push(callback)
  }

  WSClient.prototype.onMessage = function (callback) {
    this.onMessageCallbacks.push(callback)
  }

  WSClient.prototype.createConnection = function () {
    var self = this
    if (!this.url) return
    try {
      this.ws = new WebSocket(this.url)
    } catch (err) {
      console.error('[ws] Failed to create WebSocket:', err)
      this.scheduleReconnect()
      return
    }
    this.ws.onopen = function () {
      console.log('[ws] Connected')
      self.reconnectAttempt = 0
      self.setState('CONNECTED')
    }
    this.ws.onclose = function (event) {
      console.log('[ws] Closed: code=' + event.code + ' reason=' + event.reason)
      if (self.state !== 'DISCONNECTED') {
        self.setState('RECONNECTING')
        self.scheduleReconnect()
      }
    }
    this.ws.onerror = function (event) {
      console.error('[ws] Error:', event)
    }
    this.ws.onmessage = function (event) {
      if (typeof event.data === 'string') {
        var msg = safeJsonParse(event.data)
        if (msg) self.dispatchMessage(msg)
        else console.warn('[ws] Invalid JSON message')
      }
    }
  }

  WSClient.prototype.setState = function (state) {
    this.state = state
    for (var i = 0; i < this.onStateChangeCallbacks.length; i++) {
      try { this.onStateChangeCallbacks[i](state) } catch (err) { console.error('[ws] State callback error:', err) }
    }
  }

  WSClient.prototype.dispatchMessage = function (msg) {
    for (var i = 0; i < this.onMessageCallbacks.length; i++) {
      try { this.onMessageCallbacks[i](msg) } catch (err) { console.error('[ws] Message callback error:', err) }
    }
  }

  WSClient.prototype.scheduleReconnect = function () {
    var self = this
    this.clearReconnect()
    var delay = Math.min(this.baseReconnectDelay * Math.pow(2, this.reconnectAttempt), this.maxReconnectDelay)
    this.reconnectAttempt++
    console.log('[ws] Reconnect attempt ' + this.reconnectAttempt + ' in ' + delay + 'ms')
    this.reconnectTimer = setTimeout(function () {
      self.reconnectTimer = null
      self.createConnection()
    }, delay)
  }

  WSClient.prototype.clearReconnect = function () {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  var STATUS_COLORS = {
    DISCONNECTED: '#475569',
    IDLE: '#3b82f6',
    THINKING: '#f59e0b',
    EXECUTING: '#10b981',
    ERROR: '#ef4444',
    COMPLETE: '#34d399'
  }

  function hexToRgba(hex, alpha) {
    var r = parseInt(hex.slice(1, 3), 16)
    var g = parseInt(hex.slice(3, 5), 16)
    var b = parseInt(hex.slice(5, 7), 16)
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')'
  }

  function AndonRenderer() {
    this.currentStatus = 'DISCONNECTED'
    this.durationTimer = null
    this.panel = $('andon-panel')
    this.statusText = $('andon-status-text')
    this.task = $('andon-task')
    this.statTools = $('stat-tools')
    this.statErrors = $('stat-errors')
    this.statDuration = $('stat-duration')
  }

  AndonRenderer.prototype.update = function (data) {
    var status = data.status || 'DISCONNECTED'
    var color = STATUS_COLORS[status] || STATUS_COLORS.DISCONNECTED
    if (status !== this.currentStatus) {
      this.currentStatus = status
      document.documentElement.style.setProperty('--status-color', color)
      document.documentElement.style.setProperty('--status-color-bg', hexToRgba(color, 0.12))
      document.documentElement.style.setProperty('--status-color-glow', hexToRgba(color, 0.25))
      this.panel.setAttribute('data-status', status)
    }
    if (data.task !== undefined) this.task.textContent = truncate(data.task, 120)
    if (data.toolCount !== undefined) this.statTools.textContent = String(data.toolCount)
    if (data.errorCount !== undefined) {
      this.statErrors.textContent = String(data.errorCount)
      this.statErrors.style.color = data.errorCount > 0 ? STATUS_COLORS.ERROR : ''
    }
    if (data.duration !== undefined) this.statDuration.textContent = formatDuration(data.duration)
    this.statusText.textContent = status
  }

  AndonRenderer.prototype.reset = function () {
    this.update({ status: 'DISCONNECTED', task: '等待连接...', toolCount: 0, errorCount: 0, duration: 0 })
    if (this.durationTimer) clearInterval(this.durationTimer)
    this.durationTimer = null
  }

  function LogRenderer() {
    this.container = $('log-container')
    this.entryCount = 0
  }

  LogRenderer.prototype.addToolEvent = function (data) {
    var prefix = data.status === 'started' ? '\u25B8' : data.status === 'failed' ? '\u2717' : '\u2713'
    var title = data.title ? ' ' + data.title : ''
    this.addEntry(prefix + ' ' + data.name + title, data.ts, data.status === 'failed' ? 'log-tool-fail' : 'log-tool')
  }

  LogRenderer.prototype.addLogEntry = function (data) {
    this.addEntry(data.message, data.ts, 'log-' + data.level)
  }

  LogRenderer.prototype.clear = function () {
    while (this.container.firstChild) this.container.removeChild(this.container.firstChild)
    this.entryCount = 0
  }

  LogRenderer.prototype.addEntry = function (message, ts, cssClass) {
    var entry = createElement('div', { className: 'log-entry ' + cssClass },
      createElement('span', { className: 'log-time' }, formatTime(ts)),
      createElement('span', { className: 'log-msg' }, truncate(message, 120))
    )
    this.container.appendChild(entry)
    this.entryCount++
    while (this.entryCount > 100 && this.container.firstChild) {
      this.container.removeChild(this.container.firstChild)
      this.entryCount--
    }
    this.container.scrollTop = this.container.scrollHeight
  }

  var ws = null
  var andon = null
  var log = null
  var pendingPromptOverlays = {}
  var seenSources = {}
  var connected = false

  var connectScreen, andonScreen, serverUrlInput, connectBtn, connectStatus, connectionDot, sessionLabel, clock, disconnectBtn, fullscreenBtn

  function localStorageGet(key) {
    try { return window.localStorage.getItem(key) } catch (e) { return null }
  }

  function localStorageSet(key, value) {
    try { window.localStorage.setItem(key, value) } catch (e) {}
  }

  function isNoisyLog(msg) {
    var message = String(msg && msg.message ? msg.message : '')
    return message.indexOf('OpenCode event: server.instance') === 0 ||
      message.indexOf('OpenCode event: storage.write') === 0 ||
      message.indexOf('OpenCode event: file.watcher') === 0
  }

  function detectServerHost() {
    var loc = window.location
    if ((loc.protocol === 'http:' && loc.port && loc.port !== '80') || (loc.protocol === 'https:' && loc.port && loc.port !== '443')) return loc.host
    return null
  }

  function init() {
    ws = new WSClient()
    andon = new AndonRenderer()
    log = new LogRenderer()

    connectScreen = $('connect-screen')
    andonScreen = $('andon-screen')
    serverUrlInput = $('server-url')
    connectBtn = $('connect-btn')
    connectStatus = $('connect-status')
    connectionDot = $('connection-dot')
    sessionLabel = $('session-label')
    clock = $('clock')
    disconnectBtn = $('disconnect-btn')
    fullscreenBtn = $('fullscreen-btn')

    var lastUrl = localStorageGet('vibe-server-url')
    var currentHost = detectServerHost()
    if (currentHost) {
      serverUrlInput.value = currentHost
      localStorageSet('vibe-server-url', currentHost)
      setTimeout(handleConnect, 300)
    } else if (lastUrl) {
      serverUrlInput.value = lastUrl
    }

    connectBtn.onclick = handleConnect
    serverUrlInput.onkeydown = function (e) { if ((e || window.event).key === 'Enter') handleConnect() }
    disconnectBtn.onclick = handleDisconnect
    fullscreenBtn.onclick = toggleFullscreen
    ws.onStateChange(handleWSStateChange)
    ws.onMessage(handleWSMessage)

    updateClock()
    setInterval(updateClock, 30000)
    andon.reset()
    console.log('[app] VibeCoding Companion legacy app initialized')
  }

  function handleConnect() {
    var url = serverUrlInput.value.replace(/^\s+|\s+$/g, '')
    if (!url) {
      setConnectStatus('请输入服务器地址', 'error')
      return
    }
    localStorageSet('vibe-server-url', url)
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
    console.log('[app] WS state: ' + state)
    if (state === 'CONNECTED') {
      connected = true
      setConnectStatus('已连接!', 'success')
      showScreen('andon')
      connectionDot.className = connectionDot.className.replace(/\s?connected/g, '') + ' connected'
      andon.update({ status: 'IDLE', task: '已连接，等待 AI 客户端事件...', toolCount: 0, errorCount: 0, duration: 0 })
    } else if (state === 'CONNECTING') {
      setConnectStatus('正在连接...', '')
    } else if (state === 'RECONNECTING') {
      connectionDot.className = connectionDot.className.replace(/\s?connected/g, '')
      andon.update({ status: 'DISCONNECTED', task: '重连中...' })
    } else if (state === 'DISCONNECTED') {
      connected = false
      connectionDot.className = connectionDot.className.replace(/\s?connected/g, '')
      connectBtn.disabled = false
      setConnectStatus('连接断开', 'error')
    }
  }

  function handleWSMessage(msg) {
    var type = msg.type
    if (type === 'connected') {
      if (msg.sessionId) sessionLabel.textContent = 'Session: ' + String(msg.sessionId).slice(0, 8)
      console.log('[app] Server version: ' + msg.serverVersion)
    } else if (type === 'source') {
      sessionLabel.textContent = (msg.tool || 'Source') + ': ' + String(msg.sourceId || '').slice(0, 16)
      if (!seenSources[msg.sourceId]) {
        seenSources[msg.sourceId] = true
        log.addLogEntry({ level: 'info', message: 'Source registered: ' + (msg.name || msg.sourceId), ts: msg.ts || Date.now() })
      }
    } else if (type === 'status') {
      andon.update(msg)
      if (msg.sessionId) sessionLabel.textContent = 'Session: ' + String(msg.sessionId).slice(0, 8)
    } else if (type === 'tool') {
      log.addToolEvent(msg)
      if (msg.status === 'started') andon.update({ status: 'EXECUTING', task: msg.title || ('Running: ' + msg.name) })
    } else if (type === 'log') {
      if (!isNoisyLog(msg)) log.addLogEntry(msg)
    } else if (type === 'question') {
      log.addLogEntry({ level: 'warn', message: 'Question: ' + (msg.questions && msg.questions[0] ? msg.questions[0].header || '' : ''), ts: Date.now() })
      showQuestionOverlay(msg)
    } else if (type === 'permission') {
      log.addLogEntry({ level: 'warn', message: 'Permission: ' + (msg.tool || 'unknown'), ts: Date.now() })
      showPermissionOverlay(msg)
    } else if (type === 'reply_ack') {
      handleReplyAck(msg)
    } else {
      console.log('[app] Unknown message type: ' + type, msg)
    }
  }

  function showScreen(screen) {
    connectScreen.className = screen === 'connect' ? 'screen active' : 'screen'
    andonScreen.className = screen === 'andon' ? 'screen active' : 'screen'
  }

  function setConnectStatus(text, cssClass) {
    connectStatus.textContent = text
    connectStatus.className = 'connect-status ' + (cssClass || '')
  }

  function updateClock() {
    var now = new Date()
    clock.textContent = pad2(now.getHours()) + ':' + pad2(now.getMinutes())
  }

  function toggleFullscreen() {
    var el = document.documentElement
    if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen()
    else if (document.exitFullscreen) document.exitFullscreen()
  }

  function addPromptMeta(card, msg) {
    var meta = document.createElement('div')
    meta.className = 'prompt-meta'
    var sessionId = msg.sessionId || msg.sessionID || '—'
    meta.textContent = 'Source: ' + (msg.sourceId || 'legacy') + ' | Session: ' + String(sessionId).slice(0, 12) + ' | Request: ' + (msg.id || '—')
    card.appendChild(meta)
  }

  function addPromptStatus(card) {
    var status = document.createElement('div')
    status.className = 'prompt-ack-status'
    status.textContent = ''
    card.appendChild(status)
    return status
  }

  function setPromptButtonsDisabled(overlay, disabled) {
    var buttons = overlay.getElementsByTagName('button')
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = disabled
  }

  function sendPromptReply(overlay, statusLine, promptMsg, replyMsg) {
    var ackId = 'ack_' + Date.now() + '_' + Math.floor(Math.random() * 1000000)
    var fullReply = {}
    var key
    for (key in replyMsg) fullReply[key] = replyMsg[key]
    fullReply.ackId = ackId
    fullReply.sourceId = promptMsg.sourceId
    fullReply.sessionId = promptMsg.sessionId || promptMsg.sessionID
    pendingPromptOverlays[ackId] = { overlay: overlay, statusLine: statusLine }
    statusLine.textContent = 'Sending reply...'
    setPromptButtonsDisabled(overlay, true)
    if (!ws.send(fullReply)) {
      statusLine.textContent = 'Send failed: WebSocket not connected'
      setPromptButtonsDisabled(overlay, false)
    }
  }

  function handleReplyAck(msg) {
    var pending = pendingPromptOverlays[msg.ackId]
    var text = msg.status === 'accepted' ? 'Accepted' : msg.status === 'expired' ? 'Expired' : 'Failed: ' + (msg.message || '')
    log.addLogEntry({ level: msg.status === 'accepted' ? 'info' : 'error', message: 'Reply ' + text + ' (' + (msg.requestId || '') + ')', ts: Date.now() })
    if (!pending) return
    pending.statusLine.textContent = text
    if (msg.status === 'accepted') setTimeout(function () { pending.overlay.parentNode && pending.overlay.parentNode.removeChild(pending.overlay) }, 450)
    else setPromptButtonsDisabled(pending.overlay, false)
    delete pendingPromptOverlays[msg.ackId]
  }

  function showQuestionOverlay(msg) {
    var overlay = document.createElement('div')
    overlay.className = 'prompt-overlay'
    var card = document.createElement('div')
    card.className = 'prompt-card'
    var header = createElement('div', { className: 'prompt-header' }, createElement('span', { className: 'prompt-header-icon' }, '?'), createElement('span', { className: 'prompt-header-title' }, 'Question'))
    card.appendChild(header)
    addPromptMeta(card, msg)
    var statusLine = addPromptStatus(card)
    var questions = msg.questions || []
    for (var i = 0; i < questions.length; i++) {
      var q = questions[i]
      card.appendChild(createElement('div', { className: 'prompt-question-header' }, q.header || ''))
      card.appendChild(createElement('div', { className: 'prompt-question-text' }, q.question || ''))
      var optionsDiv = createElement('div', { className: 'prompt-options' })
      var options = q.options || []
      for (var j = 0; j < options.length; j++) {
        (function (opt) {
          var labelText = opt.label || String(opt)
          var btn = createElement('button', { className: 'prompt-option' }, createElement('span', { className: 'prompt-option-label' }, labelText))
          if (opt.description) btn.appendChild(createElement('span', { className: 'prompt-option-desc' }, ' — ' + opt.description))
          btn.onclick = function () { sendPromptReply(overlay, statusLine, msg, { type: 'question_reply', requestID: msg.id, answers: [[labelText]] }) }
          optionsDiv.appendChild(btn)
        })(options[j])
      }
      card.appendChild(optionsDiv)
    }
    var actions = createElement('div', { className: 'prompt-actions' })
    var rejectBtn = createElement('button', { className: 'prompt-btn prompt-btn-secondary' }, 'Skip')
    rejectBtn.onclick = function () { sendPromptReply(overlay, statusLine, msg, { type: 'question_reject', requestID: msg.id }) }
    actions.appendChild(rejectBtn)
    card.appendChild(actions)
    overlay.appendChild(card)
    document.body.appendChild(overlay)
  }

  function showPermissionOverlay(msg) {
    var overlay = document.createElement('div')
    overlay.className = 'prompt-overlay'
    var card = document.createElement('div')
    card.className = 'prompt-card'
    card.appendChild(createElement('div', { className: 'prompt-header' }, createElement('span', { className: 'prompt-header-icon' }, '!'), createElement('span', { className: 'prompt-header-title' }, 'Permission Request')))
    addPromptMeta(card, msg)
    var statusLine = addPromptStatus(card)
    card.appendChild(createElement('div', { className: 'perm-tool-name' }, msg.tool || 'unknown'))
    card.appendChild(createElement('div', { className: 'prompt-question-text' }, msg.message || 'Allow this action?'))
    var actions = createElement('div', { className: 'prompt-actions' })
    var allowOnce = createElement('button', { className: 'prompt-btn prompt-btn-primary' }, 'Allow Once')
    allowOnce.onclick = function () { sendPromptReply(overlay, statusLine, msg, { type: 'permission_reply', requestID: msg.id, reply: 'once' }) }
    actions.appendChild(allowOnce)
    var allowAlways = createElement('button', { className: 'prompt-btn prompt-btn-primary' }, 'Allow Always')
    allowAlways.onclick = function () { sendPromptReply(overlay, statusLine, msg, { type: 'permission_reply', requestID: msg.id, reply: 'always' }) }
    actions.appendChild(allowAlways)
    var rejectBtn = createElement('button', { className: 'prompt-btn prompt-btn-danger' }, 'Reject')
    rejectBtn.onclick = function () { sendPromptReply(overlay, statusLine, msg, { type: 'permission_reply', requestID: msg.id, reply: 'reject' }) }
    actions.appendChild(rejectBtn)
    card.appendChild(actions)
    overlay.appendChild(card)
    document.body.appendChild(overlay)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
