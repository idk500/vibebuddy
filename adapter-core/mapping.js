/**
 * @vibebuddy/adapter-core — mapping
 *
 * 安灯状态的"唯一真相"：状态集合、优先级、聚合规则。
 * 所有 adapter 共享，避免状态语义散落成多份。
 */

/** @typedef {'DISCONNECTED'|'IDLE'|'THINKING'|'EXECUTING'|'ERROR'|'COMPLETE'} AndonStatus */

/** 合法状态集合 */
export const ANDON_STATUSES = ['DISCONNECTED', 'IDLE', 'THINKING', 'EXECUTING', 'ERROR', 'COMPLETE']

/**
 * 状态优先级（聚合多会话时"最严重者胜出"）。
 * 与 server/src/state-machine.ts 和 PWA legacy-app.js 保持一致。
 */
export const STATE_PRIORITY = {
  ERROR: 5,
  EXECUTING: 4,
  THINKING: 3,
  IDLE: 2,
  COMPLETE: 1,
  DISCONNECTED: 0,
}

/**
 * 规范化任意字符串到合法 AndonStatus，非法则回退 IDLE。
 * @param {string} value
 * @returns {AndonStatus}
 */
export function normalizeStatus(value) {
  const s = String(value || '').toUpperCase()
  return ANDON_STATUSES.includes(s) ? /** @type {AndonStatus} */ (s) : 'IDLE'
}

/**
 * 从一组状态中取优先级最高者。
 * @param {AndonStatus[]} statuses
 * @returns {AndonStatus}
 */
export function highestPriority(statuses) {
  if (!statuses || statuses.length === 0) return 'IDLE'
  return statuses.reduce((a, b) => ((STATE_PRIORITY[b] ?? 0) > (STATE_PRIORITY[a] ?? 0) ? b : a), 'IDLE')
}

/**
 * 把工具原始状态字符串归一为 started/completed/failed/''。
 * 各工具（OpenCode part state、ZCode tool.call.*）用词不同，这里统一。
 * @param {string} raw
 * @returns {'started'|'completed'|'failed'|''}
 */
export function normalizeToolStatus(raw) {
  const s = String(raw || '').toLowerCase()
  if (['running', 'starting', 'pending', 'in_progress', 'started'].includes(s)) return 'started'
  if (['completed', 'complete', 'done', 'success', 'finished'].includes(s)) return 'completed'
  if (['error', 'failed', 'failure'].includes(s)) return 'failed'
  return ''
}
