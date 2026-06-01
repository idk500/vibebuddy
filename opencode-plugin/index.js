/** VibeCoding Companion — OpenCode Plugin */

const RELAY_HOST = env("VIBE_RELAY_HOST") || "127.0.0.1:4097"
const RELAY_BASE = "http://" + RELAY_HOST
const REQUEST_TIMEOUT_MS = Number(env("VIBE_PERMISSION_TIMEOUT_MS") || "120000")
const POLL_INTERVAL_MS = Number(env("VIBE_REPLY_POLL_INTERVAL_MS") || "500")
const REGISTER_INTERVAL_MS = Number(env("VIBE_REGISTER_INTERVAL_MS") || "15000")
const FORCE_TOOL_APPROVAL = env("VIBE_FORCE_TOOL_APPROVAL") === "1" || env("VIBE_FORCE_TOOL_APPROVAL") === "true"

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

function eventTypeOf(input) {
  return input && (input.type || input.eventType || input.name || "unknown")
}

function eventPropsOf(input) {
  return input && (input.properties || input.props || input.payload || input.data || {})
}

function summarizeEvent(input) {
  const type = eventTypeOf(input)
  const props = eventPropsOf(input)
  const keys = props && typeof props === "object" ? Object.keys(props).slice(0, 6).join(",") : ""
  return "OpenCode event: " + type + (keys ? " {" + keys + "}" : "")
}

function isCompleteInfo(info) {
  if (!info) return false
  if (info.time && info.time.completed) return true
  if (info.completed || info.done || info.finished) return true
  const status = String(info.status || info.state || "").toLowerCase()
  return status === "complete" || status === "completed" || status === "done" || status === "idle"
}

function isAssistantInfo(info) {
  if (!info) return false
  return info.role === "assistant" || info.role === undefined
}

function toolPartName(part) {
  return part && (part.tool || part.name || part.toolName || part.id || (part.state && (part.state.tool || part.state.name || part.state.toolName))) || "unknown"
}

function toolPartStatus(part) {
  const raw = part && ((part.state && (part.state.status || part.state.type)) || part.status || part.state || part.phase || "")
  const status = String(raw).toLowerCase()
  if (status === "running" || status === "starting" || status === "pending" || status === "in_progress" || status === "started") return "started"
  if (status === "completed" || status === "complete" || status === "done" || status === "success" || status === "finished") return "completed"
  if (status === "error" || status === "failed" || status === "failure") return "failed"
  return ""
}

function isToolPart(part) {
  if (!part) return false
  if (part.type === "tool" || part.type === "tool_call" || part.type === "tool-result") return true
  return !!(part.tool || part.toolName || (part.state && (part.state.tool || part.state.toolName)))
}

function mapEvent(event) {
  const type = eventTypeOf(event)
  const props = eventPropsOf(event)
  const sessionId = normalizeSessionId(props)
  const messages = []

  messages.push(withSource({ type: "log", level: "info", message: summarizeEvent(event), ts: now() }, sessionId))

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
      if (isAssistantInfo(info)) {
        const completed = isCompleteInfo(info)
        if (!completed) messages.push(withSource({ type: "status", status: "THINKING", task: "Generating response...", duration: 0, toolCount: 0, errorCount: 0 }, info.sessionID || sessionId))
        else messages.push(withSource({ type: "status", status: "IDLE", task: "Response complete", duration: 0, toolCount: 0, errorCount: 0 }, info.sessionID || sessionId))
      }
      break
    }
    case "message.part.updated": {
      const part = props.part || {}
      if (!isToolPart(part)) break
      const toolName = toolPartName(part)
      const state = part.state || {}
      const stateStatus = toolPartStatus(part)
      const toolId = part.id || part.toolCallId || part.callId
      if (stateStatus === "started") {
        messages.push(withSource({ type: "tool", id: toolId, name: toolName, status: "started", args: {}, title: state.title || part.title || "", ts: now() }, sessionId))
        messages.push(withSource({ type: "status", status: "EXECUTING", task: state.title || "Running: " + toolName, duration: 0, toolCount: 0, errorCount: 0 }, sessionId))
      } else if (stateStatus === "completed") messages.push(withSource({ type: "tool", id: toolId, name: toolName, status: "completed", args: {}, title: state.title || part.title || "", ts: now() }, sessionId))
      else if (stateStatus === "failed") {
        messages.push(withSource({ type: "tool", id: toolId, name: toolName, status: "failed", args: {}, ts: now() }, sessionId))
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
    default: {
      if (type.indexOf("tool") >= 0) {
        messages.push(withSource({ type: "status", status: "EXECUTING", task: type, duration: 0, toolCount: 0, errorCount: 0 }, sessionId))
      } else if (type.indexOf("idle") >= 0 || type.indexOf("complete") >= 0 || type.indexOf("completed") >= 0) {
        messages.push(withSource({ type: "status", status: "IDLE", task: type, duration: 0, toolCount: 0, errorCount: 0 }, sessionId))
      }
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

function toolApprovalMessageFromInput(input, sessionId) {
  const tool = input && (input.tool || input.name || input.toolName || (input.part && (input.part.tool || input.part.name)) || (input.call && (input.call.tool || input.call.name))) || "tool"
  const title = input && (input.title || input.description || (input.state && input.state.title) || (input.part && input.part.title))
  return {
    type: "permission",
    id: requestId("tool", input),
    sessionID: sessionId,
    tool: tool,
    message: title || "Allow tool execution: " + tool,
    patterns: input && input.patterns,
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
  return await postJson("/api/register", {
    sourceId: SOURCE_ID,
    tool: "opencode",
    name: "OpenCode " + getProcessPid(),
    serverUrl: serverUrl || "",
    cwd: CWD,
    capabilities: ["events", "permission.ask", "question.asked"],
  })
}

function startRegisterHeartbeat(serverUrl) {
  try {
    if (typeof setInterval !== "function") return
    setInterval(function() { registerSource(serverUrl) }, REGISTER_INTERVAL_MS)
  } catch {}
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

async function handleToolExecuteBefore(input, output) {
  if (!FORCE_TOOL_APPROVAL) return
  const sessionId = normalizeSessionId(input)
  const msg = withSource(toolApprovalMessageFromInput(input, sessionId), sessionId)
  await sendToRelay([msg, withSource({ type: "log", level: "warn", message: "Tool approval waiting on phone: " + msg.tool, ts: now() }, sessionId)])

  const reply = await waitForPermissionReply(msg.id, now() + REQUEST_TIMEOUT_MS)
  if (!reply || reply.reply === "reject") {
    throw new Error("Tool execution denied by Vibe Companion")
  }
}

export const VibeCompanion = async (input) => {
  const serverUrl = input && input.serverUrl
  const ocUrl = serverUrl ? serverUrl.toString() : ""
  await registerSource(ocUrl)
  startRegisterHeartbeat(ocUrl)
  if (ocUrl) await postJson("/api/config", { opencodeUrl: ocUrl, sourceId: SOURCE_ID })
  await sendToRelay([withSource({ type: "log", level: "info", message: "Plugin loaded OK, source=" + SOURCE_ID + ", server=" + ocUrl, ts: now() }, "opencode")])
  return {
    event: async (input) => {
      const actualEvent = input && input.event ? input.event : input
      const messages = mapEvent(actualEvent)
      if (messages.length > 0) await sendToRelay(messages)
    },
    "permission.ask": async (input, output) => {
      await handlePermissionAsk(input, output)
    },
    "tool.execute.before": async (input, output) => {
      await handleToolExecuteBefore(input, output)
    },
  }
}
