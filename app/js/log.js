/**
 * Activity Log Renderer
 *
 * Manages the scrolling activity log panel.
 * Shows tool calls, status changes, and errors.
 */

import { $, formatTime, createElement, truncate } from './util.js'

const MAX_ENTRIES = 100

export class LogRenderer {
  constructor() {
    this.container = $('log-container')
    /** @type {number} */
    this.entryCount = 0
  }

  /**
   * Add a tool event entry
   * @param {object} data
   * @param {string} data.name - Tool name
   * @param {'started'|'completed'|'failed'} data.status
   * @param {object} [data.args]
   * @param {number} data.ts
   */
  addToolEvent(data) {
    const prefix = data.status === 'started' ? '\u25B8' : data.status === 'failed' ? '\u2717' : '\u2713'
    const argsStr = data.args ? this.#formatArgs(data.args) : ''
    const title = data.title ? ` ${data.title}` : argsStr ? ` ${argsStr}` : ''
    const message = `${prefix} ${data.name}${title}`

    const cssClass = data.status === 'failed' ? 'log-tool-fail' : 'log-tool'
    this.#addEntry(message, data.ts, cssClass)
  }

  /**
   * Add a log entry
   * @param {object} data
   * @param {'info'|'warn'|'error'} data.level
   * @param {string} data.message
   * @param {number} data.ts
   */
  addLogEntry(data) {
    this.#addEntry(data.message, data.ts, `log-${data.level}`)
  }

  /**
   * Add a status change entry
   * @param {string} status
   * @param {number} ts
   */
  addStatusChange(status, ts = Date.now()) {
    this.#addEntry(`Status \u2192 ${status}`, ts, 'log-info')
  }

  /** Clear all log entries */
  clear() {
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild)
    }
    this.entryCount = 0
  }

  // ── Private ──────────────────────────────────────────

  /**
   * @param {string} message
   * @param {number} ts
   * @param {string} cssClass
   */
  #addEntry(message, ts, cssClass) {
    const time = formatTime(ts)

    const entry = createElement('div', { className: `log-entry ${cssClass}` },
      createElement('span', { className: 'log-time' }, time),
      createElement('span', { className: 'log-msg' }, truncate(message, 120))
    )

    this.container.appendChild(entry)
    this.entryCount++

    // Trim old entries
    while (this.entryCount > MAX_ENTRIES) {
      const first = this.container.firstChild
      if (first) {
        this.container.removeChild(first)
        this.entryCount--
      } else {
        break
      }
    }

    // Auto-scroll to bottom
    this.container.scrollTop = this.container.scrollHeight
  }

  /**
   * Format tool args for display
   * @param {object} args
   * @returns {string}
   */
  #formatArgs(args) {
    const entries = Object.entries(args)
    if (entries.length === 0) return ''

    const [key, value] = entries[0]
    const valueStr = typeof value === 'string' ? value : JSON.stringify(value)
    return `${key}: ${truncate(valueStr, 40)}`
  }
}
