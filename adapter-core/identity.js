/**
 * @vibebuddy/adapter-core — identity
 *
 * 统一 sourceId 生成规则，替代各 adapter 各写一套。
 */

import { createHash } from 'node:crypto'

/**
 * 生成稳定的 sourceId。
 * 规则: `${tool}:${shortHash(cwd)}` 或带 pid 的 `${tool}:${pid}:${shortHash(cwd)}`。
 * 同一工具 + 同一工作目录 → 同一 sourceId（便于重连后复用卡片）。
 *
 * @param {string} tool 工具标识，如 'opencode' | 'zcode' | 'kiro'
 * @param {object} [opts]
 * @param {string|number} [opts.pid] 进程 PID（OpenCode 多实例时区分）
 * @param {string} [opts.cwd] 工作目录
 * @param {string} [opts.seed] 额外种子（如 sessionId），替代 cwd
 * @returns {string}
 */
export function makeSourceId(tool, opts = {}) {
  const seed = opts.seed != null ? String(opts.seed) : (opts.cwd != null ? String(opts.cwd) : 'unknown')
  const short = createHash('md5').update(seed).digest('hex').slice(0, 12)
  return opts.pid != null ? `${tool}:${opts.pid}:${short}` : `${tool}:${short}`
}
