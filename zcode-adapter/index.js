/**
 * VibeBuddy ZCode Adapter
 *
 * Tails ZCode's JSONL log + reads session files for titles.
 * Each main session is a source. Subagents are tracked as
 * a property of the parent session, not separate sources.
 *
 * Usage:
 *   node index.js [--relay URL] [--logdir PATH] [--sessionsdir PATH]
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createAdapter, makeSourceId } from '../adapter-core/index.js'

// ── Configuration ──────────────────────────────────────

const args = process.argv.slice(2)
function getArg(name) {
  const idx = args.indexOf('--' + name)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null
}

const RELAY_URL = (getArg('relay') || process.env.VIBE_RELAY_URL || 'http://127.0.0.1:4097').replace(/\/+$/, '')
const LOG_DIR = getArg('logdir') || join(homedir(), '.zcode', 'cli', 'log')
const SESSIONS_DIR = getArg('sessionsdir') || join(homedir(), '.zcode', 'v2', 'sessions')
const POLL_MS = 500
const NOISY_TOOLS = new Set(['TodoRead', 'TodoWrite', 'AskUserQuestion'])

// ── State ──────────────────────────────────────────────

let byteOffset = 0
let currentFile = null

/** sessionId → { sourceId, registered, title, runningTools, subagents, lastActivityAt } */
const sessions = new Map()

// ── Staleness timeout ──────────────────────────────────

const STALE_MS = 60 * 1000  // 60s with no events → mark IDLE

function checkStaleSessions() {
  const now = Date.now()
  for (const [sid, state] of sessions) {
    if (!state.lastActivityAt) continue
    const age = now - state.lastActivityAt
    if (age > STALE_MS && state.currentStatus !== 'IDLE') {
      state.currentStatus = 'IDLE'
      sendEvent(state, {
        type: 'status',
        status: 'IDLE',
        task: state.title + ' (idle)',
        duration: 0, toolCount: 0, errorCount: 0,
      })
    }
  }
}

// ── HTTP transport (shared via adapter-core) ───────────

// 复用 core 的 fetch 传输，避免各 adapter 自写 node:http。
const transport = createAdapter({ relayUrl: RELAY_URL, tool: 'zcode', sourceId: 'zcode:_transport' })
function postJson(path, body) {
  return transport._post(path, body)
}

// ── Session title lookup ───────────────────────────────

const sessionIdToFile = new Map()

/** Scan session files to build sessionId → {title, file} index */
function scanSessionFiles() {
  if (!existsSync(SESSIONS_DIR)) return
  try {
    const workspaces = readdirSync(SESSIONS_DIR)
    for (const ws of workspaces) {
      const wsDir = join(SESSIONS_DIR, ws)
      if (!statSync(wsDir).isDirectory()) continue
      const files = readdirSync(wsDir)
      for (const f of files) {
        if (!f.endsWith('.json')) continue
        try {
          const raw = readFileSync(join(wsDir, f), 'utf-8')
          const s = JSON.parse(raw)
          const sid = s.meta?.acpSessionId
          if (sid && s.meta?.title) {
            sessionIdToFile.set(sid, { title: s.meta.title, workspace: s.meta.workspacePath })
          }
        } catch { /* skip malformed */ }
      }
    }
  } catch (err) {
    console.error(`[adapter] Session scan failed: ${err.message}`)
  }
}

function getSessionTitle(sessionId) {
  const info = sessionIdToFile.get(sessionId)
  if (info) return info.title
  return null
}

// ── Session management ─────────────────────────────────

function getSession(sessionId) {
  if (!sessionId) return null
  if (!sessions.has(sessionId)) {
    // Subagent sessions have parentSessionId in context
    sessions.set(sessionId, {
      sourceId: makeSourceId('zcode', { seed: sessionId }),
      registered: false,
      title: getSessionTitle(sessionId) || sessionId.slice(0, 12),
      runningTools: new Set(),
      activeSubagents: [],  // [{agentType, toolCount, startedAt}]
      completedSubagents: 0,
      lastActivityAt: 0,
      currentStatus: 'IDLE',
    })
  }
  return sessions.get(sessionId)
}

/** Get the effective session for an event — subagent events map to parent */
function getEffectiveSession(entry) {
  const sid = entry.sessionId
  const ctx = entry.context || {}

  // If this is a subagent session, find the parent
  if (sid && sid.includes('_subagent_') && ctx.parentSessionId) {
    const parent = getSession(ctx.parentSessionId)
    if (!parent) return null
    // Track subagent info on parent
    const agentType = ctx.agentType || 'Agent'
    const existing = parent.activeSubagents.find(s => s.sessionId === sid)
    if (!existing) {
      parent.activeSubagents.push({
        sessionId: sid,
        agentType,
        toolCount: 0,
        startedAt: Date.now(),
      })
    }
    return parent
  }

  return getSession(sid)
}

async function registerSession(state) {
  if (state.registered) return
  const ok = await postJson('/api/register', {
    sourceId: state.sourceId,
    tool: 'zcode',
    name: state.title,
    capabilities: ['events'],
  })
  if (ok) {
    state.registered = true
    console.log(`[adapter] Registered: ${state.title} → ${state.sourceId}`)
  }
}

function sendEvent(state, msg) {
  msg.sourceId = state.sourceId
  if (msg.type === 'status') state.currentStatus = msg.status
  postJson('/api/event', msg)
}

/** Build a task description that includes subagent info */
function buildTaskLabel(state, baseTask) {
  if (state.activeSubagents.length > 0) {
    const names = state.activeSubagents.map(s => s.agentType).join(', ')
    return `${baseTask} (${names})`
  }
  return baseTask
}

// ── Event mapping ──────────────────────────────────────

function todayFile() {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return join(LOG_DIR, `zcode-${yyyy}-${mm}-${dd}.jsonl`)
}

function handleLine(line) {
  if (!line.trim()) return
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    return
  }

  const event = entry.event
  const ctx = entry.context || {}
  const state = getEffectiveSession(entry)
  if (!state) return

  registerSession(state)
  state.lastActivityAt = Date.now()

  switch (event) {
    // Subagent lifecycle (on parent session)
    case 'subagent.spawned': {
      // Already tracked in getEffectiveSession
      sendEvent(state, {
        type: 'log',
        level: 'info',
        message: `▸ ${ctx.agentType || 'Agent'} spawned`,
        ts: Date.now(),
      })
      break
    }

    case 'subagent.completed': {
      // Remove from active list
      const agentType = ctx.agentType || 'Agent'
      state.activeSubagents = state.activeSubagents.filter(
        s => s.agentType !== agentType || s.sessionId !== entry.sessionId
      )
      state.completedSubagents++
      sendEvent(state, {
        type: 'log',
        level: 'info',
        message: `✓ ${agentType} completed (${ctx.totalToolUseCount ?? '?'} tools)`,
        ts: Date.now(),
      })
      break
    }

    case 'turn.completed': {
      state.runningTools.clear()
      state.activeSubagents = []
      sendEvent(state, {
        type: 'status',
        status: 'IDLE',
        task: 'Turn complete',
        duration: 0, toolCount: 0, errorCount: 0,
      })
      break
    }

    case 'turn.started': {
      sendEvent(state, {
        type: 'status',
        status: 'THINKING',
        task: buildTaskLabel(state, 'Thinking...'),
        duration: 0, toolCount: 0, errorCount: 0,
      })
      break
    }

    case 'model.network.completed': {
      // Model finished a network request — if no tools are running, model is thinking
      if (state.runningTools.size === 0) {
        sendEvent(state, {
          type: 'status',
          status: 'THINKING',
          task: buildTaskLabel(state, `Thinking... (iter ${ctx.iteration ?? '?'})`),
          duration: entry.durationMs || 0,
          toolCount: 0, errorCount: 0,
        })
      }
      break
    }

    case 'model.response.diagnostics': {
      if (ctx.finishReason === 'end-turn') {
        state.runningTools.clear()
        sendEvent(state, {
          type: 'status',
          status: 'IDLE',
          task: 'Task complete',
          duration: 0, toolCount: 0, errorCount: 0,
        })
      }
      break
    }

    case 'tool.call.started': {
      const toolName = ctx.toolName || 'unknown'
      const callId = entry.toolCallId || ''
      if (!NOISY_TOOLS.has(toolName)) {
        state.runningTools.add(callId)
        sendEvent(state, {
          type: 'tool',
          id: callId,
          name: toolName,
          status: 'started',
          args: {},
          ts: Date.now(),
        })
        sendEvent(state, {
          type: 'status',
          status: 'EXECUTING',
          task: buildTaskLabel(state, `Running: ${toolName}`),
          duration: 0, toolCount: 0, errorCount: 0,
        })
      }
      break
    }

    case 'tool.call.completed': {
      const toolName = ctx.toolName || 'unknown'
      const callId = entry.toolCallId || ''
      const toolStatus = entry.status === 'completed' ? 'completed' : 'failed'
      if (!NOISY_TOOLS.has(toolName)) {
        state.runningTools.delete(callId)
        sendEvent(state, {
          type: 'tool',
          id: callId,
          name: toolName,
          status: toolStatus,
          args: {},
          ts: Date.now(),
        })
        if (state.runningTools.size === 0) {
          sendEvent(state, {
            type: 'status',
            status: 'THINKING',
            task: buildTaskLabel(state, 'Processing...'),
            duration: 0, toolCount: 0, errorCount: 0,
          })
        }
      }
      break
    }

    case 'tool.call.failed': {
      const toolName = ctx.toolName || 'unknown'
      const callId = entry.toolCallId || ''
      state.runningTools.delete(callId)
      sendEvent(state, {
        type: 'tool',
        id: callId,
        name: toolName,
        status: 'failed',
        args: {},
        ts: Date.now(),
      })
      break
    }

    case 'tool.permission.resolved': {
      const toolName = ctx.toolName || 'unknown'
      const decision = ctx.decision || 'unknown'
      sendEvent(state, {
        type: 'log',
        level: 'info',
        message: `Permission: ${toolName} → ${decision} (${ctx.reason || ''})`,
        ts: Date.now(),
      })
      break
    }

    case 'session.resumed': {
      // Re-register with potentially updated title
      const title = getSessionTitle(entry.sessionId)
      if (title && state.title !== title) {
        state.title = title
        state.registered = false
        registerSession(state)
      }
      break
    }
  }
}

// ── Log tailing ────────────────────────────────────────

const REPLAY_TAIL_BYTES = 200 * 1024  // Replay last 200KB on startup

/** Replay only enough to register known sessions and determine their last status */
function replayRecentLines() {
  const target = todayFile()
  if (!existsSync(target)) return 0

  let data
  try {
    data = readFileSync(target, 'utf-8')
  } catch {
    return 0
  }

  const totalLen = data.length
  const start = Math.max(0, totalLen - REPLAY_TAIL_BYTES)
  const chunk = data.slice(start)
  const lines = (start > 0 ? chunk.slice(chunk.indexOf('\n') + 1) : chunk).split('\n')

  // Collect last event per session for status inference
  const lastEvents = new Map()  // sessionId → last entry
  let count = 0
  for (const line of lines) {
    if (!line.trim()) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const sid = entry.sessionId
    if (sid) {
      lastEvents.set(sid, entry)
    }
    // Also track subagent→parent mappings
    getEffectiveSession(entry)
    count++
  }

  // For each known session, register it and send its inferred last status
  const now = Date.now()
  for (const [sid, entry] of lastEvents) {
    const state = sessions.get(sid)
    if (!state) continue
    registerSession(state)

    // Check if last event is too old to be considered active
    const entryTs = entry.timestamp ? new Date(entry.timestamp).getTime() : 0
    const age = entryTs ? now - entryTs : Infinity
    const isRecent = age < STALE_MS

    if (!isRecent) {
      // Stale session → IDLE
      sendEvent(state, {
        type: 'status',
        status: 'IDLE',
        task: state.title,
        duration: 0, toolCount: 0, errorCount: 0,
      })
      state.lastActivityAt = entryTs || 0
      state.currentStatus = 'IDLE'
      continue
    }

    // Recent event → infer status
    const event = entry.event
    const ctx = entry.context || {}
    let status = 'IDLE'
    let task = state.title

    if (event === 'tool.call.started') {
      status = 'EXECUTING'
      task = `Running: ${ctx.toolName || 'tool'}`
    } else if (event === 'tool.call.completed' || event === 'tool.call.failed') {
      status = 'THINKING'
      task = 'Processing...'
    } else if (event === 'model.network.completed') {
      status = 'THINKING'
      task = `Thinking...`
    } else if (event === 'model.response.diagnostics') {
      if (ctx.finishReason === 'end-turn') {
        status = 'IDLE'
        task = 'Task complete'
      } else {
        status = 'THINKING'
        task = 'Thinking...'
      }
    } else if (event === 'turn.completed') {
      status = 'IDLE'
      task = 'Turn complete'
    }

    state.lastActivityAt = entryTs || now
    sendEvent(state, {
      type: 'status',
      status,
      task: buildTaskLabel(state, task),
      duration: 0, toolCount: 0, errorCount: 0,
    })
  }

  return count
}

function tailFile() {
  const target = todayFile()

  if (currentFile !== target) {
    if (currentFile) {
      console.log(`[adapter] Log rotated: ${currentFile} → ${target}`)
    }
    currentFile = target
    byteOffset = 0
    if (existsSync(target)) {
      byteOffset = statSync(target).size
    }
  }

  if (!existsSync(target)) return

  let data
  try {
    data = readFileSync(target, 'utf-8')
  } catch {
    return
  }

  const newContent = data.slice(byteOffset)
  if (!newContent) return

  byteOffset = data.length
  const lines = newContent.split('\n')
  for (const line of lines) {
    handleLine(line)
  }
}

// ── Main ───────────────────────────────────────────────

async function main() {
  console.log(`[adapter] VibeBuddy ZCode Adapter starting...`)
  console.log(`[adapter] Relay:      ${RELAY_URL}`)
  console.log(`[adapter] Log dir:    ${LOG_DIR}`)
  console.log(`[adapter] Sessions:   ${SESSIONS_DIR}`)

  // Scan session files for titles
  scanSessionFiles()
  console.log(`[adapter] Loaded ${sessionIdToFile.size} session titles`)

  // Periodically rescan for new sessions
  setInterval(scanSessionFiles, 30000)

  // Replay recent log entries to restore known session state
  const replayCount = replayRecentLines()
  console.log(`[adapter] Replayed ${replayCount} recent log entries`)

  // Set byteOffset to end of file after replay
  const target = todayFile()
  if (existsSync(target)) {
    byteOffset = statSync(target).size
  }

  // Poll log file for new entries
  setInterval(tailFile, POLL_MS)

  // Check for stale sessions every 15s
  setInterval(checkStaleSessions, 15000)

  console.log(`[adapter] Watching for ZCode events...`)
}

main().catch((err) => {
  console.error(`[adapter] Fatal: ${err.message}`)
  process.exit(1)
})
