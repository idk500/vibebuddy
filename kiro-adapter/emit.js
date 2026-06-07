#!/usr/bin/env node
/**
 * VibeBuddy Kiro Adapter — emit.js
 *
 * Tier B 接入：由 Kiro Agent Hooks 通过 runCommand 调用，
 * 把单次 Kiro 事件翻译成 canonical 事件并 POST 到 Relay Hub。
 *
 * 这是 Phase 5 的概念验证（PoC）：自包含、零依赖、不依赖 adapter-core。
 * 后续提取 @vibebuddy/adapter-core 后，本文件改为薄映射层。
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

import { request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'

// ── args ───────────────────────────────────────────────

const argv = process.argv.slice(2)
function arg(name) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}
function flag(name) {
  return argv.includes('--' + name)
}

const RELAY_URL = (process.env.VIBE_RELAY_URL || 'http://127.0.0.1:4097').replace(/\/+$/, '')
const SESSION_ID = arg('session') || process.env.VIBE_SESSION_ID || 'kiro'
const CWD = process.cwd()
const SOURCE_ID = 'kiro:' + createHash('md5').update(CWD).digest('hex').slice(0, 12)
const EVENT = arg('event') || 'log'
const TOOL = arg('tool') || 'tool'

// ── HTTP ───────────────────────────────────────────────

function postJson(path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body)
    const req = httpRequest(RELAY_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      res.resume()
      res.on('end', () => resolve(true))
    })
    req.on('error', () => resolve(false)) // 静默失败：relay 未启动不应阻断 Kiro
    req.write(data)
    req.end()
  })
}

function withSource(msg) {
  return Object.assign({ sourceId: SOURCE_ID, sessionId: SESSION_ID }, msg)
}

// ── canonical event mapping ────────────────────────────

function buildMessages(event) {
  const ts = Date.now()
  switch (event) {
    case 'promptSubmit':
      return [withSource({ type: 'status', status: 'THINKING', task: 'Processing prompt...', duration: 0, toolCount: 0, errorCount: 0 })]
    case 'preToolUse':
      return [
        withSource({ type: 'tool', name: TOOL, status: 'started', args: {}, ts }),
        withSource({ type: 'status', status: 'EXECUTING', task: 'Running: ' + TOOL, duration: 0, toolCount: 0, errorCount: 0 }),
      ]
    case 'postToolUse': {
      const failed = flag('fail')
      const out = [withSource({ type: 'tool', name: TOOL, status: failed ? 'failed' : 'completed', args: {}, ts })]
      if (failed) out.push(withSource({ type: 'log', level: 'error', message: 'Tool ' + TOOL + ' failed', ts }))
      out.push(withSource({ type: 'status', status: 'THINKING', task: 'Processing...', duration: 0, toolCount: 0, errorCount: 0 }))
      return out
    }
    case 'agentStop':
      return [withSource({ type: 'status', status: 'IDLE', task: 'Idle', duration: 0, toolCount: 0, errorCount: 0 })]
    case 'fileEdited':
    case 'fileCreated':
      return [withSource({ type: 'log', level: 'info', message: event + ': ' + (arg('file') || '?'), ts })]
    default:
      return [withSource({ type: 'log', level: 'info', message: 'Kiro event: ' + event, ts })]
  }
}

// ── main ───────────────────────────────────────────────

async function main() {
  // 注册（幂等：Hub 重复注册只更新 lastSeen）
  await postJson('/api/register', {
    sourceId: SOURCE_ID,
    tool: 'kiro',
    name: arg('name') || 'Kiro IDE',
    cwd: CWD,
    capabilities: ['events'], // Tier B：当前仅事件；权限闭环待验证 hook 阻塞语义
  })
  const messages = buildMessages(EVENT)
  for (const m of messages) await postJson('/api/event', m)
}

main().catch(() => process.exit(0)) // 永不因 relay 问题拖累 Kiro
