# VibeBuddy — Adapter 架构分析与统一设计

> 版本: v0.1 | 日期: 2026-06-07 | 关联: F56 通用 Adapter 协议, Phase 5

本文档回答三个问题：
1. 当前 OpenCode / ZCode 两个 adapter 各自处于什么状态、用了什么机制？
2. 它们之间有没有"通用方法"可以提取？为什么现在每接一个工具都很费劲？
3. Kiro 能不能接入？怎么接？

---

## 1. 现状盘点（实测）

| 项目 | OpenCode | ZCode |
|------|----------|-------|
| 集成机制 | **进程内插件** (`opencode.json` → plugin) | **进程外日志轮询** (tail JSONL) |
| 代码位置 | `opencode-plugin/index.js` | `zcode-adapter/index.js` |
| 安装状态 | ✅ 已安装，配置已引用，源码与安装副本 **IN SYNC** | ✅ 日志目录存在且持续写入 |
| 事件来源 | OpenCode plugin hooks (`event`) | `~/.zcode/cli/log/*.jsonl` |
| 状态上报 | ✅ 实时 | ✅ 实时（500ms 轮询） |
| 权限确认 | ✅ **同步闭环** (`permission.ask` 设置 `output.status`) | ❌ 只能读到 `tool.permission.resolved`（已被 ZCode 自己决定） |
| 问题回答 | ⚠️ 转发事件，无同步 hook | ❌ 无 |
| Session 模型 | 进程 PID + cwd hash 作为 sourceId | 每个 sessionId 一个 source，subagent 作为父会话属性 |

**结论**：两个 adapter 处于**完全不同的能力层级**。OpenCode 能双向闭环，ZCode 只能单向观察。这不是实现偷懒，而是**两个工具暴露的扩展面本质不同**。

---

## 2. 集成层级模型（关键洞察）

把"AI 工具如何被 VibeBuddy 接入"抽象成三个层级。每个工具落在哪一层，由它**自身暴露的扩展能力**决定，而不是由我们的努力程度决定：

| 层级 | 机制 | 代表工具 | 能力 | 权限闭环 |
|------|------|----------|------|----------|
| **Tier A — 原生插件 + 同步 hook** | 进程内 API，可阻塞返回决策 | OpenCode | events + permission + question | ✅ 真闭环 |
| **Tier B — 事件 hook / 脚本** | 事件触发外部命令 | **Kiro** (Agent Hooks) | events + 尽力而为的 permission | ⚠️ 取决于 hook 是否可阻塞 |
| **Tier C — 日志/文件观察** | 进程外 tail | ZCode | 只读 events | ❌ 无 |

这个模型是整篇文档的核心。它解释了：
- 为什么 ZCode 没有"Allow/Reject"按钮——不是没做，是 ZCode 不给我们插手决策的接口。
- 为什么接入新工具"费劲"——见第 3 节。
- Kiro 应该落在哪一层——见第 5 节。

PWA 应当根据 source 的 `capabilities` 显式展示能力差异（例如 Tier C 的卡片不显示确认按钮，只显示状态）。

---

## 3. 为什么每接一个工具都很费劲（反思）

问题不在"工具各不相同"——那是客观现实。问题在于**我们没有把"相同的部分"抽出来**。当前三处代码（`server/src/opencode.ts`、`opencode-plugin/index.js`、`zcode-adapter/index.js`）各自重复实现了下面这些**本应共享**的东西：

### 3.1 重复实现清单

| 重复的关注点 | opencode.ts | opencode-plugin | zcode-adapter |
|--------------|-------------|-----------------|---------------|
| sourceId 生成 | — | ✅ 自己写 | ✅ 自己写（规则不同）|
| HTTP register + 心跳 | — | ✅ 自己写 | ✅ 自己写 |
| sendEvent (POST /api/event) | (内部 emit) | ✅ 自己写 | ✅ 自己写 |
| 回复轮询 (/api/replies) | — | ✅ 自己写 | — |
| **事件 → AndonStatus 映射** | ✅ 一套 | ✅ **另一套** | ✅ **第三套** |
| 工具 started/completed 去重 | ✅ | ✅ | ✅ |
| 无活动收敛兜底 | (Hub 做) | — | ✅ 自己写 60s |

### 3.2 最危险的重复：状态映射逻辑有三份

`isCompleteInfo`、`toolPartStatus`、busy/retry 判定……这套"工具事件 → THINKING/EXECUTING/IDLE"的逻辑在 `opencode.ts` 和 `opencode-plugin/index.js` 里**各写了一遍且不完全一致**，ZCode 又是第三套。任何一次状态语义调整都要改三个地方，极易漂移。这正是"文档与代码脱钩""每个 adapter 都费劲"的根因。

### 3.3 还缺的东西

- adapter 侧**没有共享类型**：server 有 `types.ts`，但 JS adapter 全靠手写 JSON，字段拼错（`sessionID` vs `sessionId`）无人拦截。
- 没有 adapter **能力声明的标准**：`capabilities: ["events","permission.ask"]` 是约定俗成，Hub 并未据此约束行为。

---

## 4. 统一方案：`@vibebuddy/adapter-core`

把 Tier 之间**相同的 60%** 抽成一个零依赖的小库，让每个 adapter 只写**工具特有的 40%**（即"如何拿到该工具的原生事件"）。

### 4.1 分层

```
┌─────────────────────────────────────────────┐
│  工具特有映射层 (每个工具一个, 薄)            │
│  - OpenCode: plugin hooks → canonical events │
│  - ZCode:    JSONL 行    → canonical events  │
│  - Kiro:     Agent Hook  → canonical events  │
└───────────────────┬─────────────────────────┘
                    │ canonical events
                    ▼
┌─────────────────────────────────────────────┐
│  @vibebuddy/adapter-core (共享, 零依赖)       │
│  - identity:  makeSourceId(tool, pid, cwd)   │
│  - transport: register / heartbeat /         │
│               sendEvents / pollReplies /     │
│               waitForReply                   │
│  - mapping:   canonicalEvent → AndonStatus   │
│               (唯一一份状态映射真相)          │
│  - helpers:   thinking()/executing()/idle()/ │
│               toolStarted()/toolDone()/...   │
│  - capability: 声明并校验 Tier               │
└───────────────────┬─────────────────────────┘
                    │ HTTP
                    ▼
              Relay Hub (server)
```

### 4.2 Core 建议 API（草案）

```js
import { createAdapter } from '@vibebuddy/adapter-core'

const adapter = createAdapter({
  relayUrl: 'http://127.0.0.1:4097',
  tool: 'kiro',
  sourceId: makeSourceId('kiro', pid, cwd),   // 统一规则
  capabilities: ['events'],                    // 声明 Tier B/C
  name: 'Kiro IDE',
})

await adapter.register()       // 自动心跳
adapter.thinking(sessionId, 'Generating...')
adapter.toolStarted(sessionId, { id, name: 'fsWrite' })
adapter.toolDone(sessionId, { id, name: 'fsWrite' })
adapter.idle(sessionId)

// 仅 Tier A/B 可用：
const decision = await adapter.askPermission(sessionId, { tool: 'bash', message })
// decision: 'allow' | 'deny'
```

> 状态映射的"唯一真相"放在 core 的 `mapping` 里。`opencode.ts`、两个 adapter 全部改为调用 core helper，**删除各自的 isComplete/toolStatus 副本**。这一步同时解决了第 3.2 的漂移问题。

### 4.3 迁移收益

- 接入新工具的工作量从"实现整套 HTTP + 映射 + 轮询"降为"写一个把原生事件翻译成 canonical event 的函数"。
- 状态语义只有一份，改一处全局生效。
- 能力分级显式化，PWA 据此调整 UI。

---

## 5. Kiro 接入设计

### 5.1 Kiro 暴露的扩展面：Agent Hooks

Kiro 提供 **Agent Hooks**，可在以下事件触发，执行 `runCommand`（跑 shell 命令）或 `askAgent`（给 agent 下指令）：

| Hook 事件 | 触发时机 | 可映射到 |
|-----------|----------|----------|
| `promptSubmit` | 用户提交 prompt | status THINKING + 注册 source |
| `preToolUse` | 工具执行前 | tool started (+ 潜在权限 gate) |
| `postToolUse` | 工具执行后 | tool completed/failed |
| `agentStop` | agent 回合结束 | status IDLE |
| `preTaskExecution` / `postTaskExecution` | spec 任务前后 | 任务级状态 |
| `fileEdited` / `fileCreated` | 文件变更 | log 事件 |

→ Kiro 落在 **Tier B**：事件能拿到，权限闭环受限于 hook 能否阻塞等待远程回复。

### 5.2 推荐方案：Hook + 轻量 CLI

`runCommand` 类 hook 调用一个小 CLI（基于 `@vibebuddy/adapter-core`），把 Kiro 事件 POST 到 relay：

```
Kiro Agent Hook (runCommand)
   → node kiro-adapter/emit.js --event preToolUse --tool <name> --session <id>
       → adapter-core.sendEvents(...) → POST /api/event → Relay Hub → PWA
```

Hook 定义示例（promptSubmit → THINKING）：

```jsonc
{
  "eventType": "promptSubmit",
  "hookAction": "runCommand",
  "command": "node E:/AI/vibe-companion/kiro-adapter/emit.js --event promptSubmit"
}
```

Hook 定义示例（preToolUse → tool started）：

```jsonc
{
  "eventType": "preToolUse",
  "hookAction": "runCommand",
  "toolTypes": "*",
  "command": "node E:/AI/vibe-companion/kiro-adapter/emit.js --event preToolUse"
}
```

### 5.3 权限闭环的现实限制（如实说明）

- OpenCode 的 `permission.ask` 是**进程内同步 hook**，能阻塞并把手机决策写回 `output.status`——所以是真闭环。
- Kiro 的 `preToolUse` hook 走 `runCommand`，**该命令能否阻塞等待手机回复，取决于 Kiro 是否会等待命令退出码再决定是否放行**。
  - 若 Kiro 等待并依据退出码放行/拦截：CLI 可以 `waitForReply()` 轮询 `/api/replies`，拿到 reject 就以非零退出 → **可实现 Tier B 权限闭环**。
  - 若 Kiro 不阻塞：则 Kiro 退化为 **Tier C 风格的只读监控**（状态可见，权限不可控）。
- 这一点**需要在真实 Kiro 环境中验证 hook 的阻塞语义**，是 Phase 5 的第一个待验证项（见第 6 节）。

### 5.4 备选方案

- 若 Agent Hooks 不满足，可观察 Kiro 的工作区产物（如 `.kiro/specs/**/tasks.md` 变更）做 Tier C 监控——但这只能反映 spec 任务状态，粒度粗。

---

## 6. 行动建议（Phase 5）

| 优先级 | 行动 | 产出 |
|--------|------|------|
| P0 | 验证 Kiro `preToolUse` hook 的阻塞语义 | 决定 Kiro 是 Tier B 还是 Tier C |
| P0 | 提取 `@vibebuddy/adapter-core`（identity + transport + mapping） | 共享库 |
| P1 | OpenCode plugin、ZCode adapter 重构为 core 薄映射层 | 删除三份重复状态映射 |
| P1 | 实现 `kiro-adapter`（CLI + hook 定义） | Kiro 接入 |
| P1 | Hub 按 `capabilities` 校验行为，PWA 按 Tier 调整 UI | 能力分级落地 |
| P2 | adapter 共享类型（即使 JS，也用 JSDoc + d.ts） | 字段拼写防护 |

---

## 7. 一句话总结

> **当前每接一个工具都费劲，根因不是"工具不同"，而是我们把"相同的传输/身份/状态映射"在每个 adapter 里重写了一遍，还把状态语义散成了三份真相。** 解决办法是抽出 `@vibebuddy/adapter-core`，让每个 adapter 只负责"把本工具的原生事件翻译成 canonical event"。Kiro 可经 Agent Hooks 以 Tier B 方式接入，权限是否能真闭环取决于 hook 的阻塞语义，需实测确认。
