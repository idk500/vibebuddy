# VibeCoding Companion — 系统架构

> 版本: v0.1.0 | 日期: 2026-05-25 | A-SPICE: SYS.3 + SWE.2

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
                                                     │ OpenCode │ │ Claude │ │ Kilo │ │ ZCode││
                                                     │ Plugin   │ │Adapter │ │Adptr │ │Adptr ││
                                                     └──────────┘ └────────┘ └──────┘ └──────┘│
                                                                                                 │
                                                     ┌────────────────┐                         │
                                                     │ Audio Output   │                         │
                                                     │ (Phase 2)      │                         │
                                                     └────────────────┘                         │
                                                     └─────────────────────────────────────────┘
```

Phase 1.5 后 Relay Server 不再是“单 OpenCode URL 转发器”，而是工具无关的 **Relay Hub**。每个客户端/插件是一个 adapter source，所有请求和回复都按 `sourceId + sessionId + requestId` 绑定。

## 2. 组件设计

### 2.1 PWA Frontend (手机端)

**技术栈**: 纯 HTML5 + CSS3 + ES6+ JavaScript（零框架、零构建步骤）

**选择理由**:
- 最大兼容性：Android 6.0+ Chrome 53+ 无需安装
- 零依赖：无 npm/webpack/vite，直接用浏览器打开
- 低资源：无框架运行时开销，适合老旧设备
- 快速迭代：文件保存即刷新，无编译等待

**模块结构**:

```
app/
├── index.html           # 单页应用入口
├── manifest.json        # PWA 清单（添加到主屏幕）
├── sw.js                # Service Worker（离线缓存）
├── css/
│   └── main.css         # 全局样式 + 安灯主题
└── js/
    ├── app.js           # 应用状态管理 & 初始化
    ├── ws.js            # WebSocket 连接管理（自动重连）
    ├── andon.js         # 安灯状态渲染
    ├── log.js           # 活动日志面板
    ├── voice.js         # 麦克风录音（Phase 2）
    └── util.js          # 工具函数
```

**关键设计决策**:
- **不使用任何 JS 框架** — DOM 操作量小，手动操作更高效
- **CSS Grid + Flexbox 布局** — 横屏自适应，无媒体查询 hack
- **CSS 自定义属性** — 安灯状态色通过 `--status-color` 切换，零 JS 开销
- **全部 ES6 Module** — `<script type="module">`，Chrome 61+ 支持
- **无构建步骤** — 开发即生产代码，降低工具链复杂度

### 2.2 Relay Server (PC 端)

**技术栈**: Node.js 18+ + TypeScript + `ws` 库

**选择理由**:
- Node.js 原生异步 I/O，适合 WebSocket 中继
- TypeScript 提供类型安全，降低运行时错误
- `ws` 是最轻量的 WebSocket 库（无 Express 依赖）
- OpenCode SDK 是 JS/TS 原生

**模块结构**:

```
server/
├── package.json
├── tsconfig.json
├── .eslintrc.cjs
└── src/
    ├── index.ts         # 入口：启动 HTTP + WS 服务
    ├── opencode.ts      # OpenCode SDK 封装：事件订阅
    ├── relay.ts         # 事件中继：OpenCode → WebSocket
    ├── audio.ts         # 音频处理：接收/转发语音流
    └── types.ts         # 共享类型定义
```

**关键设计决策**:
- **TypeScript strict mode** — `strict: true`, `noUncheckedIndexedAccess`
- **单进程** — HTTP + WebSocket 共享端口，`ws` 的 `upgrade` 处理
- **零数据库** — 状态仅在内存，重启即重置
- **静态文件服务可选** — 开发时可 serve app/ 目录，生产时手机独立访问
- **Adapter Hub 模式** — source/session/request/reply 均在内存注册并按 ID 路由
- **安全默认值** — 权限请求超时或 adapter 断联时不自动允许

### 2.3 Adapter Hub 内部模型 (Phase 1.5)

| 概念 | 标识 | 说明 |
|------|------|------|
| Source | `sourceId` | 一个工具实例或插件实例，例如 `opencode:abc123` |
| Session | `sourceId + sessionId` | 工具内的对话/任务会话；可能为空但事件仍需绑定 source |
| Pending Request | `sourceId + requestId` | 等待手机回复的问题或权限请求 |
| Reply | `ackId + sourceId + requestId` | 手机端发出的确认/拒绝，进入 source 专属队列 |
| ACK | `reply_ack` | Relay Hub 对手机回复的处理结果：`accepted`/`failed`/`expired` |

Relay Hub 内存结构：

```ts
sources: Map<sourceId, SourceInstance>
sessions: Map<`${sourceId}:${sessionId}`, SessionState>
pendingRequests: Map<`${sourceId}:${requestId}`, PendingRequest>
replyQueues: Map<sourceId, AdapterReply[]>
```

### 2.4 OpenCode 集成

**主集成方式**: OpenCode Plugin → Relay Hub Adapter API

OpenCode TUI 场景使用插件，因为独立 `opencode serve` 事件流不一定对应当前 TUI 会话。

```
OpenCode TUI
    ↓
VibeCompanion plugin
    ↓
POST /api/register, POST /api/event, GET /api/replies
    ↓
event.type → 映射到安灯状态
    ↓
WebSocket → 广播到手机
```

`permission.ask` 闭环：

```text
OpenCode permission.ask hook
  → plugin POST /api/event {type:"permission", sourceId, requestId}
  → Relay Hub 保存 pending request 并广播到 PWA
  → Phone WS permission_reply {sourceId, sessionId, requestID, reply, ackId}
  → Relay Hub 校验 pending，写入 source reply queue，广播 reply_ack accepted
  → plugin GET /api/replies 轮询得到 reply
  → plugin 设置 output.status = allow/deny
```

兼容路径：`opencode.ts` SDK/SSE relay 保留为诊断路径，但不承担可靠远程确认。

**事件映射**:

| OpenCode Event | Andon Status | 说明 |
|----------------|-------------|------|
| `session.created` | IDLE | 新会话开始 |
| `session.status` | 按状态值映射 | 直接映射 |
| `message.updated` | THINKING | AI 正在生成回复 |
| `tool.execute.before` | EXECUTING | 工具即将执行 |
| `tool.execute.after` | THINKING / IDLE | 工具执行完毕 |
| `session.idle` | IDLE | 会话空闲 |
| `session.error` | ERROR | 错误 |
| `todo.updated` | — | TODO 变更（日志用） |

## 3. 数据流

### 3.1 状态更新流（PC → Phone）

```
Adapter Event → Relay Hub /api/event (注册 source/session)
    → WebSocket broadcast → ws.js (接收) → andon.js (渲染)
```

延迟预算：
- OpenCode → SDK: ~10ms (本地)
- SDK → Relay: ~5ms (进程内)
- Relay → WebSocket: ~5ms (编码+发送)
- WiFi 传输: ~5ms (局域网)
- WebSocket → DOM: ~10ms (解析+渲染)
- **总计: ~35ms** — 远低于 NF01 的 500ms 目标

### 3.2 语音输入流（Phone → PC）

```
Microphone → MediaRecorder → WebSocket binary
    → audio.ts (解码/缓冲) → PC 音频输出 or 文件
```

延迟预算：
- 麦克风 → MediaRecorder: ~20-50ms (硬件+编码)
- WebSocket 发送: ~5ms
- WiFi 传输: ~5ms
- 服务端处理: ~10ms
- **总计: ~40-70ms** — 满足 NF02 的 200ms 目标

### 3.3 连接管理流

```
Phone → ws.js → WebSocket connect
    → Relay Server → 验证 → connected 回执
    → 定期 ping/pong (30s)
    → 断线 → 指数退避重连 (1/2/4/8/16/30s)
```

### 3.4 远程确认流（Phone → Adapter）

```text
Adapter POST /api/event(permission/question)
  → Relay Hub creates pending request
  → PWA displays prompt with source/session label
  → User taps Allow/Reject
  → WS ClientMessage includes ackId/sourceId/sessionId/requestID
  → Relay Hub validates and queues adapter reply
  → Relay Hub broadcasts reply_ack
  → Adapter polls /api/replies and resolves original hook/API
```

路由规则：
- `sourceId` 缺失：拒绝并 ACK `failed`
- `requestId` 不存在：ACK `failed`
- pending 已超时：ACK `expired`
- 成功入队：ACK `accepted`
- 不再使用全局 mutable OpenCode URL 作为确认路由依据

## 4. 安灯 UI 布局设计

### 4.1 横屏布局 (主要)

```
┌──────────────────────────────────────────────────────────────┐
│ [●] VibeCoding Companion       Session: main     WiFi ▰▰ ⏱  │  Header (40px)
├──────────────────────────────────┬───────────────────────────┤
│                                  │                           │
│          STATUS AREA             │      ACTIVITY LOG         │
│                                  │                           │
│     ┌──────────────────┐        │  10:23 ▸ read             │
│     │                  │        │      src/parser.ts         │
│     │   ● THINKING ●   │        │  10:23 ▸ edit             │
│     │                  │        │      src/parser.ts:42      │
│     │  Fix parser bug  │        │  10:24 ▸ bash             │
│     │  in auth module  │        │      npm test              │
│     │                  │        │  10:25 ● session.idle      │
│     └──────────────────┘        │                           │
│                                  │                           │
│   Tools: 3  │  Errors: 0        │                           │
│   Duration: 2m 34s               │                           │
│                                  │                           │
├──────────────────────────────────┴───────────────────────────┤
│  [🎤 Voice]  [📷 Camera]  [📋 Sessions]          [⚙ Config] │  Footer (48px)
└──────────────────────────────────────────────────────────────┘

  ◄───── 65% ──────► ◄──── 35% ────►
```

### 4.2 状态区域视觉效果

- **背景色**: 整个状态区域填充状态色，带 20% 透明度
- **中央卡片**: 圆角卡片，状态色背景，脉冲动画（THINKING）
- **状态文字**: 大号 (28px+)，状态色加粗
- **任务描述**: 白色文字，2行截断
- **统计栏**: 底部小字，灰色

### 4.3 响应式断点

| 断点 | 宽度 | 布局调整 |
|------|------|----------|
| 大屏 | ≥ 900px CSS px | 双栏：状态 65% + 日志 35% |
| 中屏 | 600-899px | 双栏：状态 60% + 日志 40%，字体缩小 |
| 小屏 | < 600px | 单栏：状态为主，日志折叠为底部抽屉 |

## 5. 安全考虑

| 风险 | 缓解措施 |
|------|----------|
| 未授权连接 | Relay Server 仅监听局域网接口，可选 token 认证 |
| 音频隐私 | 仅在用户主动按下录音时采集，松开即停止 |
| XSS | 不使用 innerHTML，所有 DOM 更新通过 textContent |
| CSRF | WebSocket 不受 CSRF 影响 |
| 数据泄露 | 不持久化任何音频/状态数据到磁盘 |

## 6. 技术栈确认 (SWE.2)

| 组件 | 技术 | 版本要求 | 理由 |
|------|------|----------|------|
| Phone 前端 | 纯 HTML/CSS/JS | Chrome 53+ | 最大兼容性 |
| Phone 构建工具 | 无 | — | 零构建步骤 |
| PC Relay Server | Node.js + TypeScript | Node 18+, TS 5.0+ | SDK 兼容 + 类型安全 |
| WebSocket 库 | ws | 8.x | 最轻量，无依赖 |
| OpenCode SDK | @anthropic/opencode-sdk | latest | 官方 SDK |
| 代码质量 (Server) | ESLint + @typescript-eslint | — | 静态分析 |
| 代码质量 (App) | ESLint (browser env) | — | 静态分析 |
| 格式化 | Prettier | — | 统一风格 |

## 7. 开发工具链

```bash
# Server 开发
cd server && npm install
npm run dev          # tsx watch 模式
npm run build        # tsc 编译
npm run lint         # eslint 检查
npm run typecheck    # tsc --noEmit

# App 开发
# 无构建步骤，直接在浏览器打开或使用任意静态文件服务器
# 推荐使用 server 内置的静态文件服务

# 质量保证
npm run lint         # ESLint (server + app)
npm run typecheck    # TypeScript 类型检查
```
