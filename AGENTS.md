# AGENTS.md

## 项目概述

VibeCoding Companion — 老旧安卓手机上的 AI 编码辅助指示器 + 语音终端。

将闲置安卓手机变为 PC 端 AI 编码工具（OpenCode）的安灯状态看板和语音输入中继。

- Phone: PWA (纯 HTML/CSS/JS, 零构建步骤)
- Server: Node.js + TypeScript + ws
- 协议: WebSocket (JSON 文本帧 + 二进制音频帧)
- 设备测试: Redmi Note 12T Pro (Android 13)
- 默认端口: 4097 (避免与其他服务冲突)

## 构建与开发命令

```bash
# === Server (PC 端 Relay Server) ===

cd server

# 首次安装
npm install

# 开发模式 (tsx watch, 自动重启)
npm run dev

# TypeScript 编译
npm run build

# 类型检查 (无输出)
npm run typecheck

# ESLint 检查
npm run lint

# ESLint 自动修复
npm run lint:fix

# === App (手机端 PWA) ===

# 无构建步骤!
# 开发: 用任意方式 serve app/ 目录
#   方式1: server 内置静态服务 (npm run dev 时自动启用)
#   方式2: npx serve app -p 3000
#   方式3: VS Code Live Server

# ESLint 检查 (app/js/)
npx eslint ../app/js/

# === 质量全检 ===
npm run typecheck && npm run lint

# === 真机测试 ===
# 1. PC 端启动: cd server && npm run dev
# 2. 手机浏览器打开: http://<PC-IP>:4096
# 3. 点击连接 (自动检测或手动输入)
```

## 架构概览

```
vibe-companion/
├── docs/                    # A-SPICE 文档
│   ├── requirements.md      # SYS.1 + SYS.2 需求
│   ├── architecture.md      # SYS.3 + SWE.2 架构
│   └── plan.md              # 开发计划
├── server/                  # PC 端 Relay Server
│   ├── src/
│   │   ├── index.ts         # 入口: HTTP + WebSocket 启动
│   │   ├── opencode.ts      # OpenCode SDK 客户端封装
│   │   ├── relay.ts         # 事件中继逻辑
│   │   ├── audio.ts         # 音频接收处理
│   │   └── types.ts         # 共享类型
│   ├── package.json
│   ├── tsconfig.json
│   └── .eslintrc.cjs
├── app/                     # 手机端 PWA (零构建)
│   ├── index.html           # 单页应用
│   ├── manifest.json        # PWA 清单
│   ├── sw.js                # Service Worker
│   ├── css/
│   │   └── main.css         # 全局样式 + 安灯主题
│   └── js/
│       ├── app.js           # 应用状态 & 初始化
│       ├── ws.js            # WebSocket 连接管理
│       ├── andon.js         # 安灯状态渲染
│       ├── log.js           # 活动日志面板
│       ├── voice.js         # 麦克风录音 (Phase 2)
│       └── util.js          # 工具函数
├── AGENTS.md                # 本文件
└── .gitignore
```

## 数据流

```
OpenCode (serve, :11434)
  ↓ SDK event.subscribe()
opencode.ts → 解析事件 → relay.ts → 格式化为协议消息
  ↓ WebSocket broadcast
ws.js → 接收消息 → andon.js → DOM 更新
                       ↘ log.js → 日志追加

# 语音 (Phase 2)
voice.js → MediaRecorder → WebSocket binary frame
  ↓
audio.ts → 解码 → PC 音频输出
```

## 开发约定

### UI 规则
- **纯 CSS + DOM API**，不引入任何 CSS/JS 框架
- 使用 CSS 自定义属性切换安灯状态色: `document.documentElement.style.setProperty('--status-color', color)`
- 布局使用 CSS Grid (主) + Flexbox (辅)
- 横屏优先，使用 `orientation: landscape` 媒体查询
- 尺寸单位: `rem` (基准 16px) 和 `vw/vh`
- 不使用 `innerHTML`，所有内容通过 `textContent` / `createElement` 设置

### 安全规则
- **所有 WebSocket 消息必须校验 JSON 格式** (try/catch JSON.parse)
- **所有 getUserMedia 调用必须 try/catch** (权限拒绝/设备不存在)
- **用户主动操作才能启用麦克风/摄像头** (自动启用违反浏览器策略)
- WebSocket URL 必须由用户确认或 mDNS 发现，不自动连接未知地址

### 代码风格
- 2 空格缩进
- 单引号
- 无分号
- ES6+ 语法 (async/await, 解构, 模板字符串)
- JSDoc 注释所有公开函数
- Server 端: TypeScript strict mode, 显式类型标注

### 版本管理
- commit 格式: `vX.Y.Z: 简要描述`
- 每个 Phase 完成一个 minor 版本
- bugfix 单独 commit

## 测试与验证

### 提交前必须
1. `npm run typecheck` 通过 (server)
2. `npm run lint` 无 error (server + app)
3. PC 端 `npm run dev` 启动不报错
4. 手机浏览器打开页面不白屏

### 真机测试清单 (Phase 1)
- [ ] PC 启动 server，手机浏览器打开 PWA
- [ ] 输入 IP:Port 连接成功，状态栏显示"已连接"
- [ ] 启动 `opencode serve`，server 自动发现并订阅事件
- [ ] OpenCode 执行任务时，安灯状态实时切换
- [ ] THINKING → EXECUTING → IDLE 状态流转正确
- [ ] 活动日志正确显示工具调用
- [ ] 断开 WiFi 后自动重连
- [ ] 横屏/竖屏切换布局正确

### 已知兼容性问题
- **Chrome < 61**: 不支持 ES Modules, 需要备用加载方案 (Phase 4)
- **Samsung Internet**: getUserMedia 行为可能不同
- **iOS Safari**: 不在支持范围内，但布局不应崩溃

## 提交与发布

- 不提交 `node_modules/`、`dist/`、`build/` (已在 .gitignore)
- 不提交 `.env` 或任何密钥
- server 编译输出 `dist/` 目录
- app/ 目录即为发布物，直接部署到静态服务器
