# VibeBuddy Kiro Adapter (PoC)

Tier B 接入：通过 Kiro **Agent Hooks** 把 Kiro 的事件上报到 VibeBuddy Relay Hub。

完整设计与层级模型见 [`../docs/adapter-architecture.md`](../docs/adapter-architecture.md)。

## 状态

概念验证（Phase 5 第一步）。当前仅实现**事件上报**（状态 / 工具 / 日志），
不包含权限闭环——权限是否能闭环取决于 Kiro `preToolUse` hook 的阻塞语义，需实测确认。

## 工作原理

```
Kiro Agent Hook (runCommand)
  → node emit.js --event <e> [--tool <name>] [--ok|--fail]
    → POST /api/register + /api/event → Relay Hub → PWA
```

## 配置 Kiro Hooks

为下列事件各创建一个 `runCommand` 类型的 Agent Hook（路径按实际调整）：

| Kiro 事件 | command |
|-----------|---------|
| promptSubmit | `node E:/AI/vibe-companion/kiro-adapter/emit.js --event promptSubmit` |
| preToolUse | `node E:/AI/vibe-companion/kiro-adapter/emit.js --event preToolUse` |
| postToolUse | `node E:/AI/vibe-companion/kiro-adapter/emit.js --event postToolUse` |
| agentStop | `node E:/AI/vibe-companion/kiro-adapter/emit.js --event agentStop` |

## 本地测试

先启动 relay（`cd ../server && npm run dev`），手机/浏览器打开 `http://<PC-IP>:4097`，然后：

```cmd
node emit.js --event promptSubmit
node emit.js --event preToolUse --tool fsWrite
node emit.js --event postToolUse --tool fsWrite --ok
node emit.js --event agentStop
```

PWA 上应出现一个 `kiro:...` source 卡片并实时切换状态。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `VIBE_RELAY_URL` | `http://127.0.0.1:4097` | Relay Hub 地址 |
| `VIBE_SESSION_ID` | `kiro` | 会话标识 |

## 已知限制

- 仅 Tier B 事件上报，无权限闭环（见 adapter-architecture.md §5.3）。
- 每次调用是独立进程，无法跨调用维护工具计数；统计依赖 Hub/PWA 侧聚合。
- 后续应迁移到 `@vibebuddy/adapter-core` 共享库，去除本文件中重复的传输/映射逻辑。
