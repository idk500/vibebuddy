/**
 * Utility functions for VibeCoding Companion
 */

/**
 * Format milliseconds as mm:ss
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms <= 0) return '00:00'
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * Format timestamp as HH:MM
 * @param {number} ts - Unix timestamp in ms
 * @returns {string}
 */
export function formatTime(ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Truncate string to maxLen with ellipsis
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
export function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str ?? ''
  return str.slice(0, maxLen - 1) + '\u2026'
}

/**
 * Safely parse JSON, returning null on failure
 * @param {string} raw
 * @returns {object|null}
 */
export function safeJsonParse(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Debounce a function
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
export function debounce(fn, ms) {
  let timer = null
  return (...args) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      fn(...args)
      timer = null
    }, ms)
  }
}

/**
 * Get a DOM element by ID, throws if not found
 * @param {string} id
 * @returns {HTMLElement}
 */
export function $(id) {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element #${id} not found`)
  return el
}

/**
 * Create an element with optional attributes and children
 * @param {string} tag
 * @param {object} [attrs]
 * @param {...(string|Node)} children
 * @returns {HTMLElement}
 */
export function createElement(tag, attrs, ...children) {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'className') {
        el.className = value
      } else if (key.startsWith('data-')) {
        el.setAttribute(key, value)
      } else {
        el[key] = value
      }
    }
  }
  for (const child of children) {
    if (typeof child === 'string') {
      el.appendChild(document.createTextNode(child))
    } else if (child instanceof Node) {
      el.appendChild(child)
    }
  }
  return el
}
