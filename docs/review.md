# VibeCoding Companion — 工程评估报告

> 日期: 2026-06-01 | 评估范围: 全工程 (Phase 1 + Phase 1.5) | 评估人: AI Review

---

## 1. 项目概况

| 维度 | 说明 |
|------|------|
| 项目名称 | VibeCoding Companion |
| 版本 | v0.1.0 (Phase 1.5 完成) |
| 定位 | 将闲置安卓手机变为 AI 编码工具的安灯状态看板 + 远程确认终端 |
| 技术栈 | Server: Node.js + TypeScript + ws / PWA: 纯 HTML+CSS+JS (零构建) / Plugin: ES Module JS |
| 当前进度 | Phase 1 + Phase 1.5 已完成, Phase 2~4 待开发 |
| 代码规模 | Server ~1170 行 TS, PWA ~1550 行 JS (含 legacy), Plugin ~260 行 JS, CSS ~820 行, Docs ~1100 行 |
| 质量门禁 | `typecheck` 通过, `lint` 通过 |

---

## 2. 评分总览

| 维度 | 评分 (5 分制) | 说明 |
|------|:---:|------|
| 架构设计 | 4.5 | 三层分离清晰, 多 source Hub 设计合理, 状态收敛策略完整 |
| 代码质量 | 3.5 | TypeScript strict, 注释充分; 但存在 God File 和大量重复代码 |
| 安全性 | 3.0 | 基本 XSS 防护和路径遍历检查到位; 但缺少 CORS, auth token 暴露在 URL |
| 测试覆盖 | 1.5 | 零持久化自动化测试; 有一次性的 mock 验证脚本但未保留 |
| 文档 | 4.5 | A-SPICE 对齐, 文档体系完整, AGENTS.md 信息密度极高 |
| 可维护性 | 3.0 | 重复代码拖累; 模块拆分不足; 协议字段命名不一致 |
| **综合** | **3.3** | **可用但需改进** |

---

## 3. 优点详述

### 3.1 架构设计 (4.5/5)

**三层分离, 边界清晰**:

```
Adapter/Plugin → HTTP API → Relay Hub → WebSocket → PWA
```

- Server 不绑定任何特定 AI 工具, 通过通用 Adapter API (`/api/register`, `/api/event`, `/api/replies`) 接入
- PWA 不关心事件来源, 只按协议渲染
- Plugin 独立部署, 与 Server 进程解耦

**状态收敛策略设计出色**:

三层兜底机制 (Adapter → Relay Hub settle timer → PWA local timer) 解决了异步事件流中"永远收不到最终状态"的工程难题。这比多数同类项目的一锤子映射要成熟得多。

**多 source 隔离设计正确**:

Phase 1.5 将 Relay Hub 从单 OpenCode 转发器升级为多 source 路由器。`pending request` 按 `sourceId + requestId` 唯一索引, 回复队列按 `sourceId` 隔离。两个并发 source 不会串线——这在 mock 测试中已验证。

### 3.2 代码质量 (3.5/5)

**TypeScript 类型设计严谨**:

`types.ts` 用 discriminated union 定义了完整的消息协议:

```ts
export type ServerMessage =
  | StatusUpdate | ToolEvent | LogEntry
  | ConnectedMessage | SourceMessage
  | QuestionMessage | PermissionMessage | ReplyAckMessage
```

每个变体用 `type` 字段区分, 编译器可穷尽检查, 不可能构造出非法消息。

**防御性编程**:

- 所有 JSON 解析包裹 try/catch
- 所有回调循环包裹 try/catch 避免一个处理器异常影响其他
- WebSocket 断线时清理所有引用
- DOM 操作使用 `textContent` / `createElement`, 不使用 `innerHTML`

### 3.3 PWA 工程化 (4/5)

**零构建策略执行彻底**:

纯 HTML + CSS + JS, 无 npm/webpack/vite/browserify。对目标设备 (老旧安卓) 而言这是正确的选择——减少了构建链故障面。

**向后兼容**:

提供了 `legacy-app.js` 作为 IIFE 全量降级方案, 用原型链而非 class, 用 `var` 而非 `let/const`, 确保不支持 ES Module 的浏览器 (Chrome < 61) 也能运行。

**自动连接逻辑**:

`detectServerHost()` 根据 `window.location` 自动判断页面是否由 Relay Server 提供, 实现零配置连接。同时用 `localStorage` 持久化上次地址。

### 3.4 文档 (4.5/5)

- `AGENTS.md` 是给 AI 协作者的优秀 prompt: 架构图、数据流、约定、测试清单一目了然
- `docs/requirements.md` 有功能 ID (F01-F57) 和非功能 ID (NF01-NF43), 可追溯
- `docs/protocol.md` 定义了完整的消息格式
- `docs/acceptance-phase-1.5.md` 有具体的验证步骤和输出
- A-SPICE 过程映射 (SYS.1~SWE.6) 体现在 plan.md 中

---

## 4. 问题详述

### 4.1 [严重] `index.ts` 是 God File

**位置**: `server/src/index.ts` (594 行)

**问题**: 单一文件承担了 HTTP 路由、WebSocket 管理、Hub 状态、消息分发、静态文件服务、回复处理六项职责。

**影响**:
- 无法独立测试任何一项功能
- 修改路由逻辑可能意外破坏 WebSocket 处理
- 新增 API 端点时需在 594 行文件中找到正确位置

**建议拆分**:

```
server/src/
├── index.ts          # 入口: 组装各模块, ~30 行
├── hub.ts            # RelayHubState + registerSource + reply routing
├── routes.ts         # HTTP API 路由 (/api/register, /api/event, /api/replies, /api/test, /api/diagnostics)
├── static.ts         # 静态文件服务
├── ws-handler.ts     # WebSocket 连接管理和消息分发
├── opencode.ts       # (不变)
├── relay.ts          # (不变)
└── types.ts          # (不变)
```

### 4.2 [严重] 重复代码导致双写维护

**问题 A — PWA 双版本**:

| 文件 | 行数 | 格式 | 实际使用 |
|------|------|------|----------|
| `app.js + ws.js + andon.js + log.js + util.js` | ~610 | ES Module | **未使用** |
| `legacy-app.js` | 567 | IIFE | **实际加载** |

`index.html` 第 98 行 `<script src="js/legacy-app.js">` 只加载 legacy 版本。ES module 版本有完整实现但从未被引用。

所有 bugfix 和 feature 需在两个版本中同步修改, 或者放弃 module 版本。当前两个版本已经出现了行为差异:

- legacy 版本有 `isNoisyLog()` 过滤噪音日志, module 版本没有
- legacy 版本有 `scheduleSettle()` 本地 IDLE 兜底, module 版本没有
- legacy 版本处理 `source` 消息类型, module 版本没有

**问题 B — 事件映射双写**:

`opencode.ts:mapEvent()` (TS 版, 118-384 行) 和 `opencode-plugin/index.js:mapEvent()` (JS 版, 75-164 行) 实现了相同的 OpenCode 事件映射逻辑。两个文件必须保持同步, 否则 SDK 直连路径和 plugin 路径行为不一致。

**建议**:
- 短期: 明确只维护 `legacy-app.js`, 移除或冻结 ES module 版本
- 长期: 只保留 ES module 版本, 删除 `legacy-app.js`, 用 `<script type="module">` 加载
- 事件映射: 提取共享的映射表到 JSON 或单独文件, 两处 import

### 4.3 [中等] 零持久化自动化测试

**现状**:
- `acceptance-phase-1.5.md` 记录了一次性 mock 测试脚本 (`tmp-phase15-e2e.cjs`), 但该脚本**已删除**
- `SessionTracker` (relay.ts) 是纯状态逻辑, 极易单测但无测试
- Reply queue 并发隔离、ACK 状态机等关键路径无自动化验证
- 无 CI 配置

**风险**:
- 重构 (如拆分 index.ts) 无法验证不引入回归
- 状态机收敛逻辑复杂 (server settle + PWA settle), 极易改坏
- Phase 2 语音功能引入后, 回归风险更高

**建议**:
1. 至少补充以下测试:
   - `SessionTracker` 单元测试
   - Hub reply routing 隔离测试 (即 acceptance 中已验证但未保留的用例)
   - Status settle timer 行为测试
   - OpenCode event → ServerMessage 映射测试
2. 将 mock 闭环测试脚本持久化为 `server/__tests__/` 下的永久测试
3. 使用 `node:test` (Node 18+ 内置) 避免引入额外依赖

### 4.4 [中等] 安全缺陷

**4.4.1 无 CORS 保护**

HTTP API 端点 (`/api/test`, `/api/register`, `/api/event`, `/api/replies`) 没有设置 CORS 头。同局域网内任意网页可以向 Relay Hub 发送事件或注入假状态:

```js
// 同网络任意网页可执行
fetch('http://192.168.1.5:4097/api/test', {
  method: 'POST',
  body: JSON.stringify({ type: 'status', status: 'ERROR', task: 'fake' })
})
```

**建议**: 添加 `Access-Control-Allow-Origin` 限制, 或要求 auth token。

**4.4.2 Auth Token 在 URL 中暴露**

WebSocket 连接通过 `?token=xxx` 传递认证令牌:

```ts
const token = url.searchParams.get('token')
```

URL query 参数会出现在浏览器历史、代理日志、Referer 头中。

**建议**: 在 WebSocket 连接建立后通过首条消息发送 token, 或使用 `Sec-WebSocket-Protocol` 头传递。

**4.4.3 路径遍历防护不严谨**

```ts
if (!filePath.startsWith(config.staticDir)) {
  res.writeHead(403)
  res.end('Forbidden')
}
```

`startsWith` 在 Windows 上可能因大小写不敏感或 UNC 路径绕过。

**建议**: 使用 `path.resolve()` 后比较。

### 4.5 [中等] 协议设计问题

**4.5.1 Reply 轮询效率低**

Plugin 以 500ms 间隔轮询 `/api/replies`。在 `permission.ask` 场景下, plugin 主线程被阻塞等待回复, 期间每 500ms 发一次 HTTP 请求。

**影响**:
- 无权限请求时仍有周期性 HTTP 开销 (如果有心跳注册的话)
- 网络延迟 = 轮询间隔/2 + 真实延迟, 平均额外增加 250ms

**建议**: 使用长轮询 (HTTP 长连接, 有回复时立即返回) 或 Server-Sent Events 推送给 adapter。

**4.5.2 `sessionId` vs `sessionID` 命名不一致**

| 位置 | 字段名 |
|------|--------|
| types.ts `StatusUpdate` | `sessionId` |
| types.ts `QuestionMessage` | `sessionID` (同时有 `sessionId`) |
| types.ts `PermissionMessage` | `sessionID` (同时有 `sessionId`) |
| opencode.ts | 从 `props['sessionID']` 读取 |
| opencode-plugin/index.js | `normalizeSessionId` 同时检查两种 |
| app.js | `msg.sessionId || msg.sessionID` |

协议中同时存在两种命名, 所有消费者都要做 fallback。

**建议**: 统一为 `sessionId` (camelCase), `sessionID` 改为映射时转换。

### 4.6 [低] 死代码和未使用模块

| 项目 | 位置 | 说明 |
|------|------|------|
| `SessionTracker` 类 | `relay.ts` | 完整实现 (130 行) 但从未被 import |
| `voice.js` | `app/js/` | Phase 2 空壳, 未接入任何 UI |
| `audio.ts` | AGENTS.md 列出 | 文件不存在, 未实现 |
| `<div id="prompt-overlay">` | `index.html:96` | HTML 中声明但 JS 动态创建 overlay, 此元素未使用 |
| `debounce()` 函数 | `util.js:58` | 导出但从未调用 |
| `relay.ts` 整个文件 | `server/src/` | 只定义了 `SessionTracker`, 未被任何代码 import |

### 4.7 [低] 状态统计未跨事件累加

`status` 消息中的 `toolCount` 和 `errorCount` 总是从事件中取值:

```ts
results.push({
  type: 'status',
  status: 'EXECUTING',
  toolCount: 0,    // 永远是 0
  errorCount: 0,   // 永远是 0
})
```

`SessionTracker` 有累加逻辑但从未使用。PWA 端统计面板永远显示 0。

---

## 5. 与需求文档的对齐检查

| 需求 ID | 需求描述 | 状态 | 备注 |
|---------|---------|------|------|
| F01 | WiFi WebSocket 连接 | ✅ 完成 | |
| F02 | 自动发现 | ❌ 未实现 | 使用手动 IP 输入代替 |
| F03 | 手动连接 | ✅ 完成 | 含自动检测服务器地址 |
| F04 | 连接状态显示 | ✅ 完成 | header 状态点 + 文字 |
| F05 | 断线重连 | ✅ 完成 | 指数退避, 双端 |
| F10 | 状态着色 | ✅ 完成 | CSS 自定义属性 |
| F11 | 状态动画 | ✅ 完成 | THINKING 脉冲, ERROR 闪烁 |
| F12 | 任务描述 | ✅ 完成 | |
| F13 | 工具执行显示 | ✅ 完成 | 含 title 和参数摘要 |
| F14 | 计时器 | ⚠️ 部分 | 有 duration 字段但未跨事件累加, 显示 00:00 |
| F15 | 活动日志 | ✅ 完成 | 100 条上限, 自动滚动 |
| F16 | 会话统计 | ⚠️ 部分 | toolCount/errorCount 永远为 0 |
| F40 | 横屏优化 | ✅ 完成 | CSS Grid, 响应式断点 |
| F41 | 暗色主题 | ✅ 完成 | |
| F42 | 全屏模式 | ✅ 完成 | |
| F43 | 离线提示 | ✅ 完成 | Service Worker network-first |
| F50 | Source 注册 | ✅ 完成 | `/api/register` |
| F51 | Session 绑定 | ✅ 完成 | sourceId + sessionId |
| F52 | Pending Request | ✅ 完成 | 按 sourceId+requestId 索引 |
| F53 | 可靠权限确认 | ✅ 完成 | plugin → Hub → phone → Hub → plugin 闭环 |
| F54 | 回复 ACK | ✅ 完成 | accepted/failed/expired |
| F55 | 多 Source 隔离 | ✅ 完成 | mock 测试验证 |
| F56 | 通用 Adapter 协议 | ✅ 完成 | HTTP API, 工具无关 |
| F57 | 问题确认转发 | ⚠️ 部分 | UI 已实现; OpenCode 无同步 question hook |

**P0 需求覆盖率**: 17/18 (94%)
**全部需求覆盖率**: 22/26 (85%)

---

## 6. 改进建议优先级

| 优先级 | 建议 | 预估工作量 | 收益 |
|--------|------|-----------|------|
| **P0** | 消除 PWA 双写: 选择一个版本, 移除另一个 | 0.5 天 | 消除维护负担, 消除行为差异 |
| **P0** | 补充核心自动化测试 (SessionTracker, reply routing, settle) | 1 天 | 重构安全网, 防止回归 |
| **P1** | 拆分 `index.ts` God File | 0.5 天 | 提高可读性, 可独立测试 |
| **P1** | 添加 CORS 保护 | 0.5 天 | 防止同网络 CSRF |
| **P1** | 修复 toolCount/errorCount 统计永远为 0 | 0.5 天 | 完成需求 F14/F16 |
| **P2** | 统一 `sessionId`/`sessionID` 命名 | 0.5 天 | 消除协议歧义 |
| **P2** | 清理死代码 (SessionTracker, debounce, HTML 残留) | 0.5 天 | 减少认知负荷 |
| **P2** | 将事件映射提取为共享配置 | 1 天 | 消除 TS/JS 双写 |
| **P3** | Reply 长轮询 / SSE 推送替代 busy-polling | 1 天 | 降低延迟, 减少无效请求 |
| **P3** | WebSocket auth 改为消息内认证 | 0.5 天 | 避免 token 在 URL 中暴露 |

---

## 7. 结论

VibeCoding Companion 的核心设计——三层架构、多 source Relay Hub、状态收敛策略——是成熟的。Phase 1 + 1.5 的功能闭环基本完整, 需求覆盖率 85%, P0 需求 94%。

主要短板在于**工程维护性**: God File、PWA 双写、事件映射双写导致任何改动都需要同步多处。配合零自动化测试, 重构风险较高。

**建议在进入 Phase 2 之前**, 优先解决 P0 级改进项 (消除双写 + 补充测试), 为后续语音功能的叠加建立稳固基础。
