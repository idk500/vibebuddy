/**
 * Inject a deterministic stats event sequence into a running Relay Hub.
 *
 * Usage:
 *   node server/scripts/verify-stats-events.mjs [http://127.0.0.1:4097]
 */

const baseUrl = (process.argv[2] || 'http://127.0.0.1:4097').replace(/\/$/, '')
const sourceId = 'stats-verify'
const sessionId = 'stats-sequence'

const events = [
  { type: 'status', sourceId, sessionId, status: 'THINKING', task: 'Stats verification', duration: 0, toolCount: 0, errorCount: 0 },
  { type: 'tool', sourceId, sessionId, id: 'verify-tool-1', name: 'bash', status: 'started', args: {}, ts: 1780246000000 },
  { type: 'tool', sourceId, sessionId, id: 'verify-tool-1', name: 'bash', status: 'failed', args: {}, ts: 1780246001000 },
  { type: 'log', sourceId, sessionId, level: 'error', message: 'stats verification error', ts: 1780246002000 },
  { type: 'status', sourceId, sessionId, status: 'IDLE', task: 'Stats verification complete', duration: 0, toolCount: 0, errorCount: 0 },
]

async function postEvent(event) {
  const res = await fetch(`${baseUrl}/api/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })
  if (!res.ok) throw new Error(`POST /api/event failed: ${res.status} ${await res.text()}`)
  const body = await res.json()
  if (!body.ok) throw new Error(`POST /api/event returned not ok: ${JSON.stringify(body)}`)
  return body
}

async function getDiagnostics() {
  const res = await fetch(`${baseUrl}/api/diagnostics`)
  if (!res.ok) throw new Error(`GET /api/diagnostics failed: ${res.status} ${await res.text()}`)
  return await res.json()
}

for (const event of events) {
  const body = await postEvent(event)
  console.log(`${event.type}:${event.status || event.level} sent=${body.sent}`)
}

const diagnostics = await getDiagnostics()
if (!diagnostics.ok) throw new Error(`diagnostics not ok: ${JSON.stringify(diagnostics)}`)
if (diagnostics.stats?.lastEvent?.sourceId !== sourceId || diagnostics.stats?.lastEvent?.sessionId !== sessionId) {
  throw new Error(`unexpected lastEvent: ${JSON.stringify(diagnostics.stats?.lastEvent)}`)
}

console.log(`ok clients=${diagnostics.clients} eventsReceived=${diagnostics.stats.eventsReceived}`)
