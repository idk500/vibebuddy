#!/usr/bin/env node
/**
 * VibeBuddy Kiro Adapter — emit.js
 *
 * Tier B 接入：由 Kiro Agent Hooks 通过 runCommand 调用，
 * 把单次 Kiro 事件翻译成 canonical 事件并 POST 到 Relay Hub。
 *
 * 已迁移到 @vibebuddy/adapter-core：本文件只剩"Kiro 事件 → core helper"的薄映射。
 *
 * 用法（在 Kiro Hook 的 command 中）:
 *   node emit.js --event promptSubmit
 *   node emit.js --event preToolUse  --tool fsWrite
 *   node emit.js --event postToolUse --tool fsWrite --ok
 *   node emit.js --event postToolUse --tool bash --fail
 *   node emit.js --event agentStop
 *
 * 环境变量:
 *   VIBE_RELAY_URL   default http://127.0.0.1:4097
 *   VIBE_SESSION_ID  会话标识 (Kiro 可注入), default "kiro"
 */

import { createAdapter, makeSourceId } from '../adapter-core/index.js'

// ── args ───────────────────────────────────────────────

const argv = process.argv.slice(2)
function arg(name) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}
function flag(name) { return argv.includes('--' + name) }

const RELAY_URL = process.env.VIBE_RELAY_URL || 'http://127.0.0.1:4097'
const SESSION_ID = arg('session') || process.env.VIBE_SESSION_ID || 'kiro'
const CWD = process.cwd()
const EVENT = arg('event') || 'log'
const TOOL = arg('tool') || 'tool'

const adapter = createAdapter({
  relayUrl: RELAY_URL,
  tool: 'kiro',
  sourceId: makeSourceId('kiro', { cwd: CWD }),
  name: arg('name') || 'Kiro IDE',
  cwd: CWD,
  capabilities: ['events'], // Tier B：当前仅事件；权限闭环待验证 hook 阻塞语义
})

// ── Kiro 事件 → core helper（薄映射）──

async function dispatch(event) {
  switch (event) {
    case 'promptSubmit':
      return adapter.thinking(SESSION_ID, 'Processing prompt...')
    case 'preToolUse':
      await adapter.toolStarted(SESSION_ID, { name: TOOL })
      return adapter.executing(SESSION_ID, 'Running: ' + TOOL)
    case 'postToolUse': {
      const ok = !flag('fail')
      await adapter.toolDone(SESSION_ID, { name: TOOL, ok })
      if (!ok) await adapter.log(SESSION_ID, 'error', 'Tool ' + TOOL + ' failed')
      return adapter.thinking(SESSION_ID, 'Processing...')
    }
    case 'agentStop':
      return adapter.idle(SESSION_ID, 'Idle')
    case 'fileEdited':
    case 'fileCreated':
      return adapter.log(SESSION_ID, 'info', event + ': ' + (arg('file') || '?'))
    default:
      return adapter.log(SESSION_ID, 'info', 'Kiro event: ' + event)
  }
}

async function main() {
  await adapter.register() // 幂等
  await dispatch(EVENT)
}

main().catch(() => process.exit(0)) // 永不因 relay 问题拖累 Kiro
