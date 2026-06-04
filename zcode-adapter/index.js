/**
 * VibeBuddy ZCode Adapter
 *
 * Tails ZCode's structured JSONL log file and translates events into
 * VibeBuddy Relay Hub HTTP API calls.
 *
 * Usage:
 *   node index.js [--relay http://127.0.0.1:4097] [--logdir C:\Users\...\.zcode\cli\log]
 */

import { readFileSync, watchFile, unwatchFile, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
const POLL_MS = 500
const REGISTER_INTERVAL_MS = 15000
const NOISY_TOOLS = new Set(['TodoRead', 'TodoWrite', 'AskUserQuestion'])

const SOURCE_ID = 'zcode:' + createHash('sha256').update(LOG_DIR).digest('hex').slice(0, 16)

// ── State ──────────────────────────────────────────────

let byteOffset = 0
let currentFile = null
let lastSessionId = null
let activeTraceId = null
let runningTools = new Set()
let registered = false

// ── HTTP helpers ───────────────────────────────────────

async function postJson(path, body) {
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

async function registerSource() {
  const res = await postJson('/api/register', {
    sourceId: SOURCE_ID,
    tool: 'zcode',
    name: 'ZCode',
    capabilities: ['events'],
  })
  if (res && res.ok) {
    registered = true
    console.log(`[adapter] Registered as ${SOURCE_ID}`)
  }
}

async function sendEvent(msg) {
  msg.sourceId = SOURCE_ID
  if (lastSessionId) msg.sessionId = lastSessionId
  await postJson('/api/event', msg)
}

// ── Event mapping ──────────────────────────────────────

function todayFile() {
  // Use local date to match ZCode's log file naming
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const date = `${yyyy}-${mm}-${dd}`
  return join(LOG_DIR, `zcode-${date}.jsonl`)
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

  if (sessionId && sessionId !== lastSessionId) {
    lastSessionId = sessionId
  }

  switch (event) {
    // LLM is thinking — network request started/completed
    case 'model.network.completed': {
      activeTraceId = entry.traceId || null
      sendEvent({
        type: 'status',
        status: 'THINKING',
        task: `Thinking... (iteration ${ctx.iteration ?? '?'})`,
        duration: entry.durationMs || 0,
        toolCount: 0,
        errorCount: 0,
      })
      break
    }

    // Model response diagnostics — check if done
    case 'model.response.diagnostics': {
      if (ctx.finishReason === 'end-turn') {
        // Model finished, no more tool calls
        runningTools.clear()
        sendEvent({
          type: 'status',
          status: 'IDLE',
          task: 'Task complete',
          duration: 0,
          toolCount: 0,
          errorCount: 0,
        })
      }
      break
    }

    // Tool call started
    case 'tool.call.started': {
      const toolName = ctx.toolName || 'unknown'
      const callId = entry.toolCallId || ''
      if (!NOISY_TOOLS.has(toolName)) {
        runningTools.add(callId)
        sendEvent({
          type: 'tool',
          id: callId,
          name: toolName,
          status: 'started',
          args: {},
          ts: Date.now(),
        })
        sendEvent({
          type: 'status',
          status: 'EXECUTING',
          task: `Running: ${toolName}`,
          duration: 0,
          toolCount: 0,
          errorCount: 0,
        })
      }
      break
    }

    // Tool call completed
    case 'tool.call.completed': {
      const toolName = ctx.toolName || 'unknown'
      const callId = entry.toolCallId || ''
      const status = entry.status === 'completed' ? 'completed' : 'failed'
      if (!NOISY_TOOLS.has(toolName)) {
        runningTools.delete(callId)
        sendEvent({
          type: 'tool',
          id: callId,
          name: toolName,
          status: status,
          args: {},
          ts: Date.now(),
        })
        // If no more running tools, go back to THINKING
        if (runningTools.size === 0) {
          sendEvent({
            type: 'status',
            status: 'THINKING',
            task: 'Processing...',
            duration: 0,
            toolCount: 0,
            errorCount: 0,
          })
        }
      }
      break
    }

    // Permission resolved (info only, can't intercept)
    case 'tool.permission.resolved': {
      const toolName = ctx.toolName || 'unknown'
      const decision = ctx.decision || 'unknown'
      sendEvent({
        type: 'log',
        level: 'info',
        message: `Permission: ${toolName} → ${decision} (${ctx.reason || ''})`,
        ts: Date.now(),
      })
      break
    }

    default:
      // Ignore other events
      break
  }
}

// ── Log tailing ────────────────────────────────────────

function tailFile() {
  const target = todayFile()

  // Handle date rollover
  if (currentFile !== target) {
    if (currentFile) {
      console.log(`[adapter] Log rotated: ${currentFile} → ${target}`)
    }
    currentFile = target
    byteOffset = 0
    if (existsSync(target)) {
      // Start from end of existing file
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
  console.log(`[adapter] Source ID: ${SOURCE_ID}`)
  console.log(`[adapter] Relay:     ${RELAY_URL}`)
  console.log(`[adapter] Log dir:   ${LOG_DIR}`)

  await registerSource()

  // Re-register periodically
  setInterval(registerSource, REGISTER_INTERVAL_MS)

  // Poll log file
  setInterval(tailFile, POLL_MS)

  // Initial tail
  tailFile()

  console.log(`[adapter] Watching for ZCode events...`)
}

main().catch((err) => {
  console.error(`[adapter] Fatal: ${err.message}`)
  process.exit(1)
})
