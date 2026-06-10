/**
 * adapter-core 单元测试（node:test, 零依赖）
 * 运行: node --test  (在 adapter-core/ 目录)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeSourceId } from './identity.js'
import { normalizeStatus, normalizeToolStatus, highestPriority, STATE_PRIORITY } from './mapping.js'
import { createAdapter } from './index.js'

// ── identity ──

test('makeSourceId is deterministic for same tool+seed', () => {
  const a = makeSourceId('kiro', { cwd: '/project' })
  const b = makeSourceId('kiro', { cwd: '/project' })
  assert.equal(a, b)
  assert.match(a, /^kiro:[0-9a-f]{12}$/)
})

test('makeSourceId differs by tool and by seed', () => {
  assert.notEqual(makeSourceId('kiro', { cwd: '/a' }), makeSourceId('kiro', { cwd: '/b' }))
  assert.notEqual(makeSourceId('kiro', { cwd: '/a' }), makeSourceId('zcode', { cwd: '/a' }))
})

test('makeSourceId includes pid when provided', () => {
  const id = makeSourceId('opencode', { pid: 1234, cwd: '/x' })
  assert.match(id, /^opencode:1234:[0-9a-f]{12}$/)
})

// ── mapping ──

test('normalizeStatus accepts valid, falls back to IDLE', () => {
  assert.equal(normalizeStatus('thinking'), 'THINKING')
  assert.equal(normalizeStatus('EXECUTING'), 'EXECUTING')
  assert.equal(normalizeStatus('bogus'), 'IDLE')
  assert.equal(normalizeStatus(''), 'IDLE')
})

test('normalizeToolStatus maps tool vocab', () => {
  assert.equal(normalizeToolStatus('running'), 'started')
  assert.equal(normalizeToolStatus('in_progress'), 'started')
  assert.equal(normalizeToolStatus('done'), 'completed')
  assert.equal(normalizeToolStatus('failure'), 'failed')
  assert.equal(normalizeToolStatus('weird'), '')
})

test('highestPriority picks most severe (ERROR wins)', () => {
  assert.equal(highestPriority(['IDLE', 'ERROR', 'THINKING']), 'ERROR')
  assert.equal(highestPriority(['THINKING', 'EXECUTING', 'IDLE']), 'EXECUTING')
  assert.equal(highestPriority([]), 'IDLE')
})

test('STATE_PRIORITY ordering is ERROR>EXECUTING>THINKING>IDLE>COMPLETE>DISCONNECTED', () => {
  assert.ok(STATE_PRIORITY.ERROR > STATE_PRIORITY.EXECUTING)
  assert.ok(STATE_PRIORITY.EXECUTING > STATE_PRIORITY.THINKING)
  assert.ok(STATE_PRIORITY.THINKING > STATE_PRIORITY.IDLE)
  assert.ok(STATE_PRIORITY.IDLE > STATE_PRIORITY.COMPLETE)
  assert.ok(STATE_PRIORITY.COMPLETE > STATE_PRIORITY.DISCONNECTED)
})

// ── adapter message shape (injected transport) ──

function recordingAdapter(extra = {}) {
  const posts = []
  const a = createAdapter(Object.assign({
    tool: 'test',
    sourceId: 'test:abc',
    capabilities: ['events', 'permission'],
    postJson: async (path, body) => { posts.push({ path, body }); return true },
    getJson: async () => ({ replies: [] }),
  }, extra))
  return { a, posts }
}

test('register posts source with capabilities', async () => {
  const { a, posts } = recordingAdapter()
  await a.register()
  assert.equal(posts.length, 1)
  assert.equal(posts[0].path, '/api/register')
  assert.equal(posts[0].body.sourceId, 'test:abc')
  assert.deepEqual(posts[0].body.capabilities, ['events', 'permission'])
})

test('status helpers attach sourceId + sessionId and normalize', async () => {
  const { a, posts } = recordingAdapter()
  await a.thinking('ses1', 'doing stuff')
  const m = posts[0].body
  assert.equal(m.type, 'status')
  assert.equal(m.status, 'THINKING')
  assert.equal(m.sourceId, 'test:abc')
  assert.equal(m.sessionId, 'ses1')
  assert.equal(m.task, 'doing stuff')
})

test('toolStarted / toolDone produce correct tool status', async () => {
  const { a, posts } = recordingAdapter()
  await a.toolStarted('s', { id: 't1', name: 'bash' })
  await a.toolDone('s', { id: 't1', name: 'bash', ok: true })
  await a.toolDone('s', { id: 't2', name: 'edit', ok: false })
  assert.equal(posts[0].body.status, 'started')
  assert.equal(posts[1].body.status, 'completed')
  assert.equal(posts[2].body.status, 'failed')
})

test('error helper sets errorCount=1', async () => {
  const { a, posts } = recordingAdapter()
  await a.error('s', 'boom')
  assert.equal(posts[0].body.status, 'ERROR')
  assert.equal(posts[0].body.errorCount, 1)
})

test('askPermission returns allow when reply is once/always', async () => {
  let polled = 0
  const { a } = recordingAdapter({
    getJson: async () => {
      polled++
      // 第二次轮询才返回回复，验证轮询逻辑
      if (polled < 2) return { replies: [] }
      return { replies: [{ kind: 'permission', requestId: LAST_PERM_ID, reply: 'once' }] }
    },
  })
  // 捕获 sendPermission 生成的 id
  const origSend = a.sendPermission
  let LAST_PERM_ID = null
  a.sendPermission = (sid, perm) => { LAST_PERM_ID = origSend(sid, perm); return LAST_PERM_ID }
  const decision = await a.askPermission('s', { tool: 'bash', message: 'ok?' }, { timeoutMs: 5000 })
  assert.equal(decision, 'allow')
})

test('askPermission returns deny on timeout (safe default)', async () => {
  const { a } = recordingAdapter({ getJson: async () => ({ replies: [] }), pollIntervalMs: 10 })
  const decision = await a.askPermission('s', { tool: 'bash', message: 'ok?' }, { timeoutMs: 50 })
  assert.equal(decision, 'deny')
})

test('askPermission returns deny when reply is reject', async () => {
  const { a } = recordingAdapter({
    getJson: async () => ({ replies: [{ kind: 'permission', requestId: PERM_ID, reply: 'reject' }] }),
  })
  let PERM_ID = null
  const orig = a.sendPermission
  a.sendPermission = (sid, perm) => { PERM_ID = orig(sid, perm); return PERM_ID }
  const decision = await a.askPermission('s', { tool: 'bash', message: 'ok?' }, { timeoutMs: 5000 })
  assert.equal(decision, 'deny')
})

test('createAdapter throws without tool/sourceId', () => {
  assert.throws(() => createAdapter({}), /requires/)
})
