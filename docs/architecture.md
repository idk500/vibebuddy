# VibeBuddy — 系统架构

> 版本: v0.1.0 | 日期: 2026-06-06 | A-SPICE: SYS.3 + SWE.2

## 1. 系统架构概览

```
┌─────────────────────┐         WiFi / LAN          ┌─────────────────────────────────────────┐
│   Android Phone     │ ◄──────── WebSocket ──────► │ PC (Windows/Linux/Mac)                  │
│                     │                              │                                         │
│   ┌───────────────┐ │                              │ ┌─────────────────────────────────────┐ │
│   │  PWA Frontend │ │                              │ │ Relay Hub :4097                    │ │
│   │  (Browser)    │ │                              │ │ - source registry                  │ │
│   │               │ │                              │ │ - session registry                 │ │
│   │ - Andon UI    │ │                              │ │ - pending request registry         │ │
│   │ - Prompt UI   │ │                              │ │ - reply queue + ACK broadcast      │ │
│   │ - Voice Input │ │                              │ └───────────────┬─────────────────────┘ │
│   └───────────────┘ │                                              HTTP Adapter API          │
└─────────────────────┘                                     ┌──────────┼──────────┬──────────┐ │
                                                            ▼          ▼          ▼          ▼ │
                                                     ┌──────────┐ ┌────────┐ ┌──────┐ ┌──────┐│
                                                     │ OpenCode │ │ ZCode  │ │ Kiro │ │ ...  ││
                                                     │ Plugin   │ │Adapter │ │Adptr │ │      ││
                                                     └──────────┘ └────────┘ └──────┘ └──────┘│
                                                                                                 │
                                                     ┌────────────────┐                         │
                                                     │ Audio Output   │                         │
                                                     │ (Phase 2)      │                         │
                                                     └────────────────┘                         │
                                                     └─────────────────────────────────────────┘
```

## 2. 核心模块设计

### 2.1 Relay Hub (server/src/hub.ts)

**职责：** 管理 sources, terminals, pending requests, reply queues。

**核心数据结构：**

```typescript
interface RelayHubState {
  sources: Map<sourceId, SourceInstance>       // 注册的 AI 工具实例
  terminals: Map<terminalId, Terminal>         // 连接的显示终端
  pendingRequests: Map<key, PendingRequest>    // 等待回复的请求
  replyQueues: Map<sourceId, AdapterReply[]>   // 各 source 的回复队列
  statusTimers: Map<key, Timer>                // 状态超时定时器
  lastStatuses: Map<key, StatusSnapshot>       // 最新状态快照
  stats: HubStats                              // 统计信息
}
```

**API：**

| 方法 | 功能 |
|------|------|
| `registerSource()` | 注册/更新 source |
| `addPendingRequest()` | 添加等待回复的请求 |
| `handleReply()` | 处理终端回复 |
| `getReplies()` | 获取 source 的回复队列 |
| `buildSnapshot()` | 构建状态快照（用于新终端回放）|

### 2.2 状态机 (server/src/state-machine.ts)

**职责：** 形式化定义 Andon 状态转换规则。

**状态定义：**

| 状态 | 颜色 | 含义 |
|------|------|------|
| DISCONNECTED | 深灰 #475569 | 终端未连接 |
| IDLE | 靛蓝 #3B82F6 | 空闲等待 |
| THINKING | 琥珀 #F59E0B | AI 思考中 |
| EXECUTING | 翠绿 #10B981 | 执行工具 |
| ERROR | 赤红 #EF4444 | 错误 |
| COMPLETE | 亮绿 #34D399 | 任务完成 |

**状态优先级：**

```
ERROR(5) > EXECUTING(4) > THINKING(3) > IDLE(2) > COMPLETE(1) > DISCONNECTED(0)
```

**转换规则：** 详见 `state-machine.ts` 的 `TRANSITIONS` 数组。

### 2.3 HTTP Server (server/src/index.ts)

**端点：**

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/register` | POST | 注册 source |
| `/api/event` | POST | 上报事件 |
| `/api/replies` | GET | 轮询回复 |
| `/api/diagnostics` | GET | 诊断信息 |
| `/api/test` | POST | 测试事件注入 |

### 2.4 WebSocket Handler (server/src/index.ts)

**消息类型：**

| 类型 | 方向 | 功能 |
|------|------|------|
| `connected` | Server→Client | 连接确认 |
| `snapshot` | Server→Client | 状态快照 |
| `status` | Server→Client | 状态更新 |
| `tool` | Server→Client | 工具事件 |
| `permission` | Server→Client | 权限请求 |
| `permission_reply` | Client→Server | 权限回复 |
| `reply_ack` | Server→Client | 回复确认 |

### 2.5 PWA Frontend (app/js/legacy-app.js)

**职责：** 手机端 UI，显示安灯状态、处理权限确认。

**核心组件：**

- `WSClient` — WebSocket 连接管理（自动重连）
- `SessionCardRenderer` — 多会话卡片渲染
- `LogRenderer` — 活动日志渲染

**状态管理：**

```javascript
statsMap = { [sessionKey]: { toolCount, errorCount, duration, active } }
activeSourceKey = "sourceId|sessionId"  // 当前活动会话
```

## 3. 数据流

### 3.1 状态更新流

```
OpenCode Event → Plugin → POST /api/event → Relay Hub → WS broadcast → PWA
```

延迟预算：~35ms (SDK ~10ms + Relay ~5ms + WS ~5ms + WiFi ~5ms + DOM ~10ms)

### 3.2 权限确认流

```
Plugin POST /api/event(permission)
  → Hub creates pending request
  → WS broadcast permission
  → PWA shows prompt
  → User taps Allow/Reject
  → WS permission_reply
  → Hub validates, queues reply, broadcasts reply_ack
  → Plugin GET /api/replies
  → Plugin sets output.status
```

### 3.3 状态收敛策略

三层兜底：
1. **Adapter/Plugin** — 映射工具事件到 Andon 状态
2. **Relay Hub** — 20s 无活动自动收敛到 IDLE
3. **PWA** — 25s 本地兜底

## 4. 技术栈

| 组件 | 技术 | 版本 |
|------|------|------|
| Server | Node.js + TypeScript | Node 18+, TS 5.0+ |
| WebSocket | ws | 8.x |
| Frontend | 纯 HTML/CSS/JS | Chrome 53+ |
| Unit Test | Vitest | 4.x |

## 5. 文件结构

```
server/src/
├── index.ts           # HTTP + WebSocket 入口 (367 行)
├── hub.ts             # Relay Hub 核心逻辑 (215 行)
├── state-machine.ts   # 状态机规格 (111 行)
├── opencode.ts        # OpenCode SDK 集成 (380 行)
├── types.ts           # 类型定义 (150 行)
├── hub.test.ts        # Hub 单元测试 (319 行)
└── state-machine.test.ts  # 状态机测试 (176 行)

app/
├── index.html         # 单页应用
├── css/main.css       # 样式
└── js/legacy-app.js   # 主应用逻辑 (763 行)
```

## 6. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VIBE_PORT` | 4097 | 服务端口 |
| `VIBE_AUTH_TOKEN` | (无) | 认证 token |
| `VIBE_REQUEST_TTL_MS` | 120000 | 请求超时 |
| `VIBE_STATUS_SETTLE_MS` | 20000 | 状态收敛超时 |

## 7. 测试覆盖

| 类型 | 文件 | 用例数 |
|------|------|--------|
| 状态机测试 | state-machine.test.ts | 23 |
| Hub 测试 | hub.test.ts | 10 |
| E2E 测试 | app/scripts/*.mjs | 5 |

**运行测试：**

```bash
npm run test           # 单元测试
npm run test:coverage  # 覆盖率
npm run check          # 类型检查 + Lint + 测试
```

## 8. 安全考虑

- 可选 token 认证 (`VIBE_AUTH_TOKEN`)
- 路径遍历防护
- XSS 防护（无 innerHTML）
- 权限默认拒绝
