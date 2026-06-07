# VibeBuddy — 需求追溯矩阵

> 版本: v0.1.0 | 日期: 2026-06-06 | A-SPICE 追溯性要求

## 1. 概述

本文档建立需求 → 规格 → 实现 → 测试 的追溯关系。

**追溯符号：**
- ✅ 已实现并测试
- ⚠️ 已实现未测试
- ❌ 未实现
- 🔗 链接到代码/文档

---

## 2. 功能需求追溯

### 2.1 系统连接 (P0)

| 需求 ID | 需求描述 | 规格 ID | 实现模块 | 测试状态 |
|---------|----------|---------|----------|----------|
| F01 | WiFi 连接建立 WebSocket | SPEC-4.2 | `server/src/index.ts#L64-94` | ⚠️ E2E |
| F02 | 自动发现 (mDNS/二维码) | - | - | ❌ 未实现 |
| F03 | 手动连接输入 IP:Port | SPEC-4.1 | `app/js/legacy-app.js#L532-542` | ✅ |
| F04 | 连接状态实时显示 | SPEC-3.2 | `app/js/legacy-app.js#L558-568` | ✅ |
| F05 | 断线自动重连 | SPEC-6.2 | `app/js/legacy-app.js#L146-165` | ✅ |

### 2.2 安灯状态显示 (P0)

| 需求 ID | 需求描述 | 规格 ID | 实现模块 | 测试状态 |
|---------|----------|---------|----------|----------|
| F10 | 状态着色 | SPEC-2.1 | `app/js/legacy-app.js#L178-184` | ✅ |
| F11 | 状态动画 | SPEC-2.2 | `app/css/main.css` | ⚠️ 视觉验证 |
| F12 | 任务描述显示 | SPEC-3.2 | `app/js/legacy-app.js#L295-297` | ✅ |
| F13 | 工具执行显示 | SPEC-4.2 | `app/js/legacy-app.js#L614-634` | ✅ |
| F14 | 计时器 | SPEC-3.2 | `app/js/legacy-app.js#L270-280` | ✅ |
| F15 | 活动日志 | SPEC-4.2 | `app/js/log.js` | ✅ |
| F16 | 会话统计 | SPEC-3.2 | `app/js/legacy-app.js#L252-268` | ✅ |
| F17 | 多 Session 卡片 | SPEC-3.2 | `app/js/legacy-app.js#L189-249` | ✅ |
| F18 | 子代理显示 | SPEC-3.2 | `app/js/legacy-app.js#L311-314` | ⚠️ |

### 2.3 远程确认 (P0)

| 需求 ID | 需求描述 | 规格 ID | 实现模块 | 测试状态 |
|---------|----------|---------|----------|----------|
| F50 | Source 注册 | SPEC-4.1.1 | `server/src/index.ts#L199-220` | ✅ |
| F51 | Session 绑定 | SPEC-3.1 | `server/src/index.ts` | ⚠️ |
| F52 | Pending Request 注册 | SPEC-3.1 | `server/src/index.ts#L226-236` | ✅ |
| F53 | 可靠权限确认 | SPEC-4.2.2 | `server/src/index.ts#L340-390` | ✅ E2E |
| F54 | 回复 ACK | SPEC-4.2.1 | `server/src/index.ts#L392-405` | ✅ |
| F55 | 多 Source 隔离 | SPEC-3.1 | `server/src/index.ts#L340-390` | ✅ E2E |
| F56 | 通用 Adapter 协议 | SPEC-5 | `server/src/index.ts` | ⚠️ |
| F57 | 问题确认转发 | SPEC-4.2.2 | `server/src/index.ts#L340-390` | ⚠️ |
| F58 | 卡片内联权限 | SPEC-3.2 | `app/js/legacy-app.js#L356-380` | ✅ |

### 2.4 语音输入 (P1)

| 需求 ID | 需求描述 | 规格 ID | 实现模块 | 测试状态 |
|---------|----------|---------|----------|----------|
| F20 | 麦克风采集 | - | `app/js/voice.js` | ❌ 占位 |
| F21 | 按键说话 | - | - | ❌ |
| F22 | 音频流传输 | - | `server/src/audio.ts` | ❌ 占位 |
| F23 | VAD 静音检测 | - | - | ❌ |
| F24 | 音频可视化 | - | - | ❌ |

---

## 3. 非功能需求追溯

### 3.1 性能

| 需求 ID | 需求描述 | 规格 ID | 验证方法 | 验证结果 |
|---------|----------|---------|----------|----------|
| NF01 | 状态更新延迟 < 500ms | SPEC-6.1 | E2E 测试 | ✅ ~35ms |
| NF02 | 音频延迟 < 200ms | SPEC-6.1 | - | ⏳ Phase 2 |
| NF03 | 前端内存 < 30MB | SPEC-6.1 | DevTools | ✅ |
| NF04 | CPU 待机 < 2% | SPEC-6.1 | 进程监控 | ✅ |
| NF05 | 电池续航 > 4h | SPEC-6.1 | 真机测试 | ✅ |

### 3.2 可靠性

| 需求 ID | 需求描述 | 规格 ID | 实现模块 | 测试状态 |
|---------|----------|---------|----------|----------|
| NF20 | 自动重连 | SPEC-6.2 | `app/js/legacy-app.js#L146-165` | ✅ |
| NF21 | 页面加载成功率 > 99% | SPEC-6.2 | - | ⚠️ 无监控 |
| NF22 | 后台释放麦克风 | SPEC-6.3 | - | ⏳ Phase 2 |
| NF23 | 错误不崩溃 | SPEC-6.3 | `app/js/legacy-app.js#L58-60` | ⚠️ |

### 3.3 远程确认可靠性

| 需求 ID | 需求描述 | 规格 ID | 实现模块 | 测试状态 |
|---------|----------|---------|----------|----------|
| NF40 | 回复路由正确性 | SPEC-3.1 | `server/src/index.ts#L340-390` | ✅ E2E |
| NF41 | 权限闭环时延 < 1000ms | SPEC-6.1 | E2E 测试 | ✅ |
| NF42 | 过期处理 | SPEC-3.1 | `server/src/index.ts#L366-371` | ✅ |
| NF43 | 安全默认值 | SPEC-6.3 | `opencode-plugin/index.js#L220-223` | ✅ |

---

## 4. 接口需求追溯

| 接口 ID | 接口描述 | 规格 ID | 实现模块 | 测试状态 |
|---------|----------|---------|----------|----------|
| IF01 | HTTP Server | SPEC-4.1 | `server/src/index.ts#L86-91` | ✅ |
| IF02 | WebSocket Server | SPEC-4.2 | `server/src/index.ts#L64-94` | ✅ |
| IF03 | Adapter 注册 | SPEC-4.1.1 | `server/src/index.ts#L199-220` | ✅ |
| IF04 | Adapter 事件 | SPEC-4.1.2 | `server/src/index.ts#L223-255` | ✅ |
| IF05 | Adapter 回复轮询 | SPEC-4.1.3 | `server/src/index.ts#L258-271` | ✅ |
| IF06 | Phone 回复 | SPEC-4.2.2 | `server/src/index.ts#L340-390` | ✅ |
| IF07 | Reply ACK | SPEC-4.2.1 | `server/src/index.ts#L392-405` | ✅ |
| IF08 | 状态快照 | SPEC-4.2.1 | `server/src/index.ts#L133-149` | ✅ |
| IF09 | 诊断接口 | SPEC-4.1.4 | `server/src/index.ts#L181-196` | ⚠️ |
| IF10 | 测试接口 | - | `server/src/index.ts#L131-164` | ✅ |
| IF11 | 音频输出 | - | `server/src/audio.ts` | ❌ Phase 2 |

---

## 5. 文档追溯

| 文档类型 | 文档名称 | A-SPICE 过程 | 状态 |
|----------|----------|--------------|------|
| 需求文档 | `docs/requirements.md` | SYS.1 + SYS.2 | ✅ 已更新 |
| 架构文档 | `docs/architecture.md` | SYS.3 + SWE.2 | ⚠️ 需更新 |
| 技术规格 | `docs/specification.md` | SWE.1 | ✅ 新建 |
| 工程审查 | `docs/ENGINEERING_REVIEW.md` | SWE.3 | ✅ 新建 |
| 追溯矩阵 | `docs/trace-matrix.md` | A-SPICE | ✅ 本文档 |
| 运维手册 | `docs/operations.md` | SYS.4 | ✅ 存在 |
| 协议规格 | `docs/protocol.md` | SWE.2 | ✅ 存在 |
| 测试策略 | `docs/test-strategy.md` | SWE.4 + SWE.5 | ❌ 待创建 |

---

## 6. 代码模块追溯

### 6.1 Server 端

| 源文件 | 职责 | 关联需求 | 测试文件 |
|--------|------|----------|----------|
| `src/index.ts` | HTTP + WS + Hub | F01, F50-58, IF01-10 | ❌ 无 |
| `src/types.ts` | 类型定义 | SPEC-3 | ❌ 无 |
| `src/opencode.ts` | OpenCode SDK 集成 | F01 | ❌ 无 |
| `src/relay.ts` | 事件中继（占位） | - | - |
| `src/audio.ts` | 音频处理（占位） | F20-24 | - |

### 6.2 App 端

| 源文件 | 职责 | 关联需求 | 测试文件 |
|--------|------|----------|----------|
| `legacy-app.js` | 主应用逻辑 | F03-18, F50-58 | ❌ 无 |
| `ws.js` | WebSocket 客户端 | F01, F05 | ❌ 无 |
| `andon.js` | 安灯渲染（未使用） | F10-11 | - |
| `log.js` | 日志渲染 | F15 | ❌ 无 |
| `voice.js` | 语音（占位） | F20-24 | - |

### 6.3 Plugin 端

| 源文件 | 职责 | 关联需求 | 测试文件 |
|--------|------|----------|----------|
| `opencode-plugin/index.js` | OpenCode 集成 | F50, F53 | ❌ 无 |
| `zcode-adapter/index.js` | ZCode 集成 | F56 | ❌ 无 |

---

## 7. 测试追溯

### 7.1 现有测试

| 测试脚本 | 测试范围 | 关联需求 | 状态 |
|----------|----------|----------|------|
| `verify-stats-events.mjs` | 事件统计 | NF01, F16 | ✅ |
| `verify-firefox-stats.mjs` | Firefox DOM | F10-16 | ✅ |
| `e2e-firefox-opencode-run.mjs` | OpenCode 集成 | F01, F50-58 | ✅ |
| `e2e-firefox-opencode-tool-approval.mjs` | 工具审批 | F53, NF43 | ✅ |
| `e2e-firefox-relay-prompt.mjs` | 权限流程 | F53-55 | ✅ |

### 7.2 缺失测试

| 测试类型 | 关联需求 | 优先级 |
|----------|----------|--------|
| 单元测试 - 状态机 | F10, SPEC-2 | P0 |
| 单元测试 - 数据结构 | SPEC-3 | P0 |
| 单元测试 - 回复路由 | F55, NF40 | P0 |
| 集成测试 - 多 Source | F55 | P1 |
| 性能测试 - 压力 | NF01 | P2 |

---

## 8. 差距分析

### 8.1 已完成

- ✅ 核心功能实现
- ✅ E2E 测试覆盖
- ✅ 文档框架

### 8.2 待改进

| 差距 | 影响 | 建议 |
|------|------|------|
| 无单元测试 | 质量风险 | 引入 Vitest |
| 文档不同步 | 维护困难 | 定期审查 |
| 代码未模块化 | 可维护性差 | 重构 |
| 无 CI/CD | 质量门禁缺失 | 引入 GitHub Actions |

### 8.3 待实现

| 功能 | 需求 ID | 优先级 |
|------|---------|--------|
| 自动发现 | F02 | P1 |
| 语音输入 | F20-24 | P1 |
| 摄像头拍照 | F30 | P2 |
| OCR 识别 | F31 | P3 |
