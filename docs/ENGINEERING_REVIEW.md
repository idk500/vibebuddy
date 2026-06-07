# VibeBuddy 工程审查报告

> 日期: 2026-06-06 | 审查人: Kiro | A-SPICE 对齐评估

## 执行摘要

**整体评级: C+ (需改进)**

项目功能可用，但工程实践薄弱。主要问题：
- 状态机逻辑分散，缺乏形式化定义
- 数据结构设计不完整，类型定义与实现不一致
- 接口契约模糊，错误处理不统一
- 测试覆盖率为零，质量门禁缺失
- 文档与代码不同步

---

## 1. 状态机分析

### 1.1 当前问题

**安灯状态 (AndonStatus)** 定义了 6 种状态，但转换逻辑分散在多处：

| 位置 | 职责 |
|------|------|
| `opencode.ts` | SDK 事件 → 状态映射 |
| `opencode-plugin/index.js` | Plugin 事件 → 状态映射 |
| `zcode-adapter/index.js` | ZCode 日志 → 状态映射 |
| `legacy-app.js` | 前端本地状态兜底 |
| `index.ts` | Relay Hub 超时收敛 |

**问题：**
1. 状态转换规则无中心定义
2. 多个 adapter 可能发出冲突状态
3. 状态优先级未形式化（ERROR > EXECUTING > THINKING > IDLE 仅在注释中提及）
4. 缺少状态转换日志/追踪

### 1.2 缺失的状态机规格

应定义：

```typescript
// 建议新增: server/src/state-machine.ts

interface StateTransition {
  from: AndonStatus
  to: AndonStatus
  trigger: string
  guard?: (ctx: SessionContext) => boolean
  action?: (ctx: SessionContext) => void
}

const TRANSITIONS: StateTransition[] = [
  { from: 'IDLE', to: 'THINKING', trigger: 'message.updated' },
  { from: 'IDLE', to: 'EXECUTING', trigger: 'tool.call.started' },
  { from: 'THINKING', to: 'EXECUTING', trigger: 'tool.call.started' },
  { from: 'EXECUTING', to: 'THINKING', trigger: 'tool.call.completed' },
  { from: 'THINKING', to: 'IDLE', trigger: 'message.completed' },
  { from: '*', to: 'ERROR', trigger: 'session.error' },
  { from: 'ERROR', to: 'IDLE', trigger: 'session.idle' },
]

const STATE_PRIORITY: Record<AndonStatus, number> = {
  ERROR: 5,
  EXECUTING: 4,
  THINKING: 3,
  IDLE: 2,
  COMPLETE: 1,
  DISCONNECTED: 0,
}
```

### 1.3 推荐改进

- [ ] 创建 `server/src/state-machine.ts` 形式化状态转换
- [ ] 所有 adapter 通过 Relay Hub 统一状态仲裁
- [ ] 前端仅接收仲裁后状态，移除本地状态推断
- [ ] 添加状态转换审计日志

---

## 2. 数据结构分析

### 2.1 类型定义问题

**`types.ts` 与实际使用不一致：**

| 类型 | 定义 | 实际问题 |
|------|------|----------|
| `SessionState` | 定义完整 | **未被任何代码使用** |
| `PendingRequest` | 缺少 `message` 字段 | 实际 permission 消息携带 |
| `QuestionMessage` | `sessionID` 大写 | 应为 `sessionId` 统一 |
| `PermissionMessage` | 同上 | 不一致 |
| `AdapterReply` | 缺少 `message` | reply_ack 需要 |

**全局变量散落：**

```javascript
// opencode-plugin/index.js
let opencodeServerUrl = '...'  // 全局可变状态

// zcode-adapter/index.js
let byteOffset = 0
let currentFile = null
const sessions = new Map()  // 无类型约束

// legacy-app.js
var statsMap = {}
var activeSourceKey = null
var globalStatsTimer = null
```

### 2.2 内存数据结构

**Relay Hub 状态结构：**

```typescript
// index.ts 内联定义，应提取到 types.ts
interface RelayHubState {
  sources: Map<string, SourceInstance>
  terminals: Map<string, Terminal>
  pendingRequests: Map<string, PendingRequest>
  replyQueues: Map<string, AdapterReply[]>
  statusTimers: Map<string, ReturnType<typeof setTimeout>>
  lastStatuses: Map<string, SourceStatusSnapshot>
  stats: { ... }
}
```

**问题：**
- 内联定义，不可复用
- 无持久化/恢复机制
- 无容量限制（内存泄漏风险）

### 2.3 推荐改进

- [ ] 清理未使用类型 (`SessionState`)
- [ ] 统一 `sessionId` 命名（移除 `sessionID`）
- [ ] 提取 `RelayHubState` 到 `types.ts`
- [ ] 添加 `maxPendingRequests` 限制
- [ ] 添加内存使用监控

---

## 3. 接口分析

### 3.1 HTTP API 问题

| 端点 | 问题 |
|------|------|
| `POST /api/register` | 无幂等性保证，重复注册创建重复 source |
| `POST /api/event` | 缺少 `sourceId` 时静式注册，应拒绝 |
| `GET /api/replies` | 轮询模式效率低，应考虑 WebSocket 推送 |
| `POST /api/config` | 全局变量修改，无事务保护 |

**请求/响应格式不一致：**

```jsonc
// 成功响应三种格式:
{ "ok": true }                    // /api/config
{ "ok": true, "sourceId": "..." } // /api/register
{ "ok": true, "sent": 1 }         // /api/event

// 错误响应两种格式:
{ "error": "..." }                // 通用
{ "ok": false, "error": "..." }   // 未使用
```

### 3.2 WebSocket 消息问题

**消息格式不一致：**

```jsonc
// Server → Phone
{ "type": "status", "sourceId": "..." }     // sourceId 可选
{ "type": "question", "sessionID": "..." }  // 大写 D
{ "type": "connected", "terminalId": "..." } // 额外字段

// Phone → Server
{ "type": "permission_reply", "requestID": "..." }  // 大写 ID
{ "type": "question_reply", "requestID": "..." }    // 大写 ID
```

**问题：**
- `sessionId` vs `sessionID` vs `sessionID` 混用
- `requestId` vs `requestID` 混用
- `sourceId` 可选性不明确

### 3.3 推荐改进

- [ ] 统一响应格式: `{ ok: boolean, data?: T, error?: string }`
- [ ] 统一字段命名: `sessionId`, `requestId` (camelCase)
- [ ] 添加 OpenAPI 规格文档
- [ ] 添加请求验证中间件
- [ ] 考虑 `/api/replies` 改为 WebSocket 推送

---

## 4. 数据流分析

### 4.1 当前数据流

```
OpenCode Plugin ──HTTP──► Relay Hub ──WS──► Phone
                      │                │
                      ▼                ▼
                 register          broadcast
                 event             status/tool/log
                 ───────────────────────────────
                 Phone ──WS──► Relay Hub ──HTTP──► Plugin
                               │
                               ▼
                          reply queue
                          (polling)
```

### 4.2 问题

1. **双向通信不对称：** Plugin → Hub 是 HTTP，Hub → Plugin 是轮询
2. **无背压控制：** 快速事件可能淹没客户端
3. **无消息确认：** WebSocket 发送后无确认机制
4. **无重试机制：** HTTP 失败后静默丢弃

### 4.3 推荐改进

- [ ] Plugin 使用 WebSocket 双向通信（替代 HTTP + 轮询）
- [ ] 添加消息序列号和确认
- [ ] 添加发送缓冲区和背压控制
- [ ] 添加失败重试队列

---

## 5. 动静态架构分析

### 5.1 静态架构

```
vibe-companion/
├── server/          # TypeScript (编译后 dist/)
│   └── src/
│       ├── index.ts      # 543 行，职责过多
│       ├── opencode.ts   # 事件映射
│       ├── relay.ts      # 占位，无实现
│       ├── audio.ts      # 占位，无实现
│       └── types.ts      # 类型定义
├── app/             # 无构建
│   └── js/
│       ├── legacy-app.js # 763 行，单体结构
│       ├── ws.js         # 连接管理
│       ├── andon.js      # 状态渲染 (未使用)
│       ├── log.js        # 日志渲染
│       └── ...
└── opencode-plugin/ # JavaScript
    └── index.js     # 384 行，无类型
```

**问题：**
- `index.ts` 承担 HTTP + WebSocket + Hub 逻辑，违反单一职责
- `legacy-app.js` 是单体，模块化 `app.js` 未被使用
- `andon.js` 定义了 `AndonRenderer` 但 `legacy-app.js` 使用 `SessionCardRenderer`
- `relay.ts` 和 `audio.ts` 是空壳

### 5.2 动态架构

**运行时组件：**

| 组件 | 进程 | 通信 |
|------|------|------|
| Relay Server | Node.js | HTTP + WS |
| OpenCode Plugin | OpenCode 进程 | HTTP |
| ZCode Adapter | 独立进程 | HTTP + 文件监控 |
| PWA | 浏览器 | WS |

**进程间依赖：**

```
OpenCode → Plugin → Relay Hub ← Phone
                        ↑
ZCode Adapter ──────────┘
```

**问题：**
- 无服务发现机制
- 无健康检查
- 无优雅关闭

### 5.3 推荐改进

- [ ] 拆分 `index.ts` 为 `http-server.ts`, `ws-server.ts`, `hub.ts`
- [ ] 统一前端使用模块化代码，移除 `legacy-app.js`
- [ ] 清理或实现 `relay.ts`, `audio.ts`
- [ ] 添加进程健康检查端点
- [ ] 添加优雅关闭处理

---

## 6. 标志位分析

### 6.1 当前标志位

| 标志位 | 位置 | 作用 |
|--------|------|------|
| `connected` | `opencode.ts` | SDK 连接状态 |
| `connected` | `legacy-app.js` | 全局连接状态 |
| `active` | `statsMap` | 会话活跃状态 |
| `statusErrorCounted` | `statsMap` | 错误计数标记 |
| `registered` | `zcode-adapter` | Source 注册状态 |
| `FORCE_TOOL_APPROVAL` | 环境变量 | 强制工具审批 |

**问题：**
- 同名标志位在不同模块含义不同
- 缺少原子操作保护
- 缺少持久化

### 6.2 推荐改进

- [ ] 统一命名规范：`isConnected`, `isRegistered`, `hasErrorCounted`
- [ ] 使用状态对象替代散落的标志位
- [ ] 添加状态变更日志

---

## 7. 错误处理分析

### 7.1 当前问题

```javascript
// opencode-plugin/index.js
async function postJson(path, msg) {
  try {
    const res = await fetch(...)
    return res.ok
  } catch {
    return false  // 静默失败，无日志
  }
}

// legacy-app.js
window.onerror = function (msg, _url, line) {
  showErr('Error: ' + msg + ' (L' + line + ')')
  // 无上报，无恢复
}
```

**问题：**
- 大量 `catch { return }` 静默失败
- 无错误分类（网络错误 vs 业务错误）
- 无错误上报机制
- 无重试策略

### 7.2 推荐改进

- [ ] 统一错误类型：`NetworkError`, `ValidationError`, `TimeoutError`
- [ ] 添加错误日志上下文
- [ ] 实现重试策略（指数退避）
- [ ] 添加错误监控端点

---

## 8. 测试分析

### 8.1 当前状态

| 测试类型 | 状态 | 覆盖率 |
|----------|------|--------|
| 单元测试 | ❌ 无 | 0% |
| 集成测试 | ⚠️ E2E 脚本 | 未知 |
| 端到端测试 | ✅ Firefox 合成 | 手动触发 |

**E2E 脚本：**
- `verify-stats-events.mjs` - 事件统计验证
- `e2e-firefox-opencode-run.mjs` - OpenCode 集成
- `e2e-firefox-relay-prompt.mjs` - 权限确认流程

**问题：**
- 无单元测试框架
- 无测试覆盖率报告
- E2E 依赖 Firefox，无跨浏览器测试
- 无 CI 集成

### 8.2 推荐改进

- [ ] 引入 Vitest 或 Jest 单元测试框架
- [ ] 测试覆盖率目标：80%
- [ ] 添加 `npm run test` 命令
- [ ] 添加 CI 配置（GitHub Actions）
- [ ] 添加测试报告生成

---

## 9. 代码质量门禁

### 9.1 当前状态

| 检查项 | 命令 | 状态 |
|--------|------|------|
| TypeScript | `npm run typecheck` | ⚠️ 手动 |
| ESLint | `npm run lint` | ⚠️ 手动 |
| 测试 | - | ❌ 无 |
| 构建 | `npm run build` | ⚠️ 手动 |

### 9.2 推荐改进

- [ ] 添加 pre-commit hook (husky)
- [ ] 添加 CI pipeline
- [ ] 添加 `npm run check` 组合命令
- [ ] 添加代码覆盖率门禁

---

## 10. 改进优先级

### P0 - 阻塞性问题

1. 添加单元测试框架和核心测试
2. 统一 `sessionId`/`sessionID` 命名
3. 修复 `types.ts` 与实现不一致

### P1 - 重要改进

4. 创建状态机规格模块
5. 拆分 `index.ts` 职责
6. 统一 API 响应格式
7. 添加错误处理策略

### P2 - 质量提升

8. 添加 OpenAPI 规格
9. 清理未使用代码
10. 添加 CI/CD

---

## 附录：A-SPICE 评估

| 过程 | 当前状态 | 目标 |
|------|----------|------|
| SYS.1 需求分析 | ✅ 文档存在 | 达标 |
| SYS.2 系统需求 | ✅ 文档存在 | 达标 |
| SYS.3 系统架构 | ⚠️ 缺少动态视图 | 改进 |
| SWE.1 软件需求 | ⚠️ 缺少规格文档 | 改进 |
| SWE.2 软件架构 | ⚠️ 文档需更新 | 改进 |
| SWE.3 详细设计 | ❌ 无设计文档 | 建立 |
| SWE.4 单元验证 | ❌ 无单元测试 | 建立 |
| SWE.5 集成验证 | ⚠️ E2E 存在 | 扩展 |
| SWE.6 资质测试 | ⚠️ 手动测试 | 自动化 |
