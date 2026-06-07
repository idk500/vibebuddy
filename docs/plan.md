# VibeBuddy — 开发计划

> 版本: v0.1.5 | 日期: 2026-06-06 | A-SPICE 对齐

## 开发阶段

> 状态图例：✅ 已完成 | 🔄 进行中 | ⏳ 待开发

### Phase 1: MVP 安灯看板 (v0.1.0) — ✅ 已完成

**目标**: 手机实时显示 OpenCode 任务状态

**范围**:
- [SWE.1] Relay Server：WebSocket 服务 + OpenCode SDK 事件订阅
- [SWE.2] PWA Frontend：连接界面 + 安灯状态显示 + 活动日志
- [SWE.3] 通信协议：JSON 消息格式
- [SWE.4] 手动功能测试清单

**交付物**:
- `server/` — 可运行的 Node.js Relay Server
- `app/` — 可在手机浏览器打开的 PWA
- `docs/` — 需求 + 架构文档

**验收标准**:
1. Server 连接 `opencode serve` 并订阅事件
2. 手机打开 PWA，输入 PC IP:Port，连接成功
3. OpenCode 执行任务时，手机实时显示状态变化
4. 活动日志滚动显示工具调用记录
5. 断线自动重连

**预估工作量**: 1-2 个开发迭代

---

### Phase 1.5: Multi-source Relay Hub + Reliable Remote Approvals (v0.1.5) — ✅ 已完成

**目标**: 将单 OpenCode 转发器升级为多 source/session Relay Hub，并让手机确认真正闭环到原始工具请求。

**范围**:
- [SYS.2] 新增多 source/session、pending request、ACK、权限安全默认值需求
- [SYS.3] Relay Hub 架构：source registry、session registry、pending request registry、reply queue
- [SWE.1] Relay Server：实现 `/api/register`、`/api/event`、`/api/replies` 和 source-bound WS reply routing
- [SWE.2] OpenCode Plugin：注册 source、上报 source-bound 事件、实现 `permission.ask` 轮询闭环
- [SWE.3] PWA：prompt 携带 source/session/request，点击后展示 sent/accepted/failed/expired ACK
- [SWE.4/SWE.5] 自动化闭环测试：两个 mock source 并发隔离、ACK、TypeScript typecheck

**非范围**:
- Phase 2 语音输入
- Claude/Kilo/ZCode 的完整 adapter 实现；本阶段只定义并验证通用 adapter 协议
- OpenCode `question.asked` 的同步 hook（若 OpenCode 未暴露，则先做 source-bound 转发和 ACK）

**交付物**:
- 更新后的 `docs/requirements.md`、`docs/architecture.md`、`docs/plan.md`
- Relay Hub implementation in `server/src/`
- OpenCode plugin implementation in `opencode-plugin/index.js` and installed copy sync
- PWA prompt/ACK UI updates in `app/js/legacy-app.js`
- 自动化验收脚本或等价本地验证命令输出

**验收标准**:
1. 两个 mock source 同时注册并发出 permission request，手机/WS 回复 source A 时只有 source A 的 `/api/replies` 拿到回复
2. `permission_reply` 缺失或错误 `sourceId/requestID` 时，Relay Hub 返回 `failed` 或 `expired` ACK，不投递给任意 adapter
3. 手机 prompt 显示 source/session/request 信息，点击后显示等待 ACK，并收到 `accepted` 后关闭或标记成功
4. OpenCode plugin 加载后能注册 source；`permission.ask` 收到手机回复后设置 `output.status` 为 `allow` 或 `deny`
5. `cd server && npx tsc --noEmit` 通过

**前置条件**: Phase 1 status display 基本可用

---

### Phase 1.6: 工程加固 (v0.1.6) — ✅ 已完成

**目标**: 补齐 A-SPICE 工程实践，消除文档与代码脱钩。

**范围**:
- [SWE.3] 拆分 `index.ts` → `hub.ts`（Relay Hub 核心）+ `state-machine.ts`（形式化状态机）
- [SWE.4] 引入 Vitest，新增 33 个单元测试（状态机 23 + Hub 路由 10）
- [SWE.1] 新增技术规格 `specification.md`
- [追溯] 新增需求追溯矩阵 `trace-matrix.md`
- [SWE.5] 新增测试策略 `test-strategy.md`
- [审查] 新增工程审查报告 `ENGINEERING_REVIEW.md`
- 删除死代码：未使用的 `app/js` 模块化文件、`server/src/relay.ts`
- 统一品牌名为 VibeBuddy，同步全部文档

**验收标准**:
1. `npm run check`（typecheck + lint + test）通过
2. 33 个单元测试全部通过
3. 文档与代码模块结构一致

**前置条件**: Phase 1.5 完成

---

### Phase 5: 统一 Adapter 框架 + 多工具接入 (v0.2.x) — ⏳ 待开发

**目标**: 降低新 AI 工具接入成本，从"每个工具一套适配代码"演进为"统一 adapter SDK + 工具特定映射层"。

**范围**:
- 提取 `@vibebuddy/adapter-core` 共享库（注册、心跳、事件发送、回复轮询、状态机映射）
- OpenCode plugin、ZCode adapter 重构为基于 core 的薄映射层
- 新增 Kiro adapter（接入方式见 `docs/adapter-architecture.md`）
- 定义 adapter 能力分级（events-only / permission-sync / question-sync）

**前置条件**: Phase 1.6 完成；详见 `docs/adapter-architecture.md`

---

### Phase 2: 语音输入 (v0.2.0)

**目标**: 手机麦克风作为 PC 无线麦克风

**范围**:
- [SWE.1] Phone 端：麦克风采集 + WebSocket 二进制传输
- [SWE.2] Server 端：音频接收 + 转发到 PC 音频设备/文件
- [SWE.3] UI：按键说话按钮 + 音量可视化

**前置条件**: Phase 1 完成

---

### Phase 3: 传感器扩展 (v0.3.0)

**目标**: 摄像头拍照 + OCR

**范围**:
- [SWE.1] Phone 端：摄像头 capture
- [SWE.2] Server 端：图片接收 + OCR 处理
- [SWE.3] UI：拍照界面 + 结果预览

**前置条件**: Phase 2 完成

---

### Phase 4: 完善 (v0.4.0)

**目标**: 多工具支持 + 稳定性 + 性能优化

**范围**:
- 多 AI 工具适配（不只 OpenCode）
- 国际化 (i18n)
- 性能优化
- PWA 离线增强
- 安灯通知音效

**前置条件**: Phase 3 完成

## A-SPICE 过程映射

| A-SPICE 过程 | 本项目实践 | 产出物 | 状态 |
|-------------|-----------|--------|------|
| SYS.1 利益相关方需求 | 用户需求整理 | docs/requirements.md §1 | ✅ |
| SYS.2 系统需求分析 | 功能/非功能需求细化 | docs/requirements.md §2-7 | ✅ |
| SYS.3 系统架构 | 系统组件 + 数据流设计 | docs/architecture.md | ✅ |
| SYS.4 系统集成验证 | E2E 验收记录 | docs/acceptance-phase-1.5.md | ✅ |
| SWE.1 软件需求 | 技术规格说明书 | docs/specification.md | ✅ |
| SWE.2 软件架构 | 技术栈 + 模块设计 | docs/architecture.md §2 | ✅ |
| SWE.3 详细设计+实现 | 状态机规格 + 代码 + AGENTS.md | state-machine.ts + 源代码 | ✅ |
| SWE.4 单元验证 | Vitest 单元测试 + 类型检查 + Lint | server/src/*.test.ts (33 用例) | ✅ |
| SWE.5 集成测试 | 测试策略 + Firefox E2E 脚本 | docs/test-strategy.md + app/scripts | ✅ |
| SWE.6 资质测试 | 真机端到端测试 | docs/android-browser-test-plan.md | 🔄 |
| 支持过程 追溯性 | 需求追溯矩阵 | docs/trace-matrix.md | ✅ |
| 支持过程 质量保证 | 工程审查报告 | docs/ENGINEERING_REVIEW.md | ✅ |

## A-SPICE 裁剪说明

作为个人/小团队项目，对 A-SPICE 做如下裁剪（裁剪本身是有意识的决策，而非遗漏）：

- **不设独立测试团队** — 开发者自测 + 用户功能审查；但保留单元测试 + E2E + 测试策略文档（SWE.4/SWE.5 不裁剪）
- **不设变更控制委员会（SUP.10 简化）** — 版本管理通过 Git Conventional Commits，每个 task 一次提交
- **保留需求追溯矩阵** — 见 `trace-matrix.md`，功能 ID (F01-F58) → 规格 → 代码 → 测试全链路追溯（此前版本曾裁剪，Phase 1.6 恢复）
- **CI/CD（SUP.8 简化）** — 暂用本地 `npm run check` 替代流水线，后续引入 GitHub Actions
- **每 Phase 作为一个发布单元** — 减少管理开销
