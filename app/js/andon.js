/**
 * Andon Status Renderer — Visual status display
 *
 * Manages the Andon status display: color, animation, text updates.
 * Receives status updates and renders the appropriate visual state.
 */

import { $, formatDuration, truncate } from './util.js'

/** @typedef {'DISCONNECTED'|'IDLE'|'THINKING'|'EXECUTING'|'ERROR'|'COMPLETE'} AndonStatus */

/** @type {Record<AndonStatus, string>} */
const STATUS_COLORS = {
  DISCONNECTED: '#475569',
  IDLE: '#3b82f6',
  THINKING: '#f59e0b',
  EXECUTING: '#10b981',
  ERROR: '#ef4444',
  COMPLETE: '#34d399',
}

/** @type {Record<AndonStatus, string>} */
const STATUS_LABELS = {
  DISCONNECTED: 'DISCONNECTED',
  IDLE: 'IDLE',
  THINKING: 'THINKING',
  EXECUTING: 'EXECUTING',
  ERROR: 'ERROR',
  COMPLETE: 'COMPLETE',
}

export class AndonRenderer {
  /** @type {AndonStatus} */
  #currentStatus = 'DISCONNECTED'
  /** @type {string} */
  #task = ''
  /** @type {number} */
  #toolCount = 0
  /** @type {number} */
  #errorCount = 0
  /** @type {number} */
  #duration = 0
  /** @type {number|null} */
  #durationTimer = null

  constructor() {
    // Cache DOM references
    this.panel = $('andon-panel')
    this.glow = $('andon-glow')
    this.badge = $('andon-status-badge')
    this.icon = $('andon-status-icon')
    this.statusText = $('andon-status-text')
    this.task = $('andon-task')
    this.statTools = $('stat-tools')
    this.statErrors = $('stat-errors')
    this.statDuration = $('stat-duration')
  }

  /**
   * Update the Andon display with new status
   * @param {object} data
   * @param {AndonStatus} data.status
   * @param {string} [data.task]
   * @param {number} [data.toolCount]
   * @param {number} [data.errorCount]
   * @param {number} [data.duration]
   */
  update(data) {
    const { status } = data
    const color = STATUS_COLORS[status] ?? STATUS_COLORS['DISCONNECTED']

    // Update status
    if (status !== this.#currentStatus) {
      this.#currentStatus = status
      this.#applyStatusColor(color)
      this.#applyStatusAnimation(status)
    }

    // Update task
    if (data.task !== undefined) {
      this.#task = data.task
      this.task.textContent = truncate(data.task, 120)
    }

    // Update stats
    if (data.toolCount !== undefined) {
      this.#toolCount = data.toolCount
      this.statTools.textContent = String(data.toolCount)
    }
    if (data.errorCount !== undefined) {
      this.#errorCount = data.errorCount
      this.statErrors.textContent = String(data.errorCount)
      this.statErrors.style.color = data.errorCount > 0 ? STATUS_COLORS['ERROR'] : ''
    }
    if (data.duration !== undefined) {
      this.#duration = data.duration
    }

    // Update status label
    this.statusText.textContent = STATUS_LABELS[status] ?? status
  }

  /** Reset to disconnected state */
  reset() {
    this.update({ status: 'DISCONNECTED', task: '等待连接...', toolCount: 0, errorCount: 0, duration: 0 })
    this.#stopDurationTimer()
  }

  /**
   * Start a live duration counter
   * @param {number} startTime - Unix timestamp ms
   */
  startDurationCounter(startTime) {
    this.#stopDurationTimer()
    const tick = () => {
      const elapsed = Date.now() - startTime
      this.statDuration.textContent = formatDuration(elapsed)
    }
    tick()
    this.#durationTimer = setInterval(tick, 1000)
  }

  /** Stop the duration counter */
  #stopDurationTimer() {
    if (this.#durationTimer) {
      clearInterval(this.#durationTimer)
      this.#durationTimer = null
    }
  }

  /**
   * Apply status color to CSS custom properties
   * @param {string} color
   */
  #applyStatusColor(color) {
    const root = document.documentElement
    root.style.setProperty('--status-color', color)
    root.style.setProperty('--status-color-bg', hexToRgba(color, 0.12))
    root.style.setProperty('--status-color-glow', hexToRgba(color, 0.25))
  }

  /**
   * Apply status-specific animations via data attribute
   * @param {AndonStatus} status
   */
  #applyStatusAnimation(status) {
    this.panel.setAttribute('data-status', status)
  }
}

// ── Helper ──────────────────────────────────────────────

/**
 * Convert hex color to rgba string
 * @param {string} hex - e.g. "#3b82f6"
 * @param {number} alpha - 0 to 1
 * @returns {string}
 */
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}
