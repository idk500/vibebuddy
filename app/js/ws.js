/**
 * WebSocket Client — Connection management with auto-reconnect
 *
 * Manages WebSocket connection to PC Relay Server.
 * Features: exponential backoff reconnect, ping/pong, message dispatch.
 */

import { safeJsonParse } from './util.js'

/** @typedef {'DISCONNECTED'|'CONNECTING'|'CONNECTED'|'RECONNECTING'} ConnectionState */

export class WSClient {
  /** @type {string|null} */
  #url = null
  /** @type {WebSocket|null} */
  #ws = null
  /** @type {ConnectionState} */
  #state = 'DISCONNECTED'
  /** @type {number|null} */
  #reconnectTimer = null
  /** @type {number} */
  #reconnectAttempt = 0
  /** @type {number} */
  #maxReconnectDelay = 30000
  /** @type {number} */
  #baseReconnectDelay = 1000
  /** @type {Function[]} */
  #onStateChange = []
  /** @type {Function[]} */
  #onMessage = []

  /** @returns {ConnectionState} */
  get state() {
    return this.#state
  }

  /**
   * Connect to a Relay Server
   * @param {string} host - e.g. "192.168.1.5:4096"
   */
  connect(host) {
    this.disconnect()
    this.#url = `ws://${host}/ws`
    this.#setState('CONNECTING')
    this.#reconnectAttempt = 0
    this.#createConnection()
  }

  /** Disconnect and stop reconnecting */
  disconnect() {
    this.#clearReconnect()
    if (this.#ws) {
      this.#ws.onopen = null
      this.#ws.onclose = null
      this.#ws.onerror = null
      this.#ws.onmessage = null
      if (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING) {
        this.#ws.close(1000, 'Client disconnect')
      }
      this.#ws = null
    }
    this.#setState('DISCONNECTED')
  }

  /**
   * Send a JSON message to the server
   * @param {object} message
   * @returns {boolean} true if sent
   */
  send(message) {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false
    this.#ws.send(JSON.stringify(message))
    return true
  }

  /**
   * Send binary data to the server
   * @param {ArrayBuffer|BufferSource} data
   * @returns {boolean}
   */
  sendBinary(data) {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false
    this.#ws.send(data)
    return true
  }

  /**
   * Register a callback for connection state changes
   * @param {Function} callback - (state: ConnectionState) => void
   */
  onStateChange(callback) {
    this.#onStateChange.push(callback)
  }

  /**
   * Register a callback for incoming messages
   * @param {Function} callback - (message: object) => void
   */
  onMessage(callback) {
    this.#onMessage.push(callback)
  }

  // ── Private ──────────────────────────────────────────

  #createConnection() {
    if (!this.#url) return

    try {
      this.#ws = new WebSocket(this.#url)
    } catch (err) {
      console.error('[ws] Failed to create WebSocket:', err)
      this.#scheduleReconnect()
      return
    }

    this.#ws.onopen = () => {
      console.log('[ws] Connected')
      this.#reconnectAttempt = 0
      this.#setState('CONNECTED')
    }

    this.#ws.onclose = (event) => {
      console.log(`[ws] Closed: code=${event.code} reason=${event.reason}`)
      if (this.#state !== 'DISCONNECTED') {
        this.#setState('RECONNECTING')
        this.#scheduleReconnect()
      }
    }

    this.#ws.onerror = (event) => {
      console.error('[ws] Error:', event)
    }

    this.#ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const msg = safeJsonParse(event.data)
        if (msg) {
          this.#dispatchMessage(msg)
        } else {
          console.warn('[ws] Invalid JSON message')
        }
      }
      // Binary messages handled in Phase 2
    }
  }

  #setState(/** @type {ConnectionState} */ state) {
    this.#state = state
    for (const cb of this.#onStateChange) {
      try {
        cb(state)
      } catch (err) {
        console.error('[ws] State callback error:', err)
      }
    }
  }

  #dispatchMessage(msg) {
    for (const cb of this.#onMessage) {
      try {
        cb(msg)
      } catch (err) {
        console.error('[ws] Message callback error:', err)
      }
    }
  }

  #scheduleReconnect() {
    this.#clearReconnect()
    const delay = Math.min(
      this.#baseReconnectDelay * Math.pow(2, this.#reconnectAttempt),
      this.#maxReconnectDelay
    )
    this.#reconnectAttempt++
    console.log(`[ws] Reconnect attempt ${this.#reconnectAttempt} in ${delay}ms`)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      this.#createConnection()
    }, delay)
  }

  #clearReconnect() {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
  }
}
