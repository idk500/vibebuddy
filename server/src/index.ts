/**
 * VibeBuddy Relay Server — Entry Point
 *
 * Starts HTTP server (optional static file serving) + WebSocket server.
 * Connects to OpenCode via SDK and relays events to phone clients.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type {
  AdapterReply,
  AndonStatus,
  ClientMessage,
  PendingRequest,
  RegisterSourceRequest,
  ServerConfig,
  ServerMessage,
  SourceInstance,
  SourceStatusSnapshot,
  Terminal,
} from './types.js'
import { createOpenCodeRelay } from './opencode.js'

// ── Default configuration ───────────────────────────────

// Mutable OpenCode server URL — updated by plugin via /api/config
let opencodeServerUrl = process.env['VIBE_OPENCODE_URL'] ?? 'http://localhost:11434'
const REQUEST_TTL_MS = parseInt(process.env['VIBE_REQUEST_TTL_MS'] ?? '120000', 10)
const STATUS_SETTLE_MS = parseInt(process.env['VIBE_STATUS_SETTLE_MS'] ?? '20000', 10)

const DEFAULT_CONFIG: ServerConfig = {
  port: parseInt(process.env['VIBE_PORT'] ?? '4097', 10),
  opencodeUrl: opencodeServerUrl,
  staticDir: process.env['VIBE_STATIC_DIR'] ?? resolveStaticDir(),
  authToken: process.env['VIBE_AUTH_TOKEN'] ?? null,
}

function resolveStaticDir(): string | null {
  const candidate = join(import.meta.dirname, '..', '..', 'app')
  if (existsSync(candidate)) {
    return candidate
  }
  return null
}

// ── MIME types for static serving ───────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
}

interface RelayHubState {
  sources: Map<string, SourceInstance>
  terminals: Map<string, Terminal>
  pendingRequests: Map<string, PendingRequest>
  replyQueues: Map<string, AdapterReply[]>
  statusTimers: Map<string, ReturnType<typeof setTimeout>>
  /** Last status per sourceId|sessionId for snapshot replay */
  lastStatuses: Map<string, SourceStatusSnapshot>
  stats: {
    startedAt: number
    eventsReceived: number
    lastEvent: ServerMessage | null
    lastEventAt: number | null
  }
}

function pendingKey(sourceId: string, requestId: string): string {
  return `${sourceId}:${requestId}`
}

// ── Main ────────────────────────────────────────────────

export function main(config: ServerConfig = DEFAULT_CONFIG): void {
  console.log(`[vibebuddy] Starting server...`)
  console.log(`  Port:       ${config.port}`)
  console.log(`  OpenCode:   ${config.opencodeUrl}`)
  console.log(`  Static dir: ${config.staticDir ?? '(disabled)'}`)

  // Connected phone clients
  const clients = new Set<WebSocket>()
  const hub: RelayHubState = {
    sources: new Map<string, SourceInstance>(),
    terminals: new Map<string, Terminal>(),
    pendingRequests: new Map<string, PendingRequest>(),
    replyQueues: new Map<string, AdapterReply[]>(),
    statusTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    lastStatuses: new Map<string, SourceStatusSnapshot>(),
    stats: {
      startedAt: Date.now(),
      eventsReceived: 0,
      lastEvent: null,
      lastEventAt: null,
    },
  }

  // Create HTTP server (optional static files)
  const httpServer = createServer((req, res) => {
    handleHttpRequest(req, res, config, clients, hub)
  })

  // Create WebSocket server on same port
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

  wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress ?? 'unknown'
    console.log(`[ws] Client connected: ${clientIp}`)

    // Optional token auth
    if (config.authToken) {
      const url = new URL(req.url ?? '/', `http://${req.headers['host'] ?? 'localhost'}`)
      const token = url.searchParams.get('token')
      if (token !== config.authToken) {
        console.log(`[ws] Auth failed for ${clientIp}`)
        ws.close(4001, 'Unauthorized')
        return
      }
    }

    clients.add(ws)

    // Create Terminal identity
    const terminalId = randomUUID()
    const terminal: Terminal = {
      id: terminalId,
      ws,
      type: 'unknown',
      connectedAt: Date.now(),
    }
    hub.terminals.set(terminalId, terminal)

    // Send connected message with terminalId
    const connected: ServerMessage = {
      type: 'connected',
      serverVersion: '0.1.0',  // VibeBuddy
      sessionId: null,
    }
    ws.send(JSON.stringify({ ...connected, terminalId }))

    // Send state snapshot: all known sources + their last status
    const snapshot = buildSnapshot(hub)
    if (snapshot.sources.length > 0) {
      ws.send(JSON.stringify(snapshot))
    }

    // Handle incoming messages from phone
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        handleBinaryMessage(data as Buffer, ws)
        return
      }
      handleTextMessage(Buffer.isBuffer(data) ? data.toString('utf-8') : typeof data === 'string' ? data : '', ws, clients, hub, terminalId)
    })

    ws.on('close', () => {
      console.log(`[ws] Client disconnected: ${clientIp} (${terminalId})`)
      clients.delete(ws)
      hub.terminals.delete(terminalId)
    })

    ws.on('error', (err) => {
      console.error(`[ws] Client error: ${err.message}`)
      clients.delete(ws)
      hub.terminals.delete(terminalId)
    })

    // Keepalive ping
    ws.on('pong', () => {
      // Connection alive
    })
  })

  // Ping all clients every 30s
  const pingInterval = setInterval(() => {
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.ping()
      }
    }
  }, 30_000)

  // Cleanup expired pendingRequests and stale replyQueues every 60s
  const cleanupInterval = setInterval(() => {
    const now = Date.now()
    for (const [key, pending] of hub.pendingRequests) {
      if (pending.expiresAt < now) {
        hub.pendingRequests.delete(key)
      }
    }
    for (const [sourceId] of hub.replyQueues) {
      if (!hub.sources.has(sourceId)) {
        hub.replyQueues.delete(sourceId)
      }
    }
  }, 60_000)

  wss.on('close', () => {
    clearInterval(pingInterval)
    clearInterval(cleanupInterval)
  })

  // Start HTTP server FIRST (don't block on OpenCode connection)
  httpServer.listen(config.port, '0.0.0.0', () => {
    console.log(`[vibebuddy] Ready at http://0.0.0.0:${config.port}`)
    console.log(`[vibebuddy] WebSocket at ws://0.0.0.0:${config.port}/ws`)
    console.log(`[vibebuddy] Open PWA on phone: http://<PC-IP>:${config.port}`)
  })

  // Connect to OpenCode event stream in background (non-blocking)
  const relay = createOpenCodeRelay(config.opencodeUrl)
  relay.onEvent((message: ServerMessage) => {
    const json = JSON.stringify(message)
    let sent = 0
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(json)
        sent++
      }
    }
    if (sent > 0) {
      console.log(`[relay] → ${sent} client(s): ${message.type}`)
    }
  })

  // Fire-and-forget: connect to OpenCode in background
  relay.connect().then(() => {
    console.log(`[opencode] Connected to event stream`)
  }).catch((err: unknown) => {
    console.warn(`[opencode] Connection failed: ${(err as Error).message}`)
    console.warn(`[opencode] Will retry in background...`)
  })
}

// ── Snapshot builder ──────────────────────────────────────

function buildSnapshot(hub: RelayHubState): import('./types.js').SnapshotMessage {
  const sources: import('./types.js').SnapshotMessage['sources'] = []
  for (const [sourceId, source] of hub.sources) {
    // Find the most recent status for this source
    let bestStatus: SourceStatusSnapshot | undefined
    for (const [, snap] of hub.lastStatuses) {
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

function updateLastStatus(msg: Record<string, unknown>, hub: RelayHubState): void {
  if (msg['type'] !== 'status') return
  const sourceId = typeof msg['sourceId'] === 'string' ? msg['sourceId'] : ''
  const sessionId = typeof msg['sessionId'] === 'string' ? msg['sessionId'] : typeof msg['sessionID'] === 'string' ? msg['sessionID'] as string : ''
  if (!sourceId) return
  const key = `${sourceId}|${sessionId}`
  hub.lastStatuses.set(key, {
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

// ── HTTP request handler (static files) ─────────────────

function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  clients: Set<WebSocket>,
  hub: RelayHubState,
): void {
  const urlPath = req.url?.split('?')[0] ?? '/'

  // ── Test endpoint: inject a fake event to all connected phones ──
  if (urlPath === '/api/test' && req.method === 'POST') {
    if (config.authToken) {
      const authHeader = req.headers['authorization'] ?? ''
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
      if (token !== config.authToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end('{"error":"unauthorized"}')
        return
      }
    }
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      let testEvent: Record<string, unknown>
      try {
        testEvent = body ? JSON.parse(body) as Record<string, unknown> : {}
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end('{"error":"invalid json"}')
        return
      }
      const msg = JSON.stringify(testEvent)
      let sent = 0
      for (const wsClient of clients) {
        if (wsClient.readyState === wsClient.OPEN) {
          wsClient.send(msg)
          sent++
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(`{"sent":${sent}}`)
    })
    return
  }

  // ── Diagnostics endpoint: inspect current hub state ───
  if (urlPath === '/api/diagnostics' && req.method === 'GET') {
    writeJson(res, 200, {
      ok: true,
      clients: Array.from(clients).filter((client) => client.readyState === client.OPEN).length,
      sources: Array.from(hub.sources.values()),
      pendingRequests: Array.from(hub.pendingRequests.values()),
      replyQueues: Array.from(hub.replyQueues.entries()).map(([sourceId, replies]) => ({ sourceId, count: replies.length })),
      stats: hub.stats,
    })
    return
  }

  // ── Adapter registration endpoint ─────────────────────
  if (urlPath === '/api/register' && req.method === 'POST') {
    readJsonBody(req, res, (data) => {
      const source = registerSource(data as unknown as RegisterSourceRequest, hub)
      if (!source) {
        writeJson(res, 400, { error: 'sourceId required' })
        return
      }
      broadcast(clients, {
        type: 'source',
        sourceId: source.sourceId,
        tool: source.tool,
        name: source.name,
        status: 'registered',
        ts: Date.now(),
      })
      writeJson(res, 200, { ok: true, sourceId: source.sourceId })
    })
    return
  }

  // ── Adapter event endpoint ────────────────────────────
  if (urlPath === '/api/event' && req.method === 'POST') {
    readJsonBody(req, res, (data) => {
      const msg = data as Partial<ServerMessage> & Record<string, unknown>
      if (typeof msg.type !== 'string') {
        writeJson(res, 400, { error: 'type required' })
        return
      }

      const sourceId = typeof msg.sourceId === 'string' ? msg.sourceId : undefined
      if (sourceId && !hub.sources.has(sourceId)) {
        registerSource({ sourceId, tool: 'unknown', name: sourceId }, hub)
      }

      if ((msg.type === 'permission' || msg.type === 'question') && sourceId && typeof msg.id === 'string') {
        const sessionId = normalizeSessionId(msg)
        hub.pendingRequests.set(pendingKey(sourceId, msg.id), {
          kind: msg.type,
          sourceId,
          sessionId,
          requestId: msg.id,
          createdAt: Date.now(),
          expiresAt: Date.now() + REQUEST_TTL_MS,
        })
      }

      hub.stats.eventsReceived++
      hub.stats.lastEvent = msg as ServerMessage
      hub.stats.lastEventAt = Date.now()
      updateLastStatus(msg, hub)
      const sent = broadcast(clients, msg as ServerMessage)
      settleStatusAfterInactivity(msg, clients, hub)
      console.log(`[hub] event ${msg.type} from ${sourceId ?? 'unknown'} → ${sent} client(s)`)
      writeJson(res, 200, { ok: true, sent })
    })
    return
  }

  // ── Adapter reply polling endpoint ────────────────────
  if (urlPath === '/api/replies' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', `http://${req.headers['host'] ?? 'localhost'}`)
    const sourceId = url.searchParams.get('sourceId') ?? ''
    if (!sourceId) {
      writeJson(res, 400, { error: 'sourceId required' })
      return
    }
    const queue = hub.replyQueues.get(sourceId) ?? []
    hub.replyQueues.set(sourceId, [])
    writeJson(res, 200, { ok: true, replies: queue })
    return
  }

  // ── Config endpoint: plugin registers its OpenCode server URL ──
  if (urlPath === '/api/config' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      try {
        const data = JSON.parse(body) as Record<string, unknown>
        if (data.opencodeUrl && typeof data.opencodeUrl === 'string') {
          opencodeServerUrl = data.opencodeUrl
          console.log(`[config] OpenCode server URL updated: ${opencodeServerUrl}`)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end('{"error":"invalid json"}')
      }
    })
    return
  }

  if (!config.staticDir) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Static serving disabled')
    return
  }

  // Security: prevent path traversal using resolve + normalize
  const normalizedStatic = resolve(config.staticDir)
  // Strip leading slash so resolve treats it as relative to staticDir
  const relativePath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  let filePath = resolve(normalizedStatic, relativePath)

  if (!filePath.startsWith(normalizedStatic + sep) && filePath !== normalizedStatic) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('Forbidden')
    return
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback: serve index.html for unknown routes
    filePath = join(config.staticDir, 'index.html')
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
      return
    }
  }

  const ext = extname(filePath)
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'

  try {
    const content = readFileSync(filePath)
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache, no-store, must-revalidate' })
    res.end(content)
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Internal Server Error')
  }
}

// ── Client message handlers ─────────────────────────────

function handleTextMessage(raw: string, _ws: WebSocket, clients: Set<WebSocket>, hub: RelayHubState, terminalId: string): void {
  try {
    const msg = JSON.parse(raw) as ClientMessage | { type: 'identify'; terminalType?: string; terminalName?: string }
    console.log(`[ws] Received: ${(msg as Record<string, unknown>)['type']} from ${terminalId}`)

    // Handle terminal identity
    if ((msg as Record<string, unknown>)['type'] === 'identify') {
      const idMsg = msg as { type: 'identify'; terminalType?: string; terminalName?: string }
      const terminal = hub.terminals.get(terminalId)
      if (terminal) {
        terminal.type = (['phone', 'desktop', 'ide', 'browser'].includes(idMsg.terminalType ?? '') ? idMsg.terminalType : 'unknown') as Terminal['type']
        terminal.name = idMsg.terminalName
        console.log(`[ws] Terminal ${terminalId} identified as ${terminal.type} (${terminal.name ?? 'unnamed'})`)
      }
      return
    }

    const clientMsg = msg as ClientMessage
    switch (clientMsg.type) {
      case 'voice_start':
        // Phase 2: handle voice start
        break
      case 'voice_stop':
        // Phase 2: handle voice stop
        break
      case 'command':
        // Handle commands (list_sessions, etc.)
        break
      case 'question_reply':
        handleReplyMessage(clientMsg, clients, hub)
        break
      case 'question_reject':
        handleReplyMessage(clientMsg, clients, hub)
        break
      case 'permission_reply':
        handleReplyMessage(clientMsg, clients, hub)
        break
      default:
        console.warn(`[ws] Unknown message type: ${String((clientMsg as Record<string, unknown>)['type'])}`)
    }
  } catch {
    console.warn('[ws] Invalid JSON message')
  }
}

function handleReplyMessage(msg: ClientMessage, clients: Set<WebSocket>, hub: RelayHubState): void {
  if (msg.type !== 'question_reply' && msg.type !== 'question_reject' && msg.type !== 'permission_reply') return

  const ackId = msg.ackId ?? `ack_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const requestId = msg.requestID
  const sourceId = msg.sourceId
  const sessionId = msg.sessionId

  if (!sourceId) {
    broadcastReplyAck(clients, { ackId, requestId, sourceId, sessionId, status: 'failed', message: 'sourceId missing' })
    return
  }

  const key = pendingKey(sourceId, requestId)
  const pending = hub.pendingRequests.get(key)
  if (!pending) {
    broadcastReplyAck(clients, { ackId, requestId, sourceId, sessionId, status: 'failed', message: 'pending request not found' })
    return
  }

  if (pending.expiresAt < Date.now()) {
    hub.pendingRequests.delete(key)
    broadcastReplyAck(clients, { ackId, requestId, sourceId, sessionId, status: 'expired', message: 'pending request expired' })
    return
  }

  const reply: AdapterReply = {
    ackId,
    kind: pending.kind,
    sourceId,
    sessionId: sessionId ?? pending.sessionId,
    requestId,
    ts: Date.now(),
  }

  if (msg.type === 'permission_reply') {
    reply.reply = msg.reply
  } else if (msg.type === 'question_reply') {
    reply.answers = msg.answers
  } else {
    reply.answers = []
  }

  const queue = hub.replyQueues.get(sourceId) ?? []
  queue.push(reply)
  hub.replyQueues.set(sourceId, queue)
  hub.pendingRequests.delete(key)

  broadcastReplyAck(clients, { ackId, requestId, sourceId, sessionId: reply.sessionId, status: 'accepted' })
}

function broadcastReplyAck(
  clients: Set<WebSocket>,
  ack: Omit<Extract<ServerMessage, { type: 'reply_ack' }>, 'type'>,
): void {
  broadcast(clients, { type: 'reply_ack', ...ack })
}

function registerSource(input: RegisterSourceRequest, hub: RelayHubState): SourceInstance | null {
  if (!input || typeof input.sourceId !== 'string' || input.sourceId.length === 0) return null
  const existing = hub.sources.get(input.sourceId)
  const source: SourceInstance = {
    sourceId: input.sourceId,
    tool: input.tool ?? existing?.tool ?? 'unknown',
    name: input.name ?? existing?.name ?? input.sourceId,
    serverUrl: input.serverUrl ?? existing?.serverUrl,
    cwd: input.cwd ?? existing?.cwd,
    capabilities: Array.isArray(input.capabilities) ? input.capabilities : existing?.capabilities ?? [],
    lastSeen: Date.now(),
  }
  hub.sources.set(source.sourceId, source)
  if (!hub.replyQueues.has(source.sourceId)) hub.replyQueues.set(source.sourceId, [])
  console.log(`[hub] source registered: ${source.sourceId} (${source.tool})`)
  return source
}

function normalizeSessionId(msg: Record<string, unknown>): string | undefined {
  const sessionId = msg['sessionId'] ?? msg['sessionID']
  return typeof sessionId === 'string' ? sessionId : undefined
}

function statusTimerKey(sourceId: string | undefined, sessionId: string | undefined): string {
  return `${sourceId ?? 'unknown'}:${sessionId ?? 'default'}`
}

function settleStatusAfterInactivity(
  msg: Partial<ServerMessage> & Record<string, unknown>,
  clients: Set<WebSocket>,
  hub: RelayHubState,
): void {
  if (msg.type !== 'status') return

  const sourceId = typeof msg.sourceId === 'string' ? msg.sourceId : undefined
  const sessionId = normalizeSessionId(msg)
  const key = statusTimerKey(sourceId, sessionId)
  const existing = hub.statusTimers.get(key)
  if (existing) {
    clearTimeout(existing)
    hub.statusTimers.delete(key)
  }

  const status = msg.status
  if (status !== 'THINKING' && status !== 'EXECUTING') return

  const timer = setTimeout(() => {
    hub.statusTimers.delete(key)
    const idle: ServerMessage = {
      type: 'status',
      sourceId,
      sessionId,
      status: 'IDLE',
      task: 'No recent activity',
      duration: 0,
      toolCount: typeof msg.toolCount === 'number' ? msg.toolCount : 0,
      errorCount: typeof msg.errorCount === 'number' ? msg.errorCount : 0,
    }
    const sent = broadcast(clients, idle)
    hub.stats.lastEvent = idle
    hub.stats.lastEventAt = Date.now()
    console.log(`[hub] status settled ${key} → IDLE after ${STATUS_SETTLE_MS}ms (${sent} client(s))`)
  }, STATUS_SETTLE_MS)
  hub.statusTimers.set(key, timer)
}

function broadcast(clients: Set<WebSocket>, message: ServerMessage): number {
  const json = JSON.stringify(message)
  let sent = 0
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(json)
      sent++
    }
  }
  return sent
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readJsonBody(req: IncomingMessage, res: ServerResponse, onOk: (data: Record<string, unknown>) => void): void {
  let body = ''
  req.on('data', (chunk: Buffer) => { body += chunk.toString() })
  req.on('end', () => {
    try {
      onOk(body ? JSON.parse(body) as Record<string, unknown> : {})
    } catch {
      writeJson(res, 400, { error: 'invalid json' })
    }
  })
}

function handleBinaryMessage(_data: Buffer, _ws: WebSocket): void {
  // Phase 2: handle audio binary frames
  // Format: 1 byte type (0x01=audio) + 4 byte sequence + payload
}

// ── Start ───────────────────────────────────────────────

try {
  main()
} catch (err) {
  console.error('[vibebuddy] Fatal:', err)
  process.exit(1)
}
