# VibeBuddy — 技术规格说明书

> 版本: v0.1.0 | 日期: 2026-06-06 | A-SPICE: SWE.1

## 1. 引言

### 1.1 目的

本文档定义 VibeBuddy 的技术规格，作为需求与实现之间的桥梁。

### 1.2 范围

覆盖：
- Relay Hub 核心功能
- OpenCode/ZCode adapter 接口
- PWA 前端接口
- 通信协议

### 1.3 术语

| 术语 | 定义 |
|------|------|
| Source | AI 工具实例，以 `sourceId` 标识 |
| Session | 工具内的对话会话，以 `sessionId` 标识 |
| Terminal | 连接的显示终端（手机/桌面），以 `terminalId` 标识 |
| Pending Request | 等待用户回复的权限/问题请求 |
| Relay Hub | 中继服务器，管理 source/session/request/reply |

---

## 2. 状态机规格

### 2.1 Andon 状态定义

```typescript
type AndonStatus = 
  | 'DISCONNECTED'  // 终端未连接
  | 'IDLE'          // 空闲等待
  | 'THINKING'      // AI 思考中
  | 'EXECUTING'     // 执行工具
  | 'ERROR'         // 错误
  | 'COMPLETE'      // 任务完成
```

### 2.2 状态转换规则

| 当前状态 | 触发事件 | 目标状态 | 条件 |
|----------|----------|----------|------|
| DISCONNECTED | ws.connect | IDLE | - |
| IDLE | message.updated | THINKING | role=assistant, !completed |
| IDLE | tool.call.started | EXECUTING | - |
| THINKING | tool.call.started | EXECUTING | - |
| THINKING | message.completed | IDLE | - |
| THINKING | session.idle | IDLE | - |
| EXECUTING | tool.call.completed | THINKING | runningTools=0 |
| EXECUTING | tool.call.failed | THINKING | runningTools=0 |
| * | session.error | ERROR | - |
| * | timeout(20s) | IDLE | 无活动 |
| ERROR | session.idle | IDLE | - |

### 2.3 状态优先级

```typescript
const STATE_PRIORITY: Record<AndonStatus, number> = {
  ERROR: 5,
  EXECUTING: 4,
  THINKING: 3,
  IDLE: 2,
  COMPLETE: 1,
  DISCONNECTED: 0,
}

function highestPriority(statuses: AndonStatus[]): AndonStatus {
  return statuses.reduce((a, b) => 
    STATE_PRIORITY[b] > STATE_PRIORITY[a] ? b : a
  , 'IDLE')
}
```

---

## 3. 数据结构规格

### 3.1 Relay Hub 核心结构

```typescript
interface RelayHubState {
  // Source 注册表
  sources: Map<sourceId, SourceInstance>
  
  // 终端连接表
  terminals: Map<terminalId, Terminal>
  
  // 等待回复的请求
  pendingRequests: Map<`${sourceId}:${requestId}`, PendingRequest>
  
  // 各 source 的回复队列
  replyQueues: Map<sourceId, AdapterReply[]>
  
  // 状态超时定时器
  statusTimers: Map<`${sourceId}:${sessionId}`, TimerHandle>
  
  // 最新状态快照（用于新终端回放）
  lastStatuses: Map<`${sourceId}|${sessionId}`, SourceStatusSnapshot>
  
  // 统计信息
  stats: HubStats
}

interface SourceInstance {
  sourceId: string
  tool: 'opencode' | 'zcode' | 'kiro' | 'unknown'
  name: string
  serverUrl?: string
  cwd?: string
  capabilities: string[]
  lastSeen: number  // Unix timestamp ms
}

interface Terminal {
  id: string  // UUID
  ws: WebSocket
  type: 'phone' | 'desktop' | 'ide' | 'browser' | 'unknown'
  name?: string
  connectedAt: number
}

interface PendingRequest {
  kind: 'permission' | 'question'
  sourceId: string
  sessionId?: string
  requestId: string
  createdAt: number
  expiresAt: number
  payload: PermissionPayload | QuestionPayload
}

interface AdapterReply {
  ackId: string
  kind: 'permission' | 'question'
  sourceId: string
  sessionId?: string
  requestId: string
  reply?: 'once' | 'always' | 'reject'
  answers?: string[][]
  ts: number
}

interface SourceStatusSnapshot {
  sourceId: string
  sessionId?: string
  status: AndonStatus
  task: string
  duration: number
  toolCount: number
  errorCount: number
  ts: number
}

interface HubStats {
  startedAt: number
  eventsReceived: number
  lastEvent: ServerMessage | null
  lastEventAt: number | null
}
```

### 3.2 前端状态结构

```typescript
interface PWAState {
  // 连接状态
  connection: {
    state: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING'
    terminalId?: string
    reconnectAttempt: number
  }
  
  // 会话卡片
  sessions: Map<sessionKey, SessionCardState>
  
  // 活动日志
  log: LogEntry[]
  
  // 当前活动 source
  activeSourceKey?: string
}

interface SessionCardState {
  key: string  // `${sourceId}|${sessionId}`
  sourceId: string
  sessionId: string
  title: string
  status: AndonStatus
  task: string
  toolCount: number
  errorCount: number
  duration: number
  active: boolean
  permission?: PermissionPayload
  expanded: boolean
}

interface LogEntry {
  id: string
  type: 'tool' | 'log'
  level?: 'info' | 'warn' | 'error'
  message: string
  ts: number
  sourceKey?: string
}
```

---

## 4. 接口规格

### 4.1 HTTP API

#### 4.1.1 注册 Source

```
POST /api/register
Content-Type: application/json

Request:
{
  "sourceId": "opencode:12345:abc123",  // required
  "tool": "opencode",                   // optional, default "unknown"
  "name": "OpenCode 12345",             // optional, default sourceId
  "serverUrl": "http://localhost:11434", // optional
  "cwd": "/path/to/project",            // optional
  "capabilities": ["events", "permission.ask"]  // optional
}

Response: 200 OK
{
  "ok": true,
  "data": {
    "sourceId": "opencode:12345:abc123",
    "registered": true
  }
}

Response: 400 Bad Request
{
  "ok": false,
  "error": "sourceId required"
}
```

#### 4.1.2 上报事件

```
POST /api/event
Content-Type: application/json

Request:
{
  "type": "status" | "tool" | "log" | "permission" | "question",
  "sourceId": "...",  // required
  "sessionId": "...", // optional
  // ... 类型特定字段
}

Response: 200 OK
{
  "ok": true,
  "data": {
    "sent": 2  // 发送给多少终端
  }
}
```

#### 4.1.3 轮询回复

```
GET /api/replies?sourceId=...

Response: 200 OK
{
  "ok": true,
  "data": {
    "replies": [
      {
        "ackId": "ack_123",
        "kind": "permission",
        "requestId": "req_456",
        "reply": "once",
        "ts": 1716633600000
      }
    ]
  }
}
```

#### 4.1.4 诊断接口

```
GET /api/diagnostics

Response: 200 OK
{
  "ok": true,
  "data": {
    "clients": 2,
    "sources": [...],
    "pendingRequests": [...],
    "stats": {...}
  }
}
```

### 4.2 WebSocket 消息

#### 4.2.1 Server → Terminal

```typescript
// 连接确认
type ConnectedMessage = {
  type: 'connected'
  serverVersion: string
  terminalId: string
}

// 状态快照（连接后立即发送）
type SnapshotMessage = {
  type: 'snapshot'
  sources: Array<{
    sourceId: string
    tool: string
    name: string
    status?: SourceStatusSnapshot
  }>
}

// Source 注册通知
type SourceMessage = {
  type: 'source'
  sourceId: string
  tool: string
  name: string
  status: 'registered' | 'updated' | 'stale'
  ts: number
}

// 状态更新
type StatusMessage = {
  type: 'status'
  sourceId: string
  sessionId?: string
  status: AndonStatus
  task: string
  duration: number
  toolCount: number
  errorCount: number
}

// 工具事件
type ToolMessage = {
  type: 'tool'
  id?: string
  sourceId: string
  sessionId?: string
  name: string
  status: 'started' | 'completed' | 'failed'
  args: Record<string, unknown>
  title?: string
  ts: number
}

// 日志
type LogMessage = {
  type: 'log'
  sourceId?: string
  sessionId?: string
  level: 'info' | 'warn' | 'error'
  message: string
  ts: number
}

// 权限请求
type PermissionMessage = {
  type: 'permission'
  id: string
  sourceId: string
  sessionId?: string
  tool: string
  message: string
  patterns?: string[]
}

// 问题请求
type QuestionMessage = {
  type: 'question'
  id: string
  sourceId: string
  sessionId?: string
  questions: Array<{
    header: string
    question: string
    options: Array<{ label: string; description: string }>
    multiple?: boolean
    custom?: boolean
  }>
}

// 回复确认
type ReplyAckMessage = {
  type: 'reply_ack'
  ackId: string
  requestId: string
  sourceId: string
  sessionId?: string
  status: 'accepted' | 'failed' | 'expired'
  message?: string
}
```

#### 4.2.2 Terminal → Server

```typescript
// 终端标识
type IdentifyMessage = {
  type: 'identify'
  terminalType: 'phone' | 'desktop' | 'ide' | 'browser'
  terminalName?: string
}

// 权限回复
type PermissionReplyMessage = {
  type: 'permission_reply'
  ackId?: string  // 自动生成若未提供
  sourceId: string
  sessionId?: string
  requestId: string
  reply: 'once' | 'always' | 'reject'
}

// 问题回复
type QuestionReplyMessage = {
  type: 'question_reply'
  ackId?: string
  sourceId: string
  sessionId?: string
  requestId: string
  answers: string[][]  // [[label1], [label2]] for multiple
}

// 问题拒绝
type QuestionRejectMessage = {
  type: 'question_reject'
  ackId?: string
  sourceId: string
  sessionId?: string
  requestId: string
}
```

---

## 5. Adapter 接口规格

### 5.1 OpenCode Plugin 接口

```typescript
interface OpenCodePlugin {
  // 插件入口
  (input: { serverUrl: string }): Promise<PluginHooks>
}

interface PluginHooks {
  // 事件钩子
  event?(event: OpenCodeEvent): Promise<void>
  
  // 权限钩子
  'permission.ask'?(input: PermissionInput, output: PermissionOutput): Promise<void>
  
  // 工具执行前钩子
  'tool.execute.before'?(input: ToolInput, output: ToolOutput): Promise<void>
}
```

### 5.2 ZCode Adapter 接口

```typescript
interface ZCodeAdapterConfig {
  relayUrl: string      // default: http://127.0.0.1:4097
  logDir: string        // default: ~/.zcode/cli/log
  sessionsDir: string   // default: ~/.zcode/v2/sessions
  pollMs: number        // default: 500
}
```

---

## 6. 非功能规格

### 6.1 性能

| 指标 | 规格 | 验证方法 |
|------|------|----------|
| 状态更新延迟 | < 500ms | E2E 测试 |
| 权限回复延迟 | < 1000ms | E2E 测试 |
| 内存占用 (Server) | < 100MB | 进程监控 |
| 内存占用 (PWA) | < 30MB | DevTools |
| WebSocket 连接数 | 最多 10 | 压力测试 |

### 6.2 可靠性

| 指标 | 规格 |
|------|------|
| 重连延迟 | 指数退避 1s → 30s |
| Pending request TTL | 120s (可配置) |
| Status settle timeout | 20s (可配置) |
| Stale session timeout | 60s |

### 6.3 安全性

| 要求 | 实现 |
|------|------|
| 可选认证 | `VIBE_AUTH_TOKEN` 环境变量 |
| 路径遍历防护 | `resolve()` + `startsWith()` 检查 |
| XSS 防护 | 仅 `textContent`，无 `innerHTML` |
| 权限默认拒绝 | 超时/不可达时不自动允许 |

---

## 7. 验证清单

### 7.1 单元测试清单

- [ ] 状态机转换规则
- [ ] 状态优先级仲裁
- [ ] Pending request 生命周期
- [ ] Reply 路由隔离
- [ ] 超时处理

### 7.2 集成测试清单

- [ ] Plugin → Hub → PWA 状态流
- [ ] PWA → Hub → Plugin 回复流
- [ ] 多 source 隔离
- [ ] 断线重连

### 7.3 E2E 测试清单

- [ ] Firefox 合成测试
- [ ] 真机测试
- [ ] 多浏览器测试
