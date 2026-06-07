# VibeBuddy — 需求文档

> 版本: v0.1.5 | 日期: 2026-06-06 | A-SPICE: SYS.1 + SYS.2

## 1. 产品定位

**VibeBuddy** — 将闲置设备变为 AI 编码辅助指示器 + 远程确认终端。

将手机或其他终端变为 PC 端 AI 编码工具（OpenCode、ZCode、Kiro 等）的**可视化状态看板**（安灯系统）和**远程确认终端**。

### 1.1 核心价值

| 角色 | 类比 | 说明 |
|------|------|------|
| 安灯看板 | 工业 Andon Board | 实时显示 AI 任务状态：思考中/执行中/等待输入/错误/完成 |
| 远程确认终端 | 远程控制面板 | 手机端确认权限请求、回答问题 |
| 语音终端 | 无线麦克风 | 手机麦克风 → WiFi → PC，为台式机提供语音输入（Phase 2） |
| 传感器终端 | IoT 边缘设备 | 摄像头拍照、环境传感器等（远期） |

### 1.2 目标用户

- 使用 AI 编码工具（OpenCode、ZCode、Kiro 等）的开发者
- 拥有闲置安卓手机或其他浏览器设备
- 需要远程监控 AI 编码进度和确认权限

### 1.3 目标设备

| 设备层级 | 规格 | 说明 |
|----------|------|------|
| 优先适配 | Redmi Note 12T Pro | 6.6" LCD 1080×2400, Android 13 |
| 最低兼容 | Android 6.0+ / Chrome 53+ | 5" 屏幕, 720p |
| 期望兼容 | Android 5.0+ / Chrome 40+ | Service Worker 支持 |
| 桌面支持 | 任意现代浏览器 | Chrome 80+, Firefox 75+, Edge 80+ |

## 2. 功能需求

### 2.1 系统连接 (P0)

| ID | 功能 | 描述 | 优先级 | 状态 |
|----|------|------|--------|------|
| F01 | WiFi 连接 | 手机通过 WiFi 与 PC 端 Relay Server 建立 WebSocket 连接 | P0 | ✅ 已完成 |
| F02 | 自动发现 | 通过 mDNS/Bonjour 或二维码扫描自动发现 PC 端服务 | P0 | ⏳ 待开发 |
| F03 | 手动连接 | 手动输入 IP:Port 连接 | P0 | ✅ 已完成 |
| F04 | 连接状态 | 实时显示连接状态（已连接/断开/重连中） | P0 | ✅ 已完成 |
| F05 | 断线重连 | 自动重连机制，指数退避（1s/2s/4s/8s/16s，上限 30s） | P0 | ✅ 已完成 |

### 2.2 安灯状态显示 (P0)

| ID | 功能 | 描述 | 优先级 | 状态 |
|----|------|------|--------|------|
| F10 | 状态着色 | 大面积背景色指示当前状态（见 2.2.1 状态定义） | P0 | ✅ 已完成 |
| F11 | 状态动画 | THINKING 脉冲、ERROR 闪烁、EXECUTING 进度 | P0 | ✅ 已完成 |
| F12 | 任务描述 | 显示当前 AI 任务名称/描述 | P0 | ✅ 已完成 |
| F13 | 工具执行 | 显示正在执行的工具名称和参数摘要 | P0 | ✅ 已完成 |
| F14 | 计时器 | 当前状态持续时间（mm:ss 格式） | P1 | ✅ 已完成 |
| F15 | 活动日志 | 滚动显示近期事件（工具调用、状态变更） | P1 | ✅ 已完成 |
| F16 | 会话统计 | 工具调用次数、错误次数、总运行时间 | P2 | ✅ 已完成 |
| F17 | 多 Session 卡片 | 支持同时显示多个 AI 会话状态 | P0 | ✅ 已完成 |
| F18 | 子代理显示 | 在父会话卡片中显示子代理状态 | P1 | ✅ 已完成 |

#### 2.2.1 状态定义

| 状态 | 颜色 | 含义 | 触发条件 |
|------|------|------|----------|
| DISCONNECTED | 深灰 #475569 | 未连接 | WebSocket 断开 |
| IDLE | 靛蓝 #3B82F6 | 空闲等待 | session.idle / 无活动超时 |
| THINKING | 琥珀 #F59E0B | AI 思考中 | message.updated (assistant) / model.network.completed |
| EXECUTING | 翠绿 #10B981 | 执行工具 | tool.call.started / tool.execute.before |
| ERROR | 赤红 #EF4444 | 错误 | session.error / tool 失败 |
| COMPLETE | 亮绿 #34D399 | 任务完成 | session 完成且无后续 |

### 2.3 远程确认与多工具接入 (P0)

| ID | 功能 | 描述 | 优先级 | 状态 |
|----|------|------|--------|------|
| F50 | Source 注册 | 每个 AI 客户端/插件以 `sourceId` 注册到 Relay Hub，包含工具类型、显示名、工作目录、能力列表 | P0 | ✅ 已完成 |
| F51 | Session 绑定 | 所有状态、日志、问题、权限事件必须携带 `sourceId` 和可选 `sessionId`，避免多会话串线 | P0 | ✅ 已完成 |
| F52 | Pending Request 注册 | Relay Hub 保存等待手机回复的 `question` / `permission` 请求，按 `sourceId + requestId` 唯一路由 | P0 | ✅ 已完成 |
| F53 | 可靠权限确认 | 手机确认 OpenCode `permission.ask` 后，插件必须拿到回复并同步设置原始 hook 输出 | P0 | ✅ 已完成 |
| F54 | 回复 ACK | 手机点击确认/拒绝后必须收到 `accepted` / `failed` / `expired` 等 ACK，并在 UI 中可见 | P0 | ✅ 已完成 |
| F55 | 多 Source 隔离 | 两个工具或两个实例同时请求时，回复不得被投递到错误 source/session | P0 | ✅ 已完成 |
| F56 | 通用 Adapter 协议 | Relay Hub 暴露工具无关 HTTP API，后续 ZCode、Kiro 等可按同一协议接入 | P1 | ✅ 已完成 |
| F57 | 问题确认转发 | 对支持 HTTP 回复 API 的工具，`question` 回复必须绑定原始 `sourceId/sessionId/requestId` | P1 | ✅ 已完成 |
| F58 | 卡片内联权限 | 权限请求在 Session 卡片内显示确认按钮，而非仅弹窗 | P1 | ✅ 已完成 |

### 2.4 语音输入 (P1)

| ID | 功能 | 描述 | 优先级 | 状态 |
|----|------|------|--------|------|
| F20 | 麦克风采集 | Web Audio API + MediaRecorder，16kHz 单声道 | P1 | ⏳ 待开发 |
| F21 | 按键说话 | 长按麦克风按钮录音，松开发送 | P1 | ⏳ 待开发 |
| F22 | 音频流传输 | WebSocket 二进制帧传输 Opus/WebM 音频 | P1 | ⏳ 待开发 |
| F23 | VAD 静音检测 | 自动检测说话结束，可选自动停止 | P2 | ⏳ 待开发 |
| F24 | 音频可视化 | 录音时显示音量波形 | P2 | ⏳ 待开发 |

### 2.5 传感器扩展 (P2/P3)

| ID | 功能 | 描述 | 优先级 | 状态 |
|----|------|------|--------|------|
| F30 | 摄像头拍照 | getUserMedia + Canvas 截图，发送到 PC | P2 | ⏳ 待开发 |
| F31 | OCR 文字识别 | 拍照后 OCR，结果发送到 PC 剪贴板 | P3 | ⏳ 待开发 |

### 2.6 通用功能 (P1/P2)

| ID | 功能 | 描述 | 优先级 | 状态 |
|----|------|------|--------|------|
| F40 | 横屏优化 | 强制横屏布局，最大化利用屏幕宽度 | P0 | ✅ 已完成 |
| F41 | 暗色主题 | 默认暗色主题，适合编码环境 | P1 | ✅ 已完成 |
| F42 | 全屏模式 | 隐藏浏览器地址栏，沉浸式显示 | P1 | ✅ 已完成 |
| F43 | 离线提示 | Service Worker 缓存界面，断网时显示提示 | P2 | ⏳ 待开发 |
| F44 | 国际化 | 中文/英文 | P2 | ⏳ 待开发 |

## 3. 非功能需求

### 3.1 性能

| ID | 需求 | 指标 | 验证状态 |
|----|------|------|----------|
| NF01 | 状态更新延迟 | < 500ms（从事件到屏幕更新） | ✅ 实测 ~35ms |
| NF02 | 音频延迟 | < 200ms（端到端，从说话到 PC 接收） | ⏳ Phase 2 |
| NF03 | 内存占用 | < 30MB（前端） | ✅ 已验证 |
| NF04 | CPU 待机占用 | < 2%（IDLE 状态） | ✅ 已验证 |
| NF05 | 电池续航 | 持续使用 > 4 小时（主要为屏幕 + WebSocket） | ✅ 已验证 |

### 3.2 兼容性

| ID | 需求 | 指标 |
|----|------|------|
| NF10 | Android 版本 | minSdk Android 6.0 (Chrome 53+) |
| NF11 | 屏幕尺寸 | 5" 720p ~ 6.7" 1440p，横屏 |
| NF12 | 浏览器 | Chrome 53+, Samsung Internet 6+, Firefox 75+ |
| NF13 | 网络 | WiFi 802.11n+，同一局域网 |

### 3.3 可靠性

| ID | 需求 | 指标 |
|----|------|------|
| NF20 | 连接稳定性 | 自动重连，断线 < 30s 恢复 |
| NF21 | 启动可靠性 | 页面加载成功率 > 99% |
| NF22 | 资源释放 | 切换到后台时释放麦克风/摄像头 |
| NF23 | 错误恢复 | 单次错误不导致页面崩溃 |

### 3.4 可用性

| ID | 需求 | 指标 |
|----|------|------|
| NF30 | 操作步骤 | 首次使用 < 3 步完成连接 |
| NF31 | 触摸目标 | 最小 44×44 px |
| NF32 | 文字可读 | 最小 12px，状态文字 24px+ |

### 3.5 远程确认可靠性

| ID | 需求 | 指标 | 验证状态 |
|----|------|------|----------|
| NF40 | 回复路由正确性 | 自动化测试中两个 mock source 并发时 0 串线 | ✅ 已验证 |
| NF41 | 权限闭环时延 | 手机点击到 adapter 轮询拿到回复 < 1000ms（局域网） | ✅ 已验证 |
| NF42 | 过期处理 | Pending request 超时后不再接受回复，并向手机返回 `expired` ACK | ✅ 已验证 |
| NF43 | 安全默认值 | 权限请求超时或 relay 不可达时不得静默放行 | ✅ 已验证 |

## 4. 接口需求

### 4.1 PC 端 Relay Server

| ID | 接口 | 说明 | 状态 |
|----|------|------|------|
| IF01 | HTTP Server | 端口 4097（可配置），静态文件服务 + API | ✅ 已完成 |
| IF02 | WebSocket Server | 路径 `/ws`，供手机连接 | ✅ 已完成 |
| IF03 | Adapter 注册 | `POST /api/register`，工具 adapter 注册/心跳 source 信息 | ✅ 已完成 |
| IF04 | Adapter 事件 | `POST /api/event`，工具 adapter 上报状态、日志、问题、权限请求 | ✅ 已完成 |
| IF05 | Adapter 回复轮询 | `GET /api/replies?sourceId=...`，adapter 获取手机回复 | ✅ 已完成 |
| IF06 | Phone 回复 | WebSocket `question_reply` / `permission_reply` | ✅ 已完成 |
| IF07 | Reply ACK | WebSocket `reply_ack`，Relay Hub 告知手机回复是否被接受或失败 | ✅ 已完成 |
| IF08 | 状态快照 | WebSocket `snapshot`，终端连接时回放当前状态 | ✅ 已完成 |
| IF09 | 诊断接口 | `GET /api/diagnostics`，查看当前 hub 状态 | ✅ 已完成 |
| IF10 | 测试接口 | `POST /api/test`，广播测试事件 | ✅ 已完成 |
| IF11 | 音频输出 | 将手机音频流转发到 PC 音频设备或文件 | ⏳ Phase 2 |

### 4.2 通信协议

#### 4.2.1 Server → Phone 消息

```jsonc
// 状态更新
{"type": "status", "status": "THINKING", "task": "Fix parser bug", "duration": 154000, "toolCount": 3, "errorCount": 0, "sourceId": "opencode:1234:abc", "sessionId": "ses_1"}

// 工具事件
{"type": "tool", "name": "read", "status": "started", "args": {"path": "src/parser.ts"}, "ts": 1716633600000, "sourceId": "opencode:1234:abc", "sessionId": "ses_1"}

// 日志
{"type": "log", "level": "info", "message": "Reading src/parser.ts", "ts": 1716633600000, "sourceId": "opencode:1234:abc", "sessionId": "ses_1"}

// 连接确认
{"type": "connected", "serverVersion": "0.1.5", "sessionId": null, "terminalId": "uuid"}

// 状态快照
{"type": "snapshot", "sources": [{"sourceId": "opencode:1234:abc", "tool": "opencode", "name": "OpenCode 1234", "status": {...}}]}

// Source 注册
{"type": "source", "sourceId": "opencode:1234:abc", "tool": "opencode", "name": "OpenCode 1234", "status": "registered", "ts": 1716633600000}

// 权限请求
{"type":"permission","sourceId":"opencode:abc","sessionId":"ses_1","id":"req_1","tool":"bash","message":"Allow command?"}

// 回复 ACK
{"type":"reply_ack","ackId":"ack_1","requestId":"req_1","sourceId":"opencode:abc","status":"accepted"}
```

#### 4.2.2 Phone → Server 消息

```jsonc
// 终端标识
{"type": "identify", "terminalType": "phone", "terminalName": "Redmi Note 12T Pro"}

// 远程确认
{"type":"permission_reply","ackId":"ack_1","sourceId":"opencode:abc","sessionId":"ses_1","requestID":"req_1","reply":"once"}
{"type":"question_reply","ackId":"ack_2","sourceId":"opencode:abc","sessionId":"ses_1","requestID":"req_2","answers":[["Yes"]]}

// 语音数据 (binary frame, Phase 2)
// 格式: 1字节类型(0x01=audio) + 4字节序列号 + PCM/WebM payload
```

## 5. 约束与假设

### 5.1 约束

- 手机与 PC 必须在同一 WiFi 局域网
- PC 端需运行 Relay Server
- 防火墙需放行 Relay Server 端口（默认 4097）

### 5.2 假设

- 手机浏览器支持 WebSocket + getUserMedia
- WiFi 网络延迟 < 10ms

## 6. 支持的 AI 编码工具

| 工具 | 集成方式 | 权限确认 | 状态 |
|------|----------|----------|------|
| OpenCode | Plugin + SDK event hook | ✅ permission.ask hook | ✅ 已完成 |
| ZCode | JSONL log tailing adapter | ⚠️ 仅日志记录，无交互 | ✅ 已完成 |
| Kiro | 待分析 | 待分析 | ⏳ 待开发 |

## 7. 开放问题

| ID | 问题 | 状态 |
|----|------|------|
| Q01 | OpenCode SDK event.subscribe() 是否在 serve 模式下可用？ | ✅ 已验证：使用 plugin 方式更可靠 |
| Q02 | 音频格式：浏览器端 Opus 编码兼容性？ | ⏳ 待验证，fallback PCM |
| Q03 | ZCode 权限确认如何实现？ | 🔍 调研中：log 仅有 resolved 事件 |
| Q04 | Kiro 接入方式？ | 🔍 调研中 |
