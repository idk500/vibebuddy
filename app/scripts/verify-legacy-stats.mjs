import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
const legacyAppPath = path.join(appRoot, 'js', 'legacy-app.js')

class Element {
  constructor(tag, id = '') {
    this.tagName = tag.toUpperCase()
    this.id = id
    this.children = []
    this.firstChild = null
    this.parentNode = null
    this.style = {}
    this.attributes = {}
    this.className = ''
    this.textContent = ''
    this.value = ''
    this.disabled = false
    this.scrollTop = 0
    this.scrollHeight = 0
    this.onclick = null
    this.onkeydown = null
  }

  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    this.firstChild = this.children[0] || null
    this.scrollHeight = this.children.length
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    this.firstChild = this.children[0] || null
    this.scrollHeight = this.children.length
    return child
  }

  setAttribute(key, value) {
    this.attributes[key] = String(value)
  }

  getElementsByTagName(tag) {
    const target = tag.toUpperCase()
    const matches = []
    function visit(node) {
      for (const child of node.children) {
        if (child.tagName === target) matches.push(child)
        visit(child)
      }
    }
    visit(this)
    return matches
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const ids = [
  'js-error', 'andon-panel', 'andon-status-text', 'andon-task', 'stat-tools', 'stat-errors', 'stat-duration',
  'log-container', 'connect-screen', 'andon-screen', 'server-url', 'connect-btn', 'connect-status',
  'connection-dot', 'session-label', 'clock', 'disconnect-btn', 'fullscreen-btn'
]
const elements = {}
for (const id of ids) elements[id] = new Element('div', id)
elements['server-url'].value = '127.0.0.1:4097'

const documentElement = new Element('html')
documentElement.style.setProperty = function (key, value) { this[key] = value }

const document = {
  readyState: 'complete',
  documentElement,
  body: new Element('body'),
  fullscreenElement: null,
  getElementById(id) { return elements[id] || null },
  createElement(tag) { return new Element(tag) },
  createTextNode(text) {
    const node = new Element('#text')
    node.textContent = text
    return node
  },
  addEventListener() {},
}

class WebSocketStub {
  constructor(url) {
    this.url = url
    this.readyState = WebSocketStub.OPEN
  }
  send() {}
  close() {}
}
WebSocketStub.OPEN = 1
WebSocketStub.CONNECTING = 0

let now = 1000000
const timers = new Map()
let nextTimer = 1
const context = {
  window: null,
  document,
  console,
  WebSocket: WebSocketStub,
  Date: class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  },
  Math,
  JSON,
  String,
  Number,
  Object,
  Array,
  RegExp,
  Error,
  encodeURIComponent,
  decodeURIComponent,
  setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id },
  clearTimeout(id) { timers.delete(id) },
  setInterval(fn) { const id = nextTimer++; timers.set(id, fn); return id },
  clearInterval(id) { timers.delete(id) },
  localStorage: {
    getItem() { return null },
    setItem() {},
  },
}
context.window = context
context.window.location = { protocol: 'http:', port: '4097', host: '127.0.0.1:4097' }
context.window.__VIBE_TEST_MODE__ = true

vm.createContext(context)
vm.runInContext(fs.readFileSync(legacyAppPath, 'utf8'), context, { filename: legacyAppPath })

const test = context.window.__vibeTest
assert(test, 'legacy app did not expose test harness')

test.handleWSStateChange('CONNECTED')
test.handleWSMessage({ type: 'status', sourceId: 'ui-stats', sessionId: 's1', status: 'THINKING', task: 'Stats UI test', duration: 0, toolCount: 0, errorCount: 0 })
now += 2500
test.renderStatsTick()
assert(elements['stat-duration'].textContent === '00:02', `duration did not tick: ${elements['stat-duration'].textContent}`)

test.handleWSMessage({ type: 'tool', sourceId: 'ui-stats', sessionId: 's1', id: 'tool-1', name: 'bash', status: 'started', args: {}, ts: now })
assert(elements['stat-tools'].textContent === '1', `tool start not counted: ${elements['stat-tools'].textContent}`)

test.handleWSMessage({ type: 'tool', sourceId: 'ui-stats', sessionId: 's1', id: 'tool-1', name: 'bash', status: 'completed', args: {}, ts: now })
assert(elements['stat-tools'].textContent === '1', `tool completion double-counted: ${elements['stat-tools'].textContent}`)

test.handleWSMessage({ type: 'tool', sourceId: 'ui-stats', sessionId: 's1', id: 'tool-1', name: 'bash', status: 'failed', args: {}, ts: now })
assert(elements['stat-tools'].textContent === '1', `duplicate failed double-counted tool: ${elements['stat-tools'].textContent}`)
assert(elements['stat-errors'].textContent === '1', `tool failure not counted as one error: ${elements['stat-errors'].textContent}`)

test.handleWSMessage({ type: 'log', sourceId: 'ui-stats', sessionId: 's1', level: 'error', message: 'Tool bash failed', ts: now })
assert(elements['stat-errors'].textContent === '1', `tool failure log double-counted: ${elements['stat-errors'].textContent}`)

test.handleWSMessage({ type: 'log', sourceId: 'ui-stats', sessionId: 's1', level: 'error', message: 'plain error', ts: now })
assert(elements['stat-errors'].textContent === '2', `plain error not counted: ${elements['stat-errors'].textContent}`)

test.handleWSMessage({ type: 'status', sourceId: 'ui-stats', sessionId: 's1', status: 'IDLE', task: 'Done', duration: 0, toolCount: 0, errorCount: 0 })
const frozen = elements['stat-duration'].textContent
now += 5000
test.renderStatsTick()
assert(elements['stat-duration'].textContent === frozen, `duration did not freeze at idle: ${elements['stat-duration'].textContent} !== ${frozen}`)

console.log(`ok tools=${elements['stat-tools'].textContent} errors=${elements['stat-errors'].textContent} duration=${elements['stat-duration'].textContent}`)
