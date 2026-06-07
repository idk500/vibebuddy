# VibeBuddy — 测试策略

> 版本: v0.1.0 | 日期: 2026-06-06 | A-SPICE: SWE.4 + SWE.5

## 1. 测试目标

确保 VibeBuddy 满足需求规格，验证功能正确性、性能、可靠性。

## 2. 测试层级

```
┌─────────────────────────────────────────┐
│           E2E 测试 (Level 5)            │  真机 + 真实 AI 工具
├─────────────────────────────────────────┤
│       集成测试 (Level 4)                │  Firefox 合成 + Relay Hub
├─────────────────────────────────────────┤
│      Relay 注入测试 (Level 3)           │  HTTP 注入事件
├─────────────────────────────────────────┤
│      VM 单元测试 (Level 2)              │  纯逻辑验证
├─────────────────────────────────────────┤
│       静态分析 (Level 1)                │  TypeScript + ESLint
└─────────────────────────────────────────┘
```

## 3. 测试范围

### 3.1 单元测试 (SWE.4)

**目标：** 验证独立函数/模块的正确性

**覆盖范围：**
- 状态机转换逻辑
- 数据结构操作
- 回复路由算法
- 工具函数

**工具：** Vitest

**覆盖率目标：** 80%

**执行频率：** 每次提交

### 3.2 集成测试 (SWE.5)

**目标：** 验证模块间交互

**覆盖范围：**
- Plugin → Hub → PWA 数据流
- PWA → Hub → Plugin 回复流
- 多 Source 隔离
- 断线重连

**工具：** Node.js + ws + fetch

**执行频率：** 每次合并

### 3.3 E2E 测试 (SWE.6)

**目标：** 验证真实场景

**覆盖范围：**
- Firefox 合成浏览器测试
- 真机浏览器测试
- OpenCode 真实会话

**工具：** Firefox + Selenium/Playwright

**执行频率：** 发布前

---

## 4. 测试用例

### 4.1 单元测试用例

#### TC-U01: 状态机转换

```typescript
describe('StateMachine', () => {
  it('IDLE → THINKING on message.updated', () => {
    const result = transition('IDLE', { type: 'message.updated', role: 'assistant' })
    expect(result).toBe('THINKING')
  })

  it('THINKING → EXECUTING on tool.call.started', () => {
    const result = transition('THINKING', { type: 'tool.call.started' })
    expect(result).toBe('EXECUTING')
  })

  it('* → ERROR on session.error', () => {
    expect(transition('IDLE', { type: 'session.error' })).toBe('ERROR')
    expect(transition('THINKING', { type: 'session.error' })).toBe('ERROR')
    expect(transition('EXECUTING', { type: 'session.error' })).toBe('ERROR')
  })

  it('timeout settles to IDLE', () => {
    const result = settleAfterTimeout('THINKING', 20000)
    expect(result).toBe('IDLE')
  })
})
```

#### TC-U02: 回复路由隔离

```typescript
describe('ReplyRouter', () => {
  it('routes reply to correct source', () => {
    const hub = createHub()
    hub.registerSource({ sourceId: 'opencode:A', tool: 'opencode' })
    hub.registerSource({ sourceId: 'zcode:B', tool: 'zcode' })
    
    hub.addPendingRequest({ sourceId: 'opencode:A', requestId: 'req1' })
    
    hub.handleReply({ sourceId: 'opencode:A', requestId: 'req1', reply: 'once' })
    
    const repliesA = hub.getReplies('opencode:A')
    const repliesB = hub.getReplies('zcode:B')
    
    expect(repliesA).toHaveLength(1)
    expect(repliesB).toHaveLength(0)
  })

  it('rejects reply with wrong sourceId', () => {
    const hub = createHub()
    hub.registerSource({ sourceId: 'opencode:A', tool: 'opencode' })
    hub.addPendingRequest({ sourceId: 'opencode:A', requestId: 'req1' })
    
    const result = hub.handleReply({ sourceId: 'zcode:B', requestId: 'req1', reply: 'once' })
    
    expect(result.status).toBe('failed')
  })

  it('rejects expired request', () => {
    const hub = createHub({ ttlMs: 100 })
    hub.registerSource({ sourceId: 'opencode:A', tool: 'opencode' })
    hub.addPendingRequest({ sourceId: 'opencode:A', requestId: 'req1', createdAt: Date.now() - 200 })
    
    const result = hub.handleReply({ sourceId: 'opencode:A', requestId: 'req1', reply: 'once' })
    
    expect(result.status).toBe('expired')
  })
})
```

#### TC-U03: 状态优先级

```typescript
describe('StatePriority', () => {
  it('ERROR has highest priority', () => {
    const result = highestPriority(['IDLE', 'ERROR', 'THINKING'])
    expect(result).toBe('ERROR')
  })

  it('EXECUTING > THINKING', () => {
    const result = highestPriority(['THINKING', 'EXECUTING', 'IDLE'])
    expect(result).toBe('EXECUTING')
  })
})
```

### 4.2 集成测试用例

#### TC-I01: 端到端状态流

```javascript
describe('End-to-End Status Flow', () => {
  it('plugin → hub → pwa', async () => {
    // Start hub
    const hub = await startHub()
    
    // Register source
    await fetch('http://localhost:4097/api/register', {
      method: 'POST',
      body: JSON.stringify({ sourceId: 'test:1', tool: 'test' })
    })
    
    // Connect PWA
    const ws = new WebSocket('ws://localhost:4097/ws')
    const messages = []
    ws.on('message', (data) => messages.push(JSON.parse(data)))
    
    await sleep(100)
    
    // Send status event
    await fetch('http://localhost:4097/api/event', {
      method: 'POST',
      body: JSON.stringify({
        type: 'status',
        sourceId: 'test:1',
        status: 'THINKING',
        task: 'Test task'
      })
    })
    
    await sleep(100)
    
    // Verify PWA received
    const statusMsg = messages.find(m => m.type === 'status')
    expect(statusMsg).toBeDefined()
    expect(statusMsg.status).toBe('THINKING')
    
    hub.close()
  })
})
```

#### TC-I02: 权限确认闭环

```javascript
describe('Permission Approval Loop', () => {
  it('pwa → hub → plugin', async () => {
    const hub = await startHub()
    
    // Register source
    await fetch('http://localhost:4097/api/register', {
      method: 'POST',
      body: JSON.stringify({ sourceId: 'test:1', tool: 'test' })
    })
    
    // Request permission
    await fetch('http://localhost:4097/api/event', {
      method: 'POST',
      body: JSON.stringify({
        type: 'permission',
        sourceId: 'test:1',
        id: 'req1',
        tool: 'bash',
        message: 'Allow?'
      })
    })
    
    // Connect PWA and send reply
    const ws = new WebSocket('ws://localhost:4097/ws')
    await sleep(100)
    
    ws.send(JSON.stringify({
      type: 'permission_reply',
      sourceId: 'test:1',
      requestId: 'req1',
      reply: 'once'
    }))
    
    await sleep(100)
    
    // Poll reply
    const res = await fetch('http://localhost:4097/api/replies?sourceId=test:1')
    const data = await res.json()
    
    expect(data.replies).toHaveLength(1)
    expect(data.replies[0].reply).toBe('once')
    
    hub.close()
  })
})
```

---

## 5. 测试环境

### 5.1 单元测试环境

- Node.js 18+
- Vitest
- 无外部依赖

### 5.2 集成测试环境

- Node.js 18+
- Relay Server
- WebSocket client
- HTTP client

### 5.3 E2E 测试环境

- Firefox 浏览器
- Relay Server
- OpenCode (可选)
- 真机设备 (可选)

---

## 6. 测试执行

### 6.1 本地执行

```bash
# 单元测试
npm run test

# 集成测试
npm run test:integration

# E2E 测试
npm run test:e2e

# 全部测试
npm run test:all
```

### 6.2 CI 执行

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      - run: npm ci
      - run: npm run test
      - run: npm run lint
      - run: npm run typecheck
```

---

## 7. 测试报告

### 7.1 报告内容

- 测试用例数量
- 通过/失败数量
- 覆盖率百分比
- 失败用例详情

### 7.2 报告格式

- 控制台输出
- JUnit XML (CI)
- HTML 报告 (发布)

---

## 8. 缺陷管理

### 8.1 缺陷分类

| 级别 | 描述 | 响应时间 |
|------|------|----------|
| P0 | 阻塞性 | 24h |
| P1 | 严重 | 48h |
| P2 | 一般 | 1 周 |
| P3 | 轻微 | 下版本 |

### 8.2 缺陷流程

1. 发现 → 记录
2. 分类 → 分配
3. 修复 → 验证
4. 关闭

---

## 9. 验收标准

### 9.1 发布门槛

- ✅ 单元测试通过率 100%
- ✅ 单元测试覆盖率 ≥ 80%
- ✅ 集成测试通过率 100%
- ✅ E2E 测试通过率 100%
- ✅ TypeScript 编译无错误
- ✅ ESLint 无错误

### 9.2 质量指标

| 指标 | 目标 |
|------|------|
| 单元测试覆盖率 | ≥ 80% |
| 集成测试覆盖率 | ≥ 60% |
| E2E 测试覆盖率 | ≥ 40% |
| 缺陷密度 | < 5/KLOC |
