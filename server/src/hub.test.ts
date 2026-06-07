/**
 * Relay Hub Unit Tests
 *
 * TC-U02: Reply routing isolation
 */

import { describe, it, expect, beforeEach } from 'vitest'

// ── Mock Hub Implementation ──────────────────────────────

interface PendingRequest {
  kind: 'permission' | 'question'
  sourceId: string
  sessionId?: string
  requestId: string
  createdAt: number
  expiresAt: number
}

interface AdapterReply {
  ackId: string
  kind: 'permission' | 'question'
  sourceId: string
  requestId: string
  reply?: 'once' | 'always' | 'reject'
  answers?: string[][]
  ts: number
}

interface ReplyResult {
  status: 'accepted' | 'failed' | 'expired'
  message?: string
}

interface HubOptions {
  ttlMs?: number
}

function createHub(options: HubOptions = {}) {
  const ttlMs = options.ttlMs ?? 120000
  const sources = new Set<string>()
  const pendingRequests = new Map<string, PendingRequest>()
  const replyQueues = new Map<string, AdapterReply[]>()

  function pendingKey(sourceId: string, requestId: string): string {
    return `${sourceId}:${requestId}`
  }

  function registerSource(input: { sourceId: string; tool?: string }): void {
    sources.add(input.sourceId)
    if (!replyQueues.has(input.sourceId)) {
      replyQueues.set(input.sourceId, [])
    }
  }

  function addPendingRequest(input: {
    sourceId: string
    requestId: string
    kind?: 'permission' | 'question'
    createdAt?: number
  }): void {
    const now = Date.now()
    pendingRequests.set(pendingKey(input.sourceId, input.requestId), {
      kind: input.kind ?? 'permission',
      sourceId: input.sourceId,
      requestId: input.requestId,
      createdAt: input.createdAt ?? now,
      expiresAt: (input.createdAt ?? now) + ttlMs,
    })
  }

  function handleReply(input: {
    sourceId: string
    requestId: string
    reply?: 'once' | 'always' | 'reject'
    answers?: string[][]
  }): ReplyResult {
    const { sourceId, requestId } = input

    // Validate sourceId exists
    if (!sourceId) {
      return { status: 'failed', message: 'sourceId missing' }
    }

    // Find pending request
    const key = pendingKey(sourceId, requestId)
    const pending = pendingRequests.get(key)

    if (!pending) {
      return { status: 'failed', message: 'pending request not found' }
    }

    // Check expiration
    if (pending.expiresAt < Date.now()) {
      pendingRequests.delete(key)
      return { status: 'expired', message: 'pending request expired' }
    }

    // Create reply
    const reply: AdapterReply = {
      ackId: `ack_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      kind: pending.kind,
      sourceId,
      requestId,
      reply: input.reply,
      answers: input.answers,
      ts: Date.now(),
    }

    // Queue reply
    const queue = replyQueues.get(sourceId) ?? []
    queue.push(reply)
    replyQueues.set(sourceId, queue)

    // Remove pending
    pendingRequests.delete(key)

    return { status: 'accepted' }
  }

  function getReplies(sourceId: string): AdapterReply[] {
    const queue = replyQueues.get(sourceId) ?? []
    replyQueues.set(sourceId, [])
    return queue
  }

  return {
    registerSource,
    addPendingRequest,
    handleReply,
    getReplies,
    hasSource: (id: string) => sources.has(id),
    hasPending: (sourceId: string, requestId: string) => 
      pendingRequests.has(pendingKey(sourceId, requestId)),
  }
}

// ── Tests ─────────────────────────────────────────────────

describe('ReplyRouter', () => {
  let hub: ReturnType<typeof createHub>

  beforeEach(() => {
    hub = createHub()
  })

  describe('routes reply to correct source', () => {
    it('routes to source A only', () => {
      hub.registerSource({ sourceId: 'opencode:A', tool: 'opencode' })
      hub.registerSource({ sourceId: 'zcode:B', tool: 'zcode' })

      hub.addPendingRequest({
        sourceId: 'opencode:A',
        requestId: 'req1',
      })

      const result = hub.handleReply({
        sourceId: 'opencode:A',
        requestId: 'req1',
        reply: 'once',
      })

      expect(result.status).toBe('accepted')

      const repliesA = hub.getReplies('opencode:A')
      const repliesB = hub.getReplies('zcode:B')

      expect(repliesA).toHaveLength(1)
      expect(repliesA[0]!.reply).toBe('once')
      expect(repliesB).toHaveLength(0)
    })

    it('routes multiple replies correctly', () => {
      hub.registerSource({ sourceId: 'opencode:A' })
      hub.registerSource({ sourceId: 'zcode:B' })

      hub.addPendingRequest({ sourceId: 'opencode:A', requestId: 'req1' })
      hub.addPendingRequest({ sourceId: 'zcode:B', requestId: 'req2' })

      hub.handleReply({ sourceId: 'opencode:A', requestId: 'req1', reply: 'once' })
      hub.handleReply({ sourceId: 'zcode:B', requestId: 'req2', reply: 'reject' })

      const repliesA = hub.getReplies('opencode:A')
      const repliesB = hub.getReplies('zcode:B')

      expect(repliesA).toHaveLength(1)
      expect(repliesA[0]!.reply).toBe('once')

      expect(repliesB).toHaveLength(1)
      expect(repliesB[0]!.reply).toBe('reject')
    })
  })

  describe('rejects reply with wrong sourceId', () => {
    it('returns failed when sourceId mismatch', () => {
      hub.registerSource({ sourceId: 'opencode:A' })
      hub.addPendingRequest({ sourceId: 'opencode:A', requestId: 'req1' })

      const result = hub.handleReply({
        sourceId: 'zcode:B',  // Wrong sourceId
        requestId: 'req1',
        reply: 'once',
      })

      expect(result.status).toBe('failed')
      expect(result.message).toContain('not found')
    })

    it('does not route to wrong source', () => {
      hub.registerSource({ sourceId: 'opencode:A' })
      hub.registerSource({ sourceId: 'zcode:B' })
      hub.addPendingRequest({ sourceId: 'opencode:A', requestId: 'req1' })

      hub.handleReply({ sourceId: 'zcode:B', requestId: 'req1', reply: 'once' })

      const repliesA = hub.getReplies('opencode:A')
      const repliesB = hub.getReplies('zcode:B')

      expect(repliesA).toHaveLength(0)
      expect(repliesB).toHaveLength(0)
    })
  })

  describe('rejects expired request', () => {
    it('returns expired for old request', () => {
      const shortHub = createHub({ ttlMs: 100 })
      shortHub.registerSource({ sourceId: 'opencode:A' })
      
      shortHub.addPendingRequest({
        sourceId: 'opencode:A',
        requestId: 'req1',
        createdAt: Date.now() - 200,  // 200ms ago
      })

      const result = shortHub.handleReply({
        sourceId: 'opencode:A',
        requestId: 'req1',
        reply: 'once',
      })

      expect(result.status).toBe('expired')
    })

    it('does not queue expired reply', () => {
      const shortHub = createHub({ ttlMs: 100 })
      shortHub.registerSource({ sourceId: 'opencode:A' })
      
      shortHub.addPendingRequest({
        sourceId: 'opencode:A',
        requestId: 'req1',
        createdAt: Date.now() - 200,
      })

      shortHub.handleReply({
        sourceId: 'opencode:A',
        requestId: 'req1',
        reply: 'once',
      })

      const replies = shortHub.getReplies('opencode:A')
      expect(replies).toHaveLength(0)
    })
  })

  describe('accepts valid reply', () => {
    it('returns accepted for valid reply', () => {
      hub.registerSource({ sourceId: 'opencode:A' })
      hub.addPendingRequest({ sourceId: 'opencode:A', requestId: 'req1' })

      const result = hub.handleReply({
        sourceId: 'opencode:A',
        requestId: 'req1',
        reply: 'always',
      })

      expect(result.status).toBe('accepted')
    })

    it('removes pending after reply', () => {
      hub.registerSource({ sourceId: 'opencode:A' })
      hub.addPendingRequest({ sourceId: 'opencode:A', requestId: 'req1' })

      expect(hub.hasPending('opencode:A', 'req1')).toBe(true)

      hub.handleReply({
        sourceId: 'opencode:A',
        requestId: 'req1',
        reply: 'once',
      })

      expect(hub.hasPending('opencode:A', 'req1')).toBe(false)
    })
  })

  describe('source isolation', () => {
    it('concurrent sources do not interfere', () => {
      hub.registerSource({ sourceId: 'opencode:A' })
      hub.registerSource({ sourceId: 'opencode:B' })

      hub.addPendingRequest({ sourceId: 'opencode:A', requestId: 'req1' })
      hub.addPendingRequest({ sourceId: 'opencode:B', requestId: 'req2' })

      // Reply to A
      hub.handleReply({ sourceId: 'opencode:A', requestId: 'req1', reply: 'once' })
      
      // Reply to B
      hub.handleReply({ sourceId: 'opencode:B', requestId: 'req2', reply: 'reject' })

      const repliesA = hub.getReplies('opencode:A')
      const repliesB = hub.getReplies('opencode:B')

      expect(repliesA).toHaveLength(1)
      expect(repliesA[0]!.reply).toBe('once')

      expect(repliesB).toHaveLength(1)
      expect(repliesB[0]!.reply).toBe('reject')
    })

    it('same requestId in different sources are isolated', () => {
      hub.registerSource({ sourceId: 'opencode:A' })
      hub.registerSource({ sourceId: 'opencode:B' })

      // Both have req1 but different sources
      hub.addPendingRequest({ sourceId: 'opencode:A', requestId: 'req1' })
      hub.addPendingRequest({ sourceId: 'opencode:B', requestId: 'req1' })

      hub.handleReply({ sourceId: 'opencode:A', requestId: 'req1', reply: 'once' })
      hub.handleReply({ sourceId: 'opencode:B', requestId: 'req1', reply: 'reject' })

      const repliesA = hub.getReplies('opencode:A')
      const repliesB = hub.getReplies('opencode:B')

      expect(repliesA).toHaveLength(1)
      expect(repliesA[0]!.reply).toBe('once')

      expect(repliesB).toHaveLength(1)
      expect(repliesB[0]!.reply).toBe('reject')
    })
  })
})
