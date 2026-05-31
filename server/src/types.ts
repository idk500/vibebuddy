/**
 * Shared type definitions for VibeCoding Companion
 */

// ── Andon Status ────────────────────────────────────────

export type AndonStatus =
  | 'DISCONNECTED'
  | 'IDLE'
  | 'THINKING'
  | 'EXECUTING'
  | 'ERROR'
  | 'COMPLETE'

export interface StatusUpdate {
  type: 'status'
  status: AndonStatus
  task: string
  duration: number
  toolCount: number
  errorCount: number
  sourceId?: string
  sessionId?: string
}

export interface ToolEvent {
  type: 'tool'
  id?: string
  name: string
  status: 'started' | 'completed' | 'failed'
  args: Record<string, unknown>
  ts: number
  title?: string
  sourceId?: string
  sessionId?: string
}

export interface LogEntry {
  type: 'log'
  level: 'info' | 'warn' | 'error'
  message: string
  ts: number
  sourceId?: string
  sessionId?: string
}

export interface ConnectedMessage {
  type: 'connected'
  serverVersion: string
  sessionId: string | null
}

export interface SourceMessage {
  type: 'source'
  sourceId: string
  tool: string
  name: string
  status: 'registered' | 'updated' | 'stale'
  ts: number
}

export interface QuestionMessage {
  type: 'question'
  id: string
  sourceId?: string
  sessionID: string
  sessionId?: string
  questions: Array<{
    header: string
    question: string
    options: Array<{ label: string; description: string }>
    multiple?: boolean
    custom?: boolean
  }>
}

export interface PermissionMessage {
  type: 'permission'
  id: string
  sourceId?: string
  sessionID: string
  sessionId?: string
  tool: string
  message: string
  patterns?: string[]
}

export interface ReplyAckMessage {
  type: 'reply_ack'
  ackId: string
  requestId: string
  sourceId?: string
  sessionId?: string
  status: 'accepted' | 'failed' | 'expired'
  message?: string
}

/** Server → Phone messages (all variants) */
export type ServerMessage = StatusUpdate | ToolEvent | LogEntry | ConnectedMessage | SourceMessage | QuestionMessage | PermissionMessage | ReplyAckMessage

// ── Client → Server messages ────────────────────────────

export interface VoiceStartMessage {
  type: 'voice_start'
  format: string
  sampleRate: number
}

export interface VoiceStopMessage {
  type: 'voice_stop'
}

export interface CommandMessage {
  type: 'command'
  action: string
  payload?: Record<string, unknown>
}

export interface QuestionReplyMessage {
  type: 'question_reply'
  ackId?: string
  sourceId?: string
  sessionId?: string
  requestID: string
  answers: Array<Array<string>>
}

export interface QuestionRejectMessage {
  type: 'question_reject'
  ackId?: string
  sourceId?: string
  sessionId?: string
  requestID: string
}

export interface PermissionReplyMessage {
  type: 'permission_reply'
  ackId?: string
  sourceId?: string
  sessionId?: string
  requestID: string
  reply: 'once' | 'always' | 'reject'
}

export type ClientMessage = VoiceStartMessage | VoiceStopMessage | CommandMessage | QuestionReplyMessage | QuestionRejectMessage | PermissionReplyMessage

// ── Server configuration ────────────────────────────────

export interface ServerConfig {
  /** WebSocket + HTTP port for phone clients */
  port: number
  /** OpenCode server URL */
  opencodeUrl: string
  /** Directory to serve static files from (PWA), null to disable */
  staticDir: string | null
  /** Optional auth token */
  authToken: string | null
}

// ── Internal state ──────────────────────────────────────

export interface SessionState {
  status: AndonStatus
  task: string
  startTime: number
  toolCount: number
  errorCount: number
  currentTool: string | null
  logEntries: Array<LogEntry | ToolEvent>
}

// ── Adapter Hub ─────────────────────────────────────────

export interface SourceInstance {
  sourceId: string
  tool: string
  name: string
  serverUrl?: string
  cwd?: string
  capabilities: string[]
  lastSeen: number
}

export type PendingRequestKind = 'question' | 'permission'

export interface PendingRequest {
  kind: PendingRequestKind
  sourceId: string
  sessionId?: string
  requestId: string
  createdAt: number
  expiresAt: number
}

export interface AdapterReply {
  ackId: string
  kind: PendingRequestKind
  sourceId: string
  sessionId?: string
  requestId: string
  reply?: 'once' | 'always' | 'reject'
  answers?: Array<Array<string>>
  ts: number
}

export interface RegisterSourceRequest {
  sourceId: string
  tool?: string
  name?: string
  serverUrl?: string
  cwd?: string
  capabilities?: string[]
}
