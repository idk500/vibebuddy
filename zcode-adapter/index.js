/**
 * VibeBuddy ZCode Adapter
 *
 * Tails ZCode's structured JSONL log and translates events into
 * VibeBuddy Relay Hub HTTP API calls.
 *
 * Each ZCode session (including subagents) registers as a separate source.
 *
 * Usage:
 *   node index.js [--relay http://127.0.0.1:4097] [--logdir C:\Users\...\.zcode\cli\log]
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { request as httpRequest } from 'node:http'

// ── Configuration ──────────────────────────────────────

const args = process.argv.slice(2)
function getArg(name) {
  const idx = args.indexOf('--' + name)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null
}

const RELAY_URL = (getArg('relay') || process.env.VIBE_RELAY_URL || 'http://127.0.0.1:4097').replace(/\/+$/, '')
const LOG_DIR = getArg('logdir') || join(homedir(), '.zcode', 'cli', 'log')
const POLL_MS = 500
const REGISTER_INTERVAL_MS = 15000
const NOISY_TOOLS = new Set(['TodoRead', 'TodoWrite', 'AskUserQuestion'])

// ── State ──────────────────────────────────────────────

let byteOffset = 0
let currentFile = null

/** Per-session state: running tools, registered flag, metadata */
const sessions = new Map()

function getSessionState(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sourceId: 'zcode:' + sessionId.slice(0, 24),
      runningTools: new Set(),
      registered: false,
      isSubagent: sessionId.includes('_subagent_'),
      agentType: null,
      parentSessionId: null,
    })
  }
  return sessions.get(sessionId)
}

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

async function registerSession(state) {
  if (state.registered) return
  const name = state.isSubagent
    ? `${state.agentType || 'Agent'} (sub)`
    : 'ZCode'
  const res = await postJson('/api/register', {
    sourceId: state.sourceId,
    tool: state.isSubagent ? `zcode:${state.agentType || 'agent'}` : 'zcode',
    name: name,
    capabilities: ['events'],
  })
  if (res && res.ok) {
    state.registered = true
    console.log(`[adapter] Registered: ${name} → ${state.sourceId}`)
  }
}

function sendEvent(state, msg) {
  msg.sourceId = state.sourceId
  postJson('/api/event', msg)
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
  const sessionId = entry.sessionId
  const ctx = entry.context || {}

  if (!sessionId) return

  const state = getSessionState(sessionId)

  // Detect subagent metadata
  if (event === 'turn.started' && ctx.agentType) {
    state.isSubagent = true
    state.agentType = ctx.agentType
    state.parentSessionId = ctx.parentSessionId || null
    registerSession(state)
    sendEvent(state, {
      type: 'status',
      status: 'THINKING',
      task: `${ctx.agentType} agent started`,
      duration: 0, toolCount: 0, errorCount: 0,
    })
    return
  }

  // Auto-register on first activity
  if (!state.registered) {
    registerSession(state)
  }

  switch (event) {
    case 'subagent.spawned': {
      // Log in parent session
      sendEvent(state, {
        type: 'log',
        level: 'info',
        message: `Spawned ${ctx.agentType || 'agent'} subagent`,
        ts: Date.now(),
      })
      break
    }

    case 'subagent.completed': {
      sendEvent(state, {
        type: 'log',
        level: 'info',
        message: `${ctx.agentType || 'Agent'} completed (${ctx.totalToolUseCount ?? '?'} tools)`,
        ts: Date.now(),
      })
      break
    }

    case 'turn.completed': {
      state.runningTools.clear()
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
        task: `Thinking... (iteration ${ctx.iteration ?? '?'})`,
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
          task: `Running: ${toolName}`,
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
            task: 'Processing...',
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

// ── Main loop ──────────────────────────────────────────

async function main() {
  console.log(`[adapter] VibeBuddy ZCode Adapter starting...`)
  console.log(`[adapter] Relay:   ${RELAY_URL}`)
  console.log(`[adapter] Log dir: ${LOG_DIR}`)

  // Poll log file
  setInterval(tailFile, POLL_MS)
  tailFile()

  console.log(`[adapter] Watching for ZCode events...`)
}

main().catch((err) => {
  console.error(`[adapter] Fatal: ${err.message}`)
  process.exit(1)
})
