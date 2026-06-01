# Local E2E Verification Matrix

本文档区分三类验证，避免把模拟测试误称为真实端到端测试。

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

## 3. 本地 Firefox + 真实 Relay + 真实 OpenCode 思考 E2E

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

最近本机通过结果示例：

```text
ok real-opencode firefox status=IDLE tools=0 errors=0 duration=00:07 messages=104 session=ses_...
Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0
```

注意：该用例是“思考/状态事件”E2E，不要求工具调用，也不要求权限确认。

## 4. 本地 Firefox + 真实 Relay Prompt 回答 E2E

命令：

```cmd
npm run e2e:firefox-relay-prompt --prefix E:\AI\vibe-companion\server
```

覆盖：

- Firefox 真实连接 Relay `/ws`。
- 脚本通过 `/api/register` 注册测试 adapter。
- 脚本通过 `/api/event` 注入真实 pending `permission` 请求。
- Firefox UI 显示 permission overlay 并点击 `Allow Once`。
- Relay 返回 `reply_ack: accepted`。
- 脚本通过 `/api/replies?sourceId=...` 取到 queued reply。

最近本机通过结果示例：

```text
ok relay-prompt firefox request=per-... reply=once messages=3
Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0
```

不覆盖：

- 该用例不是 OpenCode 自己触发的 `permission.asked` 或 `question.asked`。
- 它验证的是通用 Relay/PWA prompt 回答闭环。

## 5. 当前未通过/未具备的真实 OpenCode Prompt E2E

尝试过：

```cmd
opencode run --dir E:\AI\vibe-companion --model zhipuai-coding-plan/glm-4.6v --format json "Ask me a multiple choice clarification question before doing anything. Use the available question mechanism if one exists."
```

结果：OpenCode 只返回普通文本，没有触发 `question.asked` hook。

也尝试过让 OpenCode 执行无害 shell 命令：

```cmd
opencode run --dir E:\AI\vibe-companion --model zhipuai-coding-plan/glm-4.6v --format json "Run this shell command exactly and report its output: echo VIBE_PERMISSION_E2E_OK"
```

结果：OpenCode 直接执行 bash 工具并完成，没有触发 `permission.asked` hook。

因此目前不能声称“真实 OpenCode 提问/权限请求 → Firefox 回答”已通过。现有真实覆盖为：

- OpenCode 思考/status E2E：已通过。
- Relay/PWA prompt answer E2E：已通过。
- OpenCode 原生 question/permission hook E2E：未触发，待确认 OpenCode 配置或触发方式。

## 6. 推荐本地验证顺序

```cmd
npm run typecheck --prefix E:\AI\vibe-companion\server
npm run lint --prefix E:\AI\vibe-companion\server
npm run build --prefix E:\AI\vibe-companion\server
npm run verify:pwa-stats --prefix E:\AI\vibe-companion\server
npm run verify:firefox-stats --prefix E:\AI\vibe-companion\server
npm run e2e:firefox-opencode --prefix E:\AI\vibe-companion\server
npm run e2e:firefox-relay-prompt --prefix E:\AI\vibe-companion\server
```

`verify:stats` 仍可用于验证 Relay `/api/event` 注入和广播，但它不是 UI 测试：

```cmd
npm run verify:stats --prefix E:\AI\vibe-companion\server
```
