/**
 * Event Relay — OpenCode event to Andon state transformation
 *
 * Transforms raw OpenCode events into the Andon status protocol
 * and manages session state tracking.
 */

import type {
  AndonStatus,
  SessionState,
  ServerMessage,
  ToolEvent,
  LogEntry,
} from './types.js'

// ── Session state manager ───────────────────────────────

export class SessionTracker {
  private state: SessionState = {
    status: 'DISCONNECTED',
    task: '',
    startTime: 0,
    toolCount: 0,
    errorCount: 0,
    currentTool: null,
    logEntries: [],
  }

  private readonly maxLogEntries = 50

  get currentStatus(): AndonStatus {
    return this.state.status
  }

  get currentState(): Readonly<SessionState> {
    return this.state
  }

  /** Update status and return the broadcast message */
  updateStatus(status: AndonStatus, task?: string): ServerMessage {
    if (status !== this.state.status) {
      // Log the transition
      this.addLog('info', `Status: ${this.state.status} → ${status}`)
    }

    this.state.status = status
    if (task !== undefined) {
      this.state.task = task
    }
    if (status === 'THINKING' || status === 'EXECUTING') {
      if (this.state.startTime === 0) {
        this.state.startTime = Date.now()
      }
    } else {
      this.state.startTime = 0
    }

    return {
      type: 'status',
      status: this.state.status,
      task: this.state.task,
      duration: this.state.startTime > 0 ? Date.now() - this.state.startTime : 0,
      toolCount: this.state.toolCount,
      errorCount: this.state.errorCount,
    }
  }

  /** Record a tool event */
  recordTool(name: string, status: 'started' | 'completed' | 'failed', args?: Record<string, unknown>): ServerMessage {
    if (status === 'started') {
      this.state.toolCount++
      this.state.currentTool = name
      this.addLog('info', `▸ ${name} ${formatToolArgs(args)}`)
    } else {
      this.state.currentTool = null
      if (status === 'failed') {
        this.state.errorCount++
        this.addLog('error', `✗ ${name} failed`)
      } else {
        this.addLog('info', `✓ ${name} completed`)
      }
    }

    return {
      type: 'tool',
      name,
      status,
      args: args ?? {},
      ts: Date.now(),
    }
  }

  /** Get all log entries */
  getLog(): ReadonlyArray<Readonly<LogEntry | ToolEvent>> {
    return this.state.logEntries
  }

  /** Get current duration in ms */
  getDuration(): number {
    if (this.state.startTime === 0) return 0
    return Date.now() - this.state.startTime
  }

  /** Reset session state */
  reset(): void {
    this.state = {
      status: 'IDLE',
      task: '',
      startTime: 0,
      toolCount: 0,
      errorCount: 0,
      currentTool: null,
      logEntries: [],
    }
  }

  private addLog(level: LogEntry['level'], message: string): void {
    const entry: LogEntry = {
      type: 'log',
      level,
      message,
      ts: Date.now(),
    }

    this.state.logEntries.push(entry)
    if (this.state.logEntries.length > this.maxLogEntries) {
      this.state.logEntries.shift()
    }
  }
}

// ── Helpers ─────────────────────────────────────────────

function formatToolArgs(args?: Record<string, unknown>): string {
  if (!args) return ''
  const entries = Object.entries(args)
  if (entries.length === 0) return ''

  // Show first arg as summary
  const [key, value] = entries[0]!
  const valueStr = typeof value === 'string' ? value : JSON.stringify(value)
  return `${key}: ${valueStr.length > 40 ? `${valueStr.slice(0, 37)  }...` : valueStr}`
}
