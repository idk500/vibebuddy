/**
 * VibeCoding Companion Relay Server — Entry Point
 *
 * Starts HTTP server (optional static file serving) + WebSocket server.
 * Connects to OpenCode via SDK and relays events to phone clients.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import type {
  AdapterReply,
  ClientMessage,
  PendingRequest,
  RegisterSourceRequest,
  ServerConfig,
  ServerMessage,
  SourceInstance,
} from './types.js'
import { createOpenCodeRelay } from './opencode.js'

// ── Default configuration ───────────────────────────────

// Mutable OpenCode server URL — updated by plugin via /api/config
let opencodeServerUrl = process.env['VIBE_OPENCODE_URL'] ?? 'http://localhost:11434'
const REQUEST_TTL_MS = parseInt(process.env['VIBE_REQUEST_TTL_MS'] ?? '120000', 10)

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
  pendingRequests: Map<string, PendingRequest>
  replyQueues: Map<string, AdapterReply[]>
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
  console.log(`[vibe-companion] Starting server...`)
  console.log(`  Port:       ${config.port}`)
  console.log(`  OpenCode:   ${config.opencodeUrl}`)
  console.log(`  Static dir: ${config.staticDir ?? '(disabled)'}`)

  // Connected phone clients
  const clients = new Set<WebSocket>()
  const hub: RelayHubState = {
    sources: new Map<string, SourceInstance>(),
    pendingRequests: new Map<string, PendingRequest>(),
    replyQueues: new Map<string, AdapterReply[]>(),
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

    // Send connected message
    const connected: ServerMessage = {
      type: 'connected',
      serverVersion: '0.1.0',
      sessionId: null,
    }
    ws.send(JSON.stringify(connected))

    // Handle incoming messages from phone
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        handleBinaryMessage(data as Buffer, ws)
        return
      }
      handleTextMessage(Buffer.isBuffer(data) ? data.toString('utf-8') : typeof data === 'string' ? data : '', ws, clients, hub)
    })

    ws.on('close', () => {
      console.log(`[ws] Client disconnected: ${clientIp}`)
      clients.delete(ws)
    })

    ws.on('error', (err) => {
      console.error(`[ws] Client error: ${err.message}`)
      clients.delete(ws)
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

  wss.on('close', () => {
    clearInterval(pingInterval)
  })

  // Start HTTP server FIRST (don't block on OpenCode connection)
  httpServer.listen(config.port, '0.0.0.0', () => {
    console.log(`[vibe-companion] Ready at http://0.0.0.0:${config.port}`)
    console.log(`[vibe-companion] WebSocket at ws://0.0.0.0:${config.port}/ws`)
    console.log(`[vibe-companion] Open PWA on phone: http://<PC-IP>:${config.port}`)
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
      const sent = broadcast(clients, msg as ServerMessage)
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

  // Security: prevent path traversal
  let filePath = join(config.staticDir, urlPath === '/' ? 'index.html' : urlPath)

  // Normalize and check it's within staticDir
  if (!filePath.startsWith(config.staticDir)) {
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

function handleTextMessage(raw: string, _ws: WebSocket, clients: Set<WebSocket>, hub: RelayHubState): void {
  try {
    const msg = JSON.parse(raw) as ClientMessage
    console.log(`[ws] Received: ${msg.type}`)

    switch (msg.type) {
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
        handleReplyMessage(msg, clients, hub)
        break
      case 'question_reject':
        handleReplyMessage(msg, clients, hub)
        break
      case 'permission_reply':
        handleReplyMessage(msg, clients, hub)
        break
      default:
        console.warn(`[ws] Unknown message type: ${String((msg as Record<string, unknown>)['type'])}`)
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
  console.error('[vibe-companion] Fatal:', err)
  process.exit(1)
}
