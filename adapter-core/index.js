/**
 * @vibebuddy/adapter-core
 *
 * 所有 VibeBuddy adapter 共享的 60%：身份、传输、canonical 事件发送、权限闭环。
 * 每个 adapter 只需写工具特有的"原生事件 → core helper 调用"那 40%。
 *
 * 零依赖（仅 node: 内置 + 全局 fetch，Node 18+）。ESM。
 *
 * 用法:
 *   import { createAdapter } from '../adapter-core/index.js'
 *   const a = createAdapter({ relayUrl, tool: 'kiro', sourceId, name, capabilities: ['events'] })
 *   await a.register()
 *   a.thinking(sessionId, 'Generating...')
 *   a.toolStarted(sessionId, { id, name: 'fsWrite' })
 *   a.toolDone(sessionId, { id, name: 'fsWrite', ok: true })
 *   a.idle(sessionId)
 *   const decision = await a.askPermission(sessionId, { id, tool, message }) // 'allow'|'deny'
 */

import { makeSourceId } from './identity.js'
import {
  ANDON_STATUSES,
  STATE_PRIORITY,
  normalizeStatus,
  normalizeToolStatus,
  highestPriority,
} from './mapping.js'

export { makeSourceId, ANDON_STATUSES, STATE_PRIORITY, normalizeStatus, normalizeToolStatus, highestPriority }

function now() { return Date.now() }

function newId(prefix) {
  return `${prefix}_${now()}_${Math.random().toString(16).slice(2)}`
}

/**
 * 创建一个 adapter 实例。
 * @param {object} cfg
 * @param {string} [cfg.relayUrl] default http://127.0.0.1:4097
 * @param {string} cfg.tool 工具标识
 * @param {string} cfg.sourceId 唯一 source id（用 makeSourceId 生成）
 * @param {string} [cfg.name] 显示名
 * @param {string} [cfg.cwd] 工作目录
 * @param {string} [cfg.serverUrl] 工具自身 server url（可选）
 * @param {string[]} [cfg.capabilities] 能力声明，如 ['events'] | ['events','permission']
 * @param {(path:string, body:object)=>Promise<any>} [cfg.postJson] 自定义传输（测试注入）
 * @param {(path:string)=>Promise<any>} [cfg.getJson] 自定义传输（测试注入）
 */
export function createAdapter(cfg) {
  if (!cfg || !cfg.tool || !cfg.sourceId) {
    throw new Error('createAdapter requires { tool, sourceId }')
  }
  const relayUrl = (cfg.relayUrl || 'http://127.0.0.1:4097').replace(/\/+$/, '')
  const sourceId = cfg.sourceId
  const capabilities = Array.isArray(cfg.capabilities) ? cfg.capabilities : ['events']
  const pollIntervalMs = cfg.pollIntervalMs || 500

  // ── transport（可注入，默认用全局 fetch）──
  const postJson = cfg.postJson || (async (path, body) => {
    try {
      const res = await fetch(relayUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return res.ok
    } catch {
      return false // 静默失败：relay 未启动不应拖垮工具
    }
  })

  const getJson = cfg.getJson || (async (path) => {
    try {
      const res = await fetch(relayUrl + path)
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  })

  function withSource(msg, sessionId) {
    return Object.assign({ sourceId }, sessionId != null ? { sessionId: String(sessionId) } : {}, msg)
  }

  function status(sessionId, statusValue, task, extra = {}) {
    return postJson('/api/event', withSource({
      type: 'status',
      status: normalizeStatus(statusValue),
      task: task || '',
      duration: extra.duration || 0,
      toolCount: extra.toolCount || 0,
      errorCount: extra.errorCount || 0,
    }, sessionId))
  }

  const api = {
    sourceId,
    capabilities,

    // ── 注册 + 心跳 ──
    async register() {
      return postJson('/api/register', {
        sourceId,
        tool: cfg.tool,
        name: cfg.name || sourceId,
        serverUrl: cfg.serverUrl || '',
        cwd: cfg.cwd || '',
        capabilities,
      })
    },

    /** 启动周期性心跳（重新 register 以刷新 lastSeen）。返回 stop 函数。 */
    startHeartbeat(intervalMs = 15000) {
      if (typeof setInterval !== 'function') return () => {}
      const t = setInterval(() => { api.register() }, intervalMs)
      if (t && typeof t.unref === 'function') t.unref()
      return () => clearInterval(t)
    },

    // ── canonical 状态 helpers ──
    thinking(sessionId, task, extra) { return status(sessionId, 'THINKING', task || 'Thinking...', extra) },
    executing(sessionId, task, extra) { return status(sessionId, 'EXECUTING', task || 'Executing...', extra) },
    idle(sessionId, task, extra) { return status(sessionId, 'IDLE', task || 'Idle', extra) },
    error(sessionId, task, extra) { return status(sessionId, 'ERROR', task || 'Error', Object.assign({ errorCount: 1 }, extra)) },
    complete(sessionId, task, extra) { return status(sessionId, 'COMPLETE', task || 'Complete', extra) },
    status,

    // ── canonical 工具 helpers ──
    toolStarted(sessionId, tool) {
      return postJson('/api/event', withSource({
        type: 'tool', id: tool.id, name: tool.name || 'tool', status: 'started', args: tool.args || {}, title: tool.title || '', ts: now(),
      }, sessionId))
    },
    toolDone(sessionId, tool) {
      const ok = tool.ok !== false
      return postJson('/api/event', withSource({
        type: 'tool', id: tool.id, name: tool.name || 'tool', status: ok ? 'completed' : 'failed', args: tool.args || {}, title: tool.title || '', ts: now(),
      }, sessionId))
    },

    // ── 日志 ──
    log(sessionId, level, message) {
      return postJson('/api/event', withSource({ type: 'log', level: level || 'info', message: String(message || ''), ts: now() }, sessionId))
    },

    // ── 权限 / 问题 ──
    /** 发送权限请求事件（不等待）。返回 requestId。 */
    sendPermission(sessionId, perm) {
      const id = perm.id || newId('per')
      postJson('/api/event', withSource({
        type: 'permission', id, tool: perm.tool || 'unknown', message: perm.message || 'Allow this action?', patterns: perm.patterns,
      }, sessionId))
      return id
    },

    /**
     * 发送权限请求并轮询等待手机回复。
     * @returns {Promise<'allow'|'deny'>} 超时或拒绝 → 'deny'（安全默认值）
     */
    async askPermission(sessionId, perm, opts = {}) {
      const timeoutMs = opts.timeoutMs || 120000
      const id = api.sendPermission(sessionId, perm)
      const deadline = now() + timeoutMs
      while (now() < deadline) {
        const data = await getJson('/api/replies?sourceId=' + encodeURIComponent(sourceId))
        const replies = data && Array.isArray(data.replies) ? data.replies : []
        for (const r of replies) {
          if (r && r.kind === 'permission' && r.requestId === id) {
            return r.reply === 'reject' ? 'deny' : 'allow'
          }
        }
        await new Promise((res) => setTimeout(res, pollIntervalMs))
      }
      return 'deny' // 安全默认值：超时不放行
    },

    /** 发送问题事件（不等待）。返回 requestId。 */
    sendQuestion(sessionId, questions) {
      const id = newId('que')
      postJson('/api/event', withSource({ type: 'question', id, questions: questions || [] }, sessionId))
      return id
    },

    // 低层逃生口
    _post: postJson,
    _get: getJson,
    _withSource: withSource,
  }

  return api
}
