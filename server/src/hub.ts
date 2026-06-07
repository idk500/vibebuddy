/**
 * Relay Hub Core — State management and routing
 *
 * Manages sources, terminals, pending requests, and reply queues.
 */

import type {
  AdapterReply,
  AndonStatus,
  PendingRequest,
  ServerMessage,
  SnapshotMessage,
  SourceInstance,
  SourceStatusSnapshot,
  Terminal,
} from './types.js'

export interface RelayHubState {
  sources: Map<string, SourceInstance>
  terminals: Map<string, Terminal>
  pendingRequests: Map<string, PendingRequest>
  replyQueues: Map<string, AdapterReply[]>
  statusTimers: Map<string, ReturnType<typeof setTimeout>>
  lastStatuses: Map<string, SourceStatusSnapshot>
  stats: HubStats
}

export interface HubStats {
  startedAt: number
  eventsReceived: number
  lastEvent: ServerMessage | null
  lastEventAt: number | null
}

export interface HubConfig {
  requestTtlMs: number
  statusSettleMs: number
}

const DEFAULT_HUB_CONFIG: HubConfig = {
  requestTtlMs: 120000,
  statusSettleMs: 20000,
}

export function createHub(config: Partial<HubConfig> = {}) {
  const cfg = { ...DEFAULT_HUB_CONFIG, ...config }
  
  const state: RelayHubState = {
    sources: new Map(),
    terminals: new Map(),
    pendingRequests: new Map(),
    replyQueues: new Map(),
    statusTimers: new Map(),
    lastStatuses: new Map(),
    stats: {
      startedAt: Date.now(),
      eventsReceived: 0,
      lastEvent: null,
      lastEventAt: null,
    },
  }

  function pendingKey(sourceId: string, requestId: string): string {
    return `${sourceId}:${requestId}`
  }

  function statusTimerKey(sourceId: string | undefined, sessionId: string | undefined): string {
    return `${sourceId ?? 'unknown'}:${sessionId ?? 'default'}`
  }

  function registerSource(input: { sourceId: string; tool?: string; name?: string; serverUrl?: string; cwd?: string; capabilities?: string[] }): SourceInstance {
    const existing = state.sources.get(input.sourceId)
    const source: SourceInstance = {
      sourceId: input.sourceId,
      tool: input.tool ?? existing?.tool ?? 'unknown',
      name: input.name ?? existing?.name ?? input.sourceId,
      serverUrl: input.serverUrl ?? existing?.serverUrl,
      cwd: input.cwd ?? existing?.cwd,
      capabilities: Array.isArray(input.capabilities) ? input.capabilities : existing?.capabilities ?? [],
      lastSeen: Date.now(),
    }
    state.sources.set(source.sourceId, source)
    if (!state.replyQueues.has(source.sourceId)) {
      state.replyQueues.set(source.sourceId, [])
    }
    return source
  }

  function addPendingRequest(input: {
    kind: 'permission' | 'question'
    sourceId: string
    sessionId?: string
    requestId: string
  }): void {
    const key = pendingKey(input.sourceId, input.requestId)
    state.pendingRequests.set(key, {
      kind: input.kind,
      sourceId: input.sourceId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      createdAt: Date.now(),
      expiresAt: Date.now() + cfg.requestTtlMs,
    })
  }

  function handleReply(input: {
    sourceId: string
    requestId: string
    sessionId?: string
    reply?: 'once' | 'always' | 'reject'
    answers?: string[][]
  }): { status: 'accepted' | 'failed' | 'expired'; message?: string } {
    const { sourceId, requestId, sessionId } = input

    if (!sourceId) {
      return { status: 'failed', message: 'sourceId missing' }
    }

    const key = pendingKey(sourceId, requestId)
    const pending = state.pendingRequests.get(key)

    if (!pending) {
      return { status: 'failed', message: 'pending request not found' }
    }

    if (pending.expiresAt < Date.now()) {
      state.pendingRequests.delete(key)
      return { status: 'expired', message: 'pending request expired' }
    }

    const reply: AdapterReply = {
      ackId: `ack_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      kind: pending.kind,
      sourceId,
      sessionId: sessionId ?? pending.sessionId,
      requestId,
      reply: input.reply,
      answers: input.answers,
      ts: Date.now(),
    }

    const queue = state.replyQueues.get(sourceId) ?? []
    queue.push(reply)
    state.replyQueues.set(sourceId, queue)
    state.pendingRequests.delete(key)

    return { status: 'accepted' }
  }

  function getReplies(sourceId: string): AdapterReply[] {
    const queue = state.replyQueues.get(sourceId) ?? []
    state.replyQueues.set(sourceId, [])
    return queue
  }

  function updateLastStatus(msg: Record<string, unknown>): void {
    if (msg['type'] !== 'status') return
    const sourceId = typeof msg['sourceId'] === 'string' ? msg['sourceId'] : ''
    const sessionIdRaw = msg['sessionId']
    const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw : ''
    if (!sourceId) return
    const key = `${sourceId}|${sessionId}`
    state.lastStatuses.set(key, {
      sourceId,
      sessionId: sessionId || undefined,
      status: (msg['status'] as AndonStatus) ?? 'IDLE',
      task: (msg['task'] as string) ?? '',
      duration: typeof msg['duration'] === 'number' ? msg['duration'] : 0,
      toolCount: typeof msg['toolCount'] === 'number' ? msg['toolCount'] : 0,
      errorCount: typeof msg['errorCount'] === 'number' ? msg['errorCount'] : 0,
      ts: Date.now(),
    })
  }

  function buildSnapshot(): SnapshotMessage {
    const sources: SnapshotMessage['sources'] = []
    for (const [sourceId, source] of state.sources) {
      let bestStatus: SourceStatusSnapshot | undefined
      for (const [, snap] of state.lastStatuses) {
        if (snap.sourceId === sourceId) {
          if (!bestStatus || snap.ts > bestStatus.ts) {
            bestStatus = snap
          }
        }
      }
      sources.push({
        sourceId,
        tool: source.tool,
        name: source.name,
        status: bestStatus,
      })
    }
    return { type: 'snapshot', sources }
  }

  function recordEvent(msg: ServerMessage): void {
    state.stats.eventsReceived++
    state.stats.lastEvent = msg
    state.stats.lastEventAt = Date.now()
  }

  return {
    state,
    registerSource,
    addPendingRequest,
    handleReply,
    getReplies,
    updateLastStatus,
    buildSnapshot,
    recordEvent,
    pendingKey,
    statusTimerKey,
  }
}

export type Hub = ReturnType<typeof createHub>
