# Local E2E Verification Matrix

本文档区分各类验证，避免把模拟测试误称为真实端到端测试。

## 1. 单元/脚本级 stats 验证

命令：

```cmd
npm run verify:pwa-stats --prefix E:\AI\vibe-companion\server
```

覆盖：

- Node VM 加载真实 `app/js/legacy-app.js`。
- 使用 DOM stub 断言 `Tools` / `Errors` / `Duration`。

不覆盖：

- 不启动真实浏览器。
- 不连接真实 Relay WebSocket。
- 不触发真实 OpenCode。

## 2. 本地 Firefox 合成 WebSocket 渲染测试

命令：

```cmd
npm run verify:firefox-stats --prefix E:\AI\vibe-companion\server
```

覆盖：

- 启动本机 Firefox headless。
- 在真实 Firefox DOM 中加载 `legacy-app.js`。
- 使用测试页模拟 WebSocket 消息，断言 stats UI。

不覆盖：

- 不连接真实 Relay。
- 不触发真实 OpenCode。

## 3. 本地 Firefox + 真实 Relay + 真实 OpenCode 思考+工具统计 E2E

命令：

```cmd
npm run e2e:firefox-opencode --prefix E:\AI\vibe-companion\server
```

默认使用：

```text
OPENCODE_E2E_MODEL=zhipuai-coding-plan/glm-4.6v
VIBE_RELAY_HOST=127.0.0.1:4097
```

覆盖：

- Firefox 真实连接 Relay `/ws`。
- 脚本启动真实 `opencode run`。
- 浏览器端观察真实 `opencode:*` source 的 status 消息。
- 断言 Firefox 收到真实 OpenCode `THINKING`/`EXECUTING` 活动和后续 `IDLE`。
- 断言 OpenCode CLI 输出期望文本。
- **断言 Tools >= 1**：验证真实工具调用被 PWA stats 计数。

最近本机通过结果示例：

```text
ok real-opencode firefox status=THINKING tools=1 errors=0 duration=00:06 messages=140 session=ses_...
Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0
```

## 4. 本地 Firefox + 真实 OpenCode 强制工具审批 E2E

命令：

```cmd
npm run e2e:firefox-opencode-approval --prefix E:\AI\vibe-companion\server
```

覆盖：

- 使用 `VIBE_FORCE_TOOL_APPROVAL=1` 环境变量启用 `tool.execute.before` hook。
- OpenCode 每次执行工具前，plugin 通过 Relay 发送 permission 请求到 Firefox。
- Firefox 显示 permission overlay，自动点击 Allow。
- Plugin 收到 approved 回复，工具继续执行。
- 断言 Firefox 收到 permission 消息、Tools >= 1、最终状态为 IDLE/COMPLETE。

最近本机通过结果示例：

```text
ok force-tool-approval firefox permission=tool_1780329268352_588246407574e8 tools=1 errors=0 duration=00:05 messages=132
Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0
```

注意：此用例通过 `tool.execute.before` hook 强制拦截，不依赖 OpenCode 原生 `permission.asked` hook。OpenCode 默认将 bash 标记为 auto-allow，此 hook 绕过该机制实现手机端审批。

## 5. 本地 Firefox + 真实 Relay Prompt 回答矩阵 E2E

命令：

```cmd
npm run e2e:firefox-relay-prompt --prefix E:\AI\vibe-companion\server
```

覆盖 5 个场景：

| 场景 | 类型 | 行为 | 预期结果 |
|------|------|------|----------|
| permission-allow | permission | 点击 Allow Once | reply_ack accepted |
| permission-reject | permission | 点击 Deny | reply_ack rejected |
| question-answer | question | 点击第一个选项 | reply_ack accepted |
| question-skip | question | 点击 Skip | reply_ack skipped |
| wrong-request | (无效) | 发送未知 requestType | 无 overlay，无崩溃 |

覆盖方式：

- Firefox 真实连接 Relay `/ws`。
- 脚本通过 `/api/register` 注册测试 adapter。
- 脚本通过 `/api/event` 注入真实 pending prompt 请求。
- Firefox UI 显示对应 overlay 并执行操作。
- Relay 返回正确的 `reply_ack`。
- 脚本通过 `/api/replies?sourceId=...` 取到 queued reply。

最近本机通过结果示例：

```text
ok relay-prompt firefox scenarios=permission-allow,permission-reject,question-answer,question-skip,wrong-request queued=4 messages=10 acks=5
Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0
```

不覆盖：

- 该用例不是 OpenCode 自己触发的 `permission.asked` 或 `question.asked`。
- 它验证的是通用 Relay/PWA prompt 回答闭环。

## 6. Relay `/api/event` 注入广播验证

命令：

```cmd
npm run verify:stats --prefix E:\AI\vibe-companion\server
```

覆盖：

- 向 Relay `/api/event` 注入事件。
- 验证 WebSocket 广播到连接的客户端。
- 不是 UI 测试，只验证 Relay 传输层。

## 7. 推荐本地验证顺序

```cmd
npm run typecheck --prefix E:\AI\vibe-companion\server
npm run lint --prefix E:\AI\vibe-companion\server
npm run build --prefix E:\AI\vibe-companion\server
npm run verify:pwa-stats --prefix E:\AI\vibe-companion\server
npm run verify:firefox-stats --prefix E:\AI\vibe-companion\server
npm run verify:stats --prefix E:\AI\vibe-companion\server
npm run e2e:firefox-opencode --prefix E:\AI\vibe-companion\server
npm run e2e:firefox-opencode-approval --prefix E:\AI\vibe-companion\server
npm run e2e:firefox-relay-prompt --prefix E:\AI\vibe-companion\server
```

## 8. 验证覆盖矩阵总览

| 测试层级 | 真实浏览器 | 真实 Relay | 真实 OpenCode | 覆盖内容 |
|----------|-----------|-----------|--------------|----------|
| verify:pwa-stats | - | - | - | stats 计数逻辑 |
| verify:firefox-stats | Firefox | - | - | stats DOM 渲染 |
| verify:stats | - | Relay | - | 事件广播传输 |
| e2e:firefox-opencode | Firefox | Relay | OpenCode | 状态+工具统计 |
| e2e:firefox-opencode-approval | Firefox | Relay | OpenCode | 工具审批闭环 |
| e2e:firefox-relay-prompt | Firefox | Relay | - | 5场景 prompt 回答 |
