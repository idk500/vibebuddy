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
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'

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

/** sessionId → { sourceId, registered, title, runningTools, subagents } */
const sessions = new Map()

// ── HTTP helpers ───────────────────────────────────────

function postJson(path, body) {
  const url = RELAY_URL + path
  const data = JSON.stringify(body)
  return new Promise((resolve) => {
    const req = httpRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)) } catch { resolve(null) }
      })
    })
    req.on('error', (err) => {
      console.error(`[adapter] POST ${path} failed: ${err.message}`)
      resolve(null)
    })
    req.write(data)
    req.end()
  })
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
  if (!sessions.has(sessionId)) {
    // Subagent sessions have parentSessionId in context
    sessions.set(sessionId, {
      sourceId: 'zcode:' + sessionId.slice(0, 24),
      registered: false,
      title: getSessionTitle(sessionId) || sessionId.slice(0, 12),
      runningTools: new Set(),
      activeSubagents: [],  // [{agentType, toolCount, startedAt}]
      completedSubagents: 0,
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
  const res = await postJson('/api/register', {
    sourceId: state.sourceId,
    tool: 'zcode',
    name: state.title,
    capabilities: ['events'],
  })
  if (res && res.ok) {
    state.registered = true
    console.log(`[adapter] Registered: ${state.title} → ${state.sourceId}`)
  }
}

function sendEvent(state, msg) {
  msg.sourceId = state.sourceId
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

    case 'model.network.completed': {
      sendEvent(state, {
        type: 'status',
        status: 'THINKING',
        task: buildTaskLabel(state, `Thinking... (iter ${ctx.iteration ?? '?'})`),
        duration: entry.durationMs || 0,
        toolCount: 0, errorCount: 0,
      })
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

  // Poll log file
  setInterval(tailFile, POLL_MS)
  tailFile()

  console.log(`[adapter] Watching for ZCode events...`)
}

main().catch((err) => {
  console.error(`[adapter] Fatal: ${err.message}`)
  process.exit(1)
})
