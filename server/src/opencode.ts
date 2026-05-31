/**
 * OpenCode SDK Client — Real event subscription via @opencode-ai/sdk
 *
 * Connects to an `opencode serve` instance via the official SDK,
 * subscribes to the global SSE event stream, and transforms events
 * into Andon status messages for phone clients.
 */

import {
  createOpencodeClient,
  type OpencodeClient,
} from '@opencode-ai/sdk'
import type { ServerMessage, AndonStatus } from './types.js'

// ── Event handler callback ──────────────────────────────

export type EventHandler = (message: ServerMessage) => void

// ── OpenCode Relay Interface ────────────────────────────

export interface OpenCodeRelay {
  connect(): Promise<void>
  disconnect(): void
  onEvent(handler: EventHandler): void
}

// ── Implementation ──────────────────────────────────────

export function createOpenCodeRelay(opencodeUrl: string): OpenCodeRelay {
  const handlers = new Set<EventHandler>()
  let connected = false
  let abortController: AbortController | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const RETRY_BASE_MS = 1000
  const RETRY_MAX_MS = 30_000
  const RETRY_MAX_ATTEMPTS = 20
  let retryAttempt = 0

  function emit(message: ServerMessage): void {
    for (const handler of handlers) {
      try {
        handler(message)
      } catch (err) {
        console.error('[opencode] Handler error:', err)
      }
    }
  }

  async function connect(): Promise<void> {
    console.log(`[opencode] Connecting to ${opencodeUrl}...`)

    try {
      await startEventStream()
    } catch (err) {
      console.warn(`[opencode] Connection failed: ${(err as Error).message}`)
      scheduleRetry()
    }
  }

  async function startEventStream(): Promise<void> {
    abortController = new AbortController()

    const client: OpencodeClient = createOpencodeClient({
      baseUrl: opencodeUrl,
    })

    // Subscribe to global SSE event stream
    const result = await client.event.subscribe()

    connected = true
    retryAttempt = 0
    console.log('[opencode] SSE event stream connected')

    try {
      for await (const rawEvent of result.stream) {
        if (!connected) break

        // Raw SSE events have format: { id?, type, properties }
        // Some may be wrapped as GlobalEvent = { directory, payload: Event }
        const event = rawEvent as Record<string, unknown>
        const hasPayload = event['payload'] !== undefined
        const effectiveEvent = hasPayload
          ? event['payload'] as Record<string, unknown>
          : event

        // Skip heartbeats and other non-actionable events
        const eventType = toStr(effectiveEvent['type'], '')
        if (eventType === 'server.heartbeat' || eventType === 'server.connected') {
          continue
        }

        const messages = mapEvent(effectiveEvent)
        for (const msg of messages) {
          emit(msg)
        }
      }
    } catch (err) {
      if (connected) {
        console.warn(`[opencode] Stream error: ${(err as Error).message}`)
        scheduleRetry()
      }
    }
  }

  /**
   * Map an OpenCode Event to zero or more ServerMessages for the phone.
   *
   * Key event types:
   * - session.status  → { type: "idle" | "busy" | "retry", ... }
   * - session.idle    → session finished processing
   * - session.error   → error occurred
   * - message.updated → assistant message created/updated
   * - message.part.updated → tool part state change (pending/running/completed/error)
   * - file.edited     → file was modified
   * - todo.updated    → todo list changed
   */
  function mapEvent(event: Record<string, unknown>): ServerMessage[] {
    const eventType = event['type'] as string
    const props = (event['properties'] ?? {}) as Record<string, unknown>
    const results: ServerMessage[] = []

    switch (eventType) {
      // ── Session status ──────────────────────────────
      case 'session.status': {
        const status = props['status'] as Record<string, unknown> | undefined
        const statusType = status?.['type'] as string

        let andonStatus: AndonStatus = 'IDLE'
        let task = 'Session active'

        if (statusType === 'busy') {
          andonStatus = 'THINKING'
          task = 'Processing...'
        } else if (statusType === 'retry') {
          andonStatus = 'THINKING'
          const attempt = status?.['attempt'] ?? '?'
          const msg = toStr(status?.['message'], '')
          task = `Retry #${toStr(attempt, '?')}: ${msg}`
        } else {
          andonStatus = 'IDLE'
          task = 'Waiting for input'
        }

        results.push({
          type: 'status',
          status: andonStatus,
          task,
          duration: 0,
          toolCount: 0,
          errorCount: 0,
          sessionId: toStr(props['sessionID'], undefined),
        })
        break
      }

      case 'session.idle':
        results.push({
          type: 'status',
          status: 'IDLE',
          task: 'Session idle',
          duration: 0,
          toolCount: 0,
          errorCount: 0,
          sessionId: toStr(props['sessionID'], undefined),
        })
        break

      case 'session.error': {
        const error = props['error'] as Record<string, unknown> | undefined
        results.push({
          type: 'status',
          status: 'ERROR',
          task: error ? toStr(error['message'] ?? error['error'], 'Unknown error') : 'Unknown error',
          duration: 0,
          toolCount: 0,
          errorCount: 1,
        })
        results.push({
          type: 'log',
          level: 'error',
          message: `Session error: ${error ? toStr(error['message'] ?? error['error'], 'unknown') : 'unknown'}`,
          ts: Date.now(),
        })
        break
      }

      // ── Message updates ─────────────────────────────
      case 'message.updated': {
        const info = props['info'] as Record<string, unknown> | undefined
        if (info && info['role'] === 'assistant') {
          const completed = (info['time'] as Record<string, unknown>)?.['completed']
          if (!completed) {
            // Still generating
            results.push({
              type: 'status',
              status: 'THINKING',
              task: 'Generating response...',
              duration: 0,
              toolCount: 0,
              errorCount: 0,
            })
          }
        }
        break
      }

      // ── Tool state changes ──────────────────────────
      case 'message.part.updated': {
        const part = props['part'] as Record<string, unknown> | undefined
        if (!part || part['type'] !== 'tool') break

        const toolName = toStr(part['tool'], 'unknown')
        const state = part['state'] as Record<string, unknown> | undefined
        const stateStatus = toStr(state?.['status'], '')
        const toolInput = (state?.['input'] ?? {}) as Record<string, unknown>

        if (stateStatus === 'running') {
          const title = state?.['title'] ? toStr(state['title'], '') : ''
          results.push({
            type: 'tool',
            name: toolName,
            status: 'started',
            args: toolInput,
            title,
            ts: Date.now(),
          })
          results.push({
            type: 'status',
            status: 'EXECUTING',
            task: title || `Running: ${toolName}`,
            duration: 0,
            toolCount: 0,
            errorCount: 0,
          })
        } else if (stateStatus === 'completed') {
          const title = state?.['title'] ? toStr(state['title'], '') : ''
          results.push({
            type: 'tool',
            name: toolName,
            status: 'completed',
            args: toolInput,
            title,
            ts: Date.now(),
          })
        } else if (stateStatus === 'error') {
          results.push({
            type: 'tool',
            name: toolName,
            status: 'failed',
            args: toolInput,
            ts: Date.now(),
          })
          results.push({
            type: 'log',
            level: 'error',
            message: `Tool ${toolName} failed`,
            ts: Date.now(),
          })
        }
        break
      }

      // ── File edits ──────────────────────────────────
      case 'file.edited':
        results.push({
          type: 'log',
          level: 'info',
          message: `File edited: ${toStr(props['file'], '?')}`,
          ts: Date.now(),
        })
        break

      // ── Todo updates ────────────────────────────────
      case 'todo.updated': {
        const todos = props['todos'] as Array<Record<string, unknown>> | undefined
        if (todos) {
          const inProgress = todos.filter(t => t['status'] === 'in_progress')
          if (inProgress.length > 0) {
            const current = inProgress[0]
            results.push({
              type: 'log',
              level: 'info',
              message: `TODO [${toStr(current?.['status'], '?')}] ${toStr(current?.['content'], '')}`,
              ts: Date.now(),
            })
          }
        }
        break
      }

      // ── Session lifecycle ───────────────────────────
      case 'session.created': {
        const info = props['info'] as Record<string, unknown> | undefined
        results.push({
          type: 'log',
          level: 'info',
          message: `Session created: ${toStr(info?.['title'], 'untitled')}`,
          ts: Date.now(),
        })
        break
      }

      case 'session.diff': {
        const diff = props['diff'] as Array<Record<string, unknown>> | undefined
        if (diff) {
          const fileCount = diff.length
          results.push({
            type: 'log',
            level: 'info',
            message: `Diff: ${fileCount} file${fileCount !== 1 ? 's' : ''} changed`,
            ts: Date.now(),
          })
        }
        break
      }

      // ── Server connection ───────────────────────────
      case 'server.connected':
        results.push({
          type: 'log',
          level: 'info',
          message: 'Server connected',
          ts: Date.now(),
        })
        break

      // ── Questions → forward to phone ───────────────
      case 'question.asked': {
        const info = props['info'] as Record<string, unknown> | undefined ?? event
        const questions = (info?.['questions'] ?? []) as Array<Record<string, unknown>>
        results.push({
          type: 'question',
          id: toStr(info?.['id'] ?? event['id'], ''),
          sessionID: toStr(info?.['sessionID'] ?? event['sessionID'], ''),
          questions: questions.map((q) => ({
            header: toStr(q['header'], ''),
            question: toStr(q['question'], ''),
            options: (q['options'] ?? []) as Array<{ label: string; description: string }>,
            multiple: q['multiple'] === true,
            custom: q['custom'] !== false,
          })),
        })
        results.push({
          type: 'log',
          level: 'warn',
          message: `Question: ${questions.length > 0 ? toStr(questions[0]?.['header'], '') : ''}`,
          ts: Date.now(),
        })
        break
      }

      // ── Permissions → forward to phone ─────────────
      case 'permission.asked': {
        const perm = (props['info'] as Record<string, unknown> | undefined) ?? event
        results.push({
          type: 'permission',
          id: toStr(perm['id'] ?? event['id'], ''),
          sessionID: toStr(perm['sessionID'] ?? event['sessionID'], ''),
          tool: toStr(perm['tool'] ?? perm['name'], 'unknown'),
          message: toStr(perm['message'] ?? perm['description'], 'Allow this action?'),
          patterns: (perm['patterns'] ?? undefined) as string[] | undefined,
        })
        results.push({
          type: 'log',
          level: 'warn',
          message: `Permission: ${toStr(perm['tool'] ?? perm['name'], 'unknown')}`,
          ts: Date.now(),
        })
        break
      }

      default:
        // Log unhandled event types for debugging
        results.push({
          type: 'log',
          level: 'info',
          message: `[${eventType}]`,
          ts: Date.now(),
        })
    }

    return results
  }

  function scheduleRetry(): void {
    if (retryAttempt >= RETRY_MAX_ATTEMPTS) {
      console.warn('[opencode] Max retry attempts reached')
      return
    }

    const delay = Math.min(RETRY_BASE_MS * Math.pow(2, retryAttempt), RETRY_MAX_MS)
    retryAttempt++
    console.log(`[opencode] Retry ${retryAttempt} in ${delay}ms...`)

    retryTimer = setTimeout(() => {
      retryTimer = null
      connect().catch(() => { /* already logged */ })
    }, delay)
  }

  function disconnect(): void {
    connected = false
    if (abortController) {
      abortController.abort()
      abortController = null
    }
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    console.log('[opencode] Disconnected')
  }

  return {
    connect,
    disconnect,
    onEvent(handler: EventHandler): void {
      handlers.add(handler)
    },
  }
}

// ── Utilities ───────────────────────────────────────────

function toStr(value: unknown, fallback: string): string
function toStr(value: unknown, fallback: undefined): string | undefined
function toStr(value: unknown, fallback: string | undefined): string | undefined {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return value.toString(10)
  return JSON.stringify(value)
}
