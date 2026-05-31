/** VibeCoding Companion — OpenCode Plugin */

const RELAY_HOST = env("VIBE_RELAY_HOST") || "127.0.0.1:4097"
const RELAY_BASE = "http://" + RELAY_HOST
const REQUEST_TIMEOUT_MS = Number(env("VIBE_PERMISSION_TIMEOUT_MS") || "120000")
const POLL_INTERVAL_MS = Number(env("VIBE_REPLY_POLL_INTERVAL_MS") || "500")

function env(name) {
  try { return globalThis.process && globalThis.process.env && globalThis.process.env[name] } catch { return undefined }
}

function getProcessPid() {
  try { return globalThis.process && globalThis.process.pid ? String(globalThis.process.pid) : "nopid" } catch { return "nopid" }
}

function getCwd() {
  try { return globalThis.process && globalThis.process.cwd ? globalThis.process.cwd() : "" } catch { return "" }
}

function hashText(text) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

const CWD = getCwd()
const SOURCE_ID = "opencode:" + getProcessPid() + ":" + hashText(CWD || "unknown")

function now() { return Date.now() }

function normalizeSessionId(value) {
  return value && (value.sessionID || value.sessionId || (value.info && (value.info.sessionID || value.info.sessionId))) || "opencode"
}

function requestId(prefix, value) {
  return value && (value.id || value.requestID || value.requestId) || (prefix + "_" + now() + "_" + Math.random().toString(16).slice(2))
}

function withSource(msg, sessionId) {
  return Object.assign({ sourceId: SOURCE_ID }, sessionId ? { sessionId } : {}, msg)
}

function mapEvent(event) {
  const type = event.type
  const props = event.properties || {}
  const sessionId = normalizeSessionId(props)
  const messages = []

  switch (type) {
    case "session.status": {
      const status = props.status || {}
      if (status.type === "busy") messages.push(withSource({ type: "status", status: "THINKING", task: "Processing...", duration: 0, toolCount: 0, errorCount: 0 }, props.sessionID || sessionId))
      else if (status.type === "retry") messages.push(withSource({ type: "status", status: "THINKING", task: "Retry #" + (status.attempt || "?") + ": " + (status.message || ""), duration: 0, toolCount: 0, errorCount: 0 }, props.sessionID || sessionId))
      else messages.push(withSource({ type: "status", status: "IDLE", task: "Waiting for input", duration: 0, toolCount: 0, errorCount: 0 }, props.sessionID || sessionId))
      break
    }
    case "session.idle":
      messages.push(withSource({ type: "status", status: "IDLE", task: "Session idle", duration: 0, toolCount: 0, errorCount: 0 }, props.sessionID || sessionId))
      break
    case "session.error":
      messages.push(withSource({ type: "status", status: "ERROR", task: "Session error", duration: 0, toolCount: 0, errorCount: 1 }, props.sessionID || sessionId))
      messages.push(withSource({ type: "log", level: "error", message: "Session error", ts: now() }, sessionId))
      break
    case "message.updated": {
      const info = props.info || {}
      if (info.role === "assistant") {
        const completed = info.time && info.time.completed
        if (!completed) messages.push(withSource({ type: "status", status: "THINKING", task: "Generating response...", duration: 0, toolCount: 0, errorCount: 0 }, info.sessionID || sessionId))
      }
      break
    }
    case "message.part.updated": {
      const part = props.part || {}
      if (part.type !== "tool") break
      const toolName = part.tool || "unknown"
      const state = part.state || {}
      const stateStatus = state.status || ""
      if (stateStatus === "running") {
        messages.push(withSource({ type: "tool", name: toolName, status: "started", args: {}, title: state.title || "", ts: now() }, sessionId))
        messages.push(withSource({ type: "status", status: "EXECUTING", task: state.title || "Running: " + toolName, duration: 0, toolCount: 0, errorCount: 0 }, sessionId))
      } else if (stateStatus === "completed") messages.push(withSource({ type: "tool", name: toolName, status: "completed", args: {}, title: state.title || "", ts: now() }, sessionId))
      else if (stateStatus === "error") {
        messages.push(withSource({ type: "tool", name: toolName, status: "failed", args: {}, ts: now() }, sessionId))
        messages.push(withSource({ type: "log", level: "error", message: "Tool " + toolName + " failed", ts: now() }, sessionId))
      }
      break
    }
    case "file.edited":
      messages.push(withSource({ type: "log", level: "info", message: "File edited: " + (props.file || "?"), ts: now() }, sessionId))
      break
    case "session.created":
      messages.push(withSource({ type: "log", level: "info", message: "Session: " + ((props.info && props.info.title) || "new"), ts: now() }, sessionId))
      break
    case "session.diff": {
      const diff = props.diff || []
      messages.push(withSource({ type: "log", level: "info", message: "Diff: " + diff.length + " file" + (diff.length !== 1 ? "s" : ""), ts: now() }, sessionId))
      break
    }
    case "todo.updated": {
      const todos = props.todos || []
      const active = todos.filter(function(t) { return t.status === "in_progress" })
      if (active.length > 0) messages.push(withSource({ type: "log", level: "info", message: "TODO: " + active[0].content, ts: now() }, sessionId))
      break
    }
    case "question.asked": {
      const info = props.info || props
      const qSessionId = normalizeSessionId(info)
      messages.push(withSource({ type: "question", id: requestId("que", info), sessionID: qSessionId, questions: (info.questions || []).map(function(q) { return { header: q.header, question: q.question, options: q.options, multiple: q.multiple, custom: q.custom } }) }, qSessionId))
      messages.push(withSource({ type: "log", level: "warn", message: "Question: " + ((info.questions && info.questions[0] && info.questions[0].header) || ""), ts: now() }, qSessionId))
      break
    }
    case "permission.asked": {
      const perm = props.info || props
      const pSessionId = normalizeSessionId(perm)
      messages.push(withSource(permissionMessageFromInput(perm, pSessionId), pSessionId))
      messages.push(withSource({ type: "log", level: "warn", message: "Permission: " + (perm.tool || perm.name || "unknown"), ts: now() }, pSessionId))
      break
    }
  }
  return messages
}

function permissionMessageFromInput(input, sessionId) {
  return {
    type: "permission",
    id: requestId("per", input),
    sessionID: sessionId,
    tool: input.tool || input.name || (input.permission && input.permission.tool) || "unknown",
    message: input.message || input.description || input.pattern || "Allow this action?",
    patterns: input.patterns,
  }
}

async function postJson(path, msg) {
  try {
    const res = await fetch(RELAY_BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg) })
    return res.ok
  } catch {
    return false
  }
}

async function getJson(path) {
  try {
    const res = await fetch(RELAY_BASE + path)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function registerSource(serverUrl) {
  await postJson("/api/register", {
    sourceId: SOURCE_ID,
    tool: "opencode",
    name: "OpenCode " + getProcessPid(),
    serverUrl: serverUrl || "",
    cwd: CWD,
    capabilities: ["events", "permission.ask", "question.asked"],
  })
}

async function sendToRelay(messages) {
  for (const msg of messages) await postJson("/api/event", msg)
}

async function waitForPermissionReply(requestIdValue, deadline) {
  while (now() < deadline) {
    const data = await getJson("/api/replies?sourceId=" + encodeURIComponent(SOURCE_ID))
    const replies = data && Array.isArray(data.replies) ? data.replies : []
    for (const reply of replies) {
      if (reply && reply.kind === "permission" && reply.requestId === requestIdValue) return reply
    }
    await new Promise(function(resolve) { setTimeout(resolve, POLL_INTERVAL_MS) })
  }
  return null
}

async function handlePermissionAsk(input, output) {
  const permission = input && (input.permission || input)
  const sessionId = normalizeSessionId(permission)
  const msg = withSource(permissionMessageFromInput(permission, sessionId), sessionId)
  await sendToRelay([msg, withSource({ type: "log", level: "warn", message: "Permission waiting on phone: " + msg.tool, ts: now() }, sessionId)])

  const reply = await waitForPermissionReply(msg.id, now() + REQUEST_TIMEOUT_MS)
  if (!reply || reply.reply === "reject") {
    output.status = "deny"
    return
  }
  output.status = "allow"
}

export const VibeCompanion = async (input) => {
  const serverUrl = input && input.serverUrl
  const ocUrl = serverUrl ? serverUrl.toString() : ""
  await registerSource(ocUrl)
  if (ocUrl) await postJson("/api/config", { opencodeUrl: ocUrl, sourceId: SOURCE_ID })
  await sendToRelay([withSource({ type: "log", level: "info", message: "Plugin loaded OK, source=" + SOURCE_ID + ", server=" + ocUrl, ts: now() }, "opencode")])
  return {
    event: async ({ event }) => {
      const messages = mapEvent(event)
      if (messages.length > 0) await sendToRelay(messages)
    },
    "permission.ask": async (input, output) => {
      await handlePermissionAsk(input, output)
    },
  }
}
