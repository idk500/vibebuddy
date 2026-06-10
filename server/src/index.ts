/**
 * VibeBuddy Relay Server — Entry Point
 *
 * Starts HTTP server + WebSocket server.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type {
  RegisterSourceRequest,
  ServerConfig,
  ServerMessage,
} from './types.js'
import { createHub } from './hub.js'
import { createOpenCodeRelay } from './opencode.js'

// ── Configuration ────────────────────────────────────────

const REQUEST_TTL_MS = parseInt(process.env['VIBE_REQUEST_TTL_MS'] ?? '120000', 10)
const STATUS_SETTLE_MS = parseInt(process.env['VIBE_STATUS_SETTLE_MS'] ?? '20000', 10)

const DEFAULT_CONFIG: ServerConfig = {
  port: parseInt(process.env['VIBE_PORT'] ?? '4097', 10),
  opencodeUrl: process.env['VIBE_OPENCODE_URL'] ?? 'http://localhost:11434',
  staticDir: resolveStaticDir(),
  authToken: process.env['VIBE_AUTH_TOKEN'] ?? null,
}

function resolveStaticDir(): string | null {
  try {
    const candidate = join(import.meta.dirname, '..', '..', 'app')
    if (existsSync(candidate)) return candidate
  } catch { /* ignore */ }
  return null
}

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

// ── Main Entry ───────────────────────────────────────────

export function main(config: ServerConfig = DEFAULT_CONFIG): void {
  console.log(`[vibebuddy] Starting server...`)
  console.log(`  Port:       ${config.port}`)
  console.log(`  Static dir: ${config.staticDir ?? '(disabled)'}`)

  const hub = createHub({ requestTtlMs: REQUEST_TTL_MS, statusSettleMs: STATUS_SETTLE_MS })
  const clients = new Set<WebSocket>()

  const httpServer = createServer((req, res) => handleHttp(req, res, config, clients, hub))
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

  wss.on('connection', (ws, req) => handleWsConnection(ws, req, config, clients, hub))

  const pingInterval = setInterval(() => {
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.ping()
    }
  }, 30_000)

  const cleanupInterval = setInterval(() => {
    const now = Date.now()
    for (const [key, pending] of hub.state.pendingRequests) {
      if (pending.expiresAt < now) hub.state.pendingRequests.delete(key)
    }
    for (const [sourceId] of hub.state.replyQueues) {
      if (!hub.state.sources.has(sourceId)) hub.state.replyQueues.delete(sourceId)
    }
  }, 60_000)

  wss.on('close', () => {
    clearInterval(pingInterval)
    clearInterval(cleanupInterval)
  })

  httpServer.listen(config.port, '0.0.0.0', () => {
    console.log(`[vibebuddy] Ready at http://0.0.0.0:${config.port}`)
    console.log(`[vibebuddy] WebSocket at ws://0.0.0.0:${config.port}/ws`)
  })

  const relay = createOpenCodeRelay(config.opencodeUrl)
  relay.onEvent((message: ServerMessage) => {
    const sent = broadcast(clients, message)
    if (sent > 0) console.log(`[relay] → ${sent} client(s): ${message.type}`)
  })
  relay.connect().catch((err) => console.warn(`[opencode] ${String(err)}`))
}

// ── WebSocket Handler ─────────────────────────────────────

function handleWsConnection(
  ws: WebSocket,
  req: IncomingMessage,
  config: ServerConfig,
  clients: Set<WebSocket>,
  hub: ReturnType<typeof createHub>
): void {
  const clientIp = req.socket.remoteAddress ?? 'unknown'
  console.log(`[ws] Client connected: ${clientIp}`)

  if (config.authToken) {
    const url = new URL(req.url ?? '/', `http://${req.headers['host'] ?? 'localhost'}`)
    if (url.searchParams.get('token') !== config.authToken) {
      ws.close(4001, 'Unauthorized')
      return
    }
  }

  clients.add(ws)
  const terminalId = randomUUID()
  hub.state.terminals.set(terminalId, { id: terminalId, ws, type: 'unknown', connectedAt: Date.now() })

  ws.send(JSON.stringify({ type: 'connected', serverVersion: '0.1.0', sessionId: null, terminalId }))

  const snapshot = hub.buildSnapshot()
  if (snapshot.sources.length > 0) ws.send(JSON.stringify(snapshot))

  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    const raw = Buffer.isBuffer(data) ? data.toString('utf-8') : typeof data === 'string' ? data : ''
    handleWsMessage(raw, ws, clients, hub, terminalId)
  })

  ws.on('close', () => {
    console.log(`[ws] Client disconnected: ${clientIp}`)
    clients.delete(ws)
    hub.state.terminals.delete(terminalId)
  })

  ws.on('error', (err) => {
    console.error(`[ws] Error: ${err.message}`)
    clients.delete(ws)
    hub.state.terminals.delete(terminalId)
  })
}

function handleWsMessage(
  raw: string,
  _ws: WebSocket,
  clients: Set<WebSocket>,
  hub: ReturnType<typeof createHub>,
  terminalId: string
): void {
  let msg: Record<string, unknown>
  try { msg = JSON.parse(raw) as Record<string, unknown> } catch { return }

  const type = msg['type']
  console.log(`[ws] Received: ${String(type)} from ${terminalId}`)

  if (type === 'identify') {
    const terminal = hub.state.terminals.get(terminalId)
    if (terminal) {
      terminal.type = ['phone', 'desktop', 'ide', 'browser'].includes(msg['terminalType'] as string)
        ? msg['terminalType'] as 'phone' | 'desktop' | 'ide' | 'browser'
        : 'unknown'
      terminal.name = msg['terminalName'] as string | undefined
    }
    return
  }

  if (type === 'permission_reply' || type === 'question_reply' || type === 'question_reject') {
    const result = hub.handleReply({
      sourceId: msg['sourceId'] as string,
      requestId: msg['requestID'] as string,
      sessionId: msg['sessionId'] as string | undefined,
      reply: msg['reply'] as 'once' | 'always' | 'reject' | undefined,
      answers: msg['answers'] as string[][] | undefined,
    })
    broadcast(clients, {
      type: 'reply_ack',
      ackId: msg['ackId'] as string ?? `ack_${Date.now()}`,
      requestId: msg['requestID'] as string,
      sourceId: msg['sourceId'] as string,
      sessionId: msg['sessionId'] as string | undefined,
      status: result.status,
      message: result.message,
    })
  }
}

// ── HTTP Handler ──────────────────────────────────────────

function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  clients: Set<WebSocket>,
  hub: ReturnType<typeof createHub>
): void {
  const urlPath = req.url?.split('?')[0] ?? '/'

  // Short aliases for old devices
  if (urlPath === '/l' || urlPath === '/lite') {
    res.writeHead(302, { Location: '/legacy.html' })
    return void res.end()
  }

  if (urlPath === '/api/test' && req.method === 'POST') return handleApiTest(req, res, config, clients)
  if (urlPath === '/api/diagnostics' && req.method === 'GET') return handleApiDiagnostics(res, clients, hub)
  if (urlPath === '/api/poll' && req.method === 'GET') return handleApiPoll(res, hub)
  if (urlPath === '/api/register' && req.method === 'POST') return handleApiRegister(req, res, clients, hub)
  if (urlPath === '/api/event' && req.method === 'POST') return handleApiEvent(req, res, clients, hub)
  if (urlPath === '/api/replies' && req.method === 'GET') return handleApiReplies(req, res, hub)

  if (!config.staticDir) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    return void res.end('Not Found')
  }
  serveStatic(req, res, config.staticDir)
}

function handleApiTest(req: IncomingMessage, res: ServerResponse, config: ServerConfig, clients: Set<WebSocket>): void {
  if (config.authToken) {
    const token = (req.headers['authorization'] ?? '').replace('Bearer ', '')
    if (token !== config.authToken) return void writeJson(res, 401, { ok: false, error: 'unauthorized' })
  }
  readBody(req, res, (body) => {
    const sent = broadcast(clients, body as unknown as ServerMessage)
    writeJson(res, 200, { ok: true, sent })
  })
}

function handleApiDiagnostics(res: ServerResponse, clients: Set<WebSocket>, hub: ReturnType<typeof createHub>): void {
  writeJson(res, 200, {
    ok: true,
    clients: Array.from(clients).filter(c => c.readyState === c.OPEN).length,
    sources: Array.from(hub.state.sources.values()),
    pendingRequests: Array.from(hub.state.pendingRequests.values()),
    stats: hub.state.stats,
  })
}

function handleApiPoll(res: ServerResponse, hub: ReturnType<typeof createHub>): void {
  const sources: Array<{ sourceId: string; name: string; status: string; task: string; toolCount: number; errorCount: number }> = []
  for (const [sourceId, source] of hub.state.sources) {
    let bestStatus: { status: string; task: string; toolCount: number; errorCount: number } | undefined
    for (const [, snap] of hub.state.lastStatuses) {
      if (snap.sourceId === sourceId) {
        bestStatus = { status: snap.status, task: snap.task, toolCount: snap.toolCount, errorCount: snap.errorCount }
      }
    }
    sources.push({
      sourceId,
      name: source.name ?? sourceId.slice(0, 16),
      status: bestStatus?.status ?? 'IDLE',
      task: bestStatus?.task ?? '',
      toolCount: bestStatus?.toolCount ?? 0,
      errorCount: bestStatus?.errorCount ?? 0,
    })
  }
  // CORS for old browsers
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  })
  res.end(JSON.stringify({ ok: true, sources }))
}

function handleApiRegister(req: IncomingMessage, res: ServerResponse, clients: Set<WebSocket>, hub: ReturnType<typeof createHub>): void {
  readBody(req, res, (data) => {
    const input = data as unknown as RegisterSourceRequest
    if (!input?.sourceId) return void writeJson(res, 400, { ok: false, error: 'sourceId required' })
    const source = hub.registerSource(input)
    broadcast(clients, { type: 'source', sourceId: source.sourceId, tool: source.tool, name: source.name, status: 'registered', ts: Date.now() })
    writeJson(res, 200, { ok: true, sourceId: source.sourceId })
  })
}

function handleApiEvent(req: IncomingMessage, res: ServerResponse, clients: Set<WebSocket>, hub: ReturnType<typeof createHub>): void {
  readBody(req, res, (data) => {
    const msg = data
    if (typeof msg['type'] !== 'string') return void writeJson(res, 400, { ok: false, error: 'type required' })

    const sourceId = msg['sourceId'] as string | undefined
    if (sourceId && !hub.state.sources.has(sourceId)) {
      hub.registerSource({ sourceId })
    }

    if ((msg['type'] === 'permission' || msg['type'] === 'question') && sourceId && typeof msg['id'] === 'string') {
      hub.addPendingRequest({
        kind: msg['type'],
        sourceId,
        sessionId: msg['sessionId'] as string | undefined,
        requestId: msg['id'],
      })
    }

    hub.recordEvent(msg as unknown as ServerMessage)
    hub.updateLastStatus(msg)
    const sent = broadcast(clients, msg as unknown as ServerMessage)

    // Status settle timer
    if (msg['type'] === 'status') {
      const status = msg['status']
      if (status === 'THINKING' || status === 'EXECUTING') {
        const key = hub.statusTimerKey(sourceId, msg['sessionId'] as string | undefined)
        const existing = hub.state.statusTimers.get(key)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
          hub.state.statusTimers.delete(key)
          broadcast(clients, { type: 'status', sourceId, sessionId: msg['sessionId'] as string | undefined, status: 'IDLE', task: 'No recent activity', duration: 0, toolCount: 0, errorCount: 0 })
        }, STATUS_SETTLE_MS)
        hub.state.statusTimers.set(key, timer)
      }
    }

    console.log(`[hub] event ${String(msg['type'])} from ${sourceId ?? 'unknown'} → ${sent} client(s)`)
    writeJson(res, 200, { ok: true, sent })
  })
}

function handleApiReplies(req: IncomingMessage, res: ServerResponse, hub: ReturnType<typeof createHub>): void {
  const url = new URL(req.url ?? '/', `http://${req.headers['host'] ?? 'localhost'}`)
  const sourceId = url.searchParams.get('sourceId') ?? ''
  if (!sourceId) return void writeJson(res, 400, { ok: false, error: 'sourceId required' })
  const replies = hub.getReplies(sourceId)
  writeJson(res, 200, { ok: true, replies })
}

// ── Helpers ──────────────────────────────────────────────

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

function readBody(req: IncomingMessage, res: ServerResponse, onOk: (data: Record<string, unknown>) => void): void {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    try { onOk(body ? JSON.parse(body) as Record<string, unknown> : {}) }
    catch { writeJson(res, 400, { ok: false, error: 'invalid json' }) }
  })
}

function serveStatic(req: IncomingMessage, res: ServerResponse, staticDir: string): void {
  const urlPath = req.url?.split('?')[0] ?? '/'
  const normalized = resolve(staticDir)
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  let filePath = resolve(normalized, relative)

  if (!filePath.startsWith(normalized + sep) && filePath !== normalized) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    return void res.end('Forbidden')
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(staticDir, 'index.html')
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      return void res.end('Not Found')
    }
  }

  const ext = extname(filePath)
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'
  try {
    const content = readFileSync(filePath)
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' })
    res.end(content)
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Internal Server Error')
  }
}

// ── Start ─────────────────────────────────────────────────

try {
  main()
} catch (err) {
  console.error('[vibebuddy] Fatal:', err)
  process.exit(1)
}
