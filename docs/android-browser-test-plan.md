# Android Browser 集中测试说明

本文档定义在连接实际 Android 设备后需要执行的浏览器验收步骤。当前自动化验证链为：

1. 单元/脚本级：`npm run verify:pwa-stats --prefix server`
2. 本地浏览器集成：`npm run verify:firefox-stats --prefix server`
3. Relay 事件注入：`npm run verify:stats --prefix server`
4. 真实 OpenCode 状态+工具：`npm run e2e:firefox-opencode --prefix server`
5. 真实 OpenCode 工具审批：`npm run e2e:firefox-opencode-approval --prefix server`
6. 5场景 prompt 矩阵：`npm run e2e:firefox-relay-prompt --prefix server`
7. Android 浏览器真机：按本文档人工集中验证

## 测试前置条件

- PC 与 Android 手机在同一局域网。
- PC 端已启动 VibeCoding Companion Relay：

```cmd
cd /d E:\AI\vibe-companion\server
npm run dev
```

或使用项目根目录启动脚本。

- PC 防火墙允许手机访问端口 `4097`。
- 手机浏览器可访问：

```text
http://<PC-IP>:4097
```

## 测试范围

本轮验证覆盖以下行为：

- **Stats**：`Tools` 随工具调用递增、`Errors` 随失败递增且不重复计数、`Duration` 活动时递增空闲时冻结。
- **Permission**：工具审批弹窗（Allow/Deny）和回复闭环。
- **Question**：多选问题弹窗（选择/Skip）和回复闭环。
- **布局**：页面布局、日志滚动和状态回落没有回归。

## 测试步骤 A：基础连接

1. 在 Android 浏览器打开 `http://<PC-IP>:4097`。
2. 确认页面自动连接或手动输入 `<PC-IP>:4097` 后连接成功。
3. 预期：
   - 页面显示主安灯界面。
   - 状态为 `IDLE` 或等待 AI 客户端事件。
   - `Tools = 0`，`Errors = 0`，`Duration = 00:00`。

## 测试步骤 B：通过 Relay 注入事件验证 stats

在 PC 上执行：

```cmd
cd /d E:\AI\vibe-companion\server
npm run verify:stats
```

手机端预期：

- 页面收到 `THINKING` / `tool started` / `tool failed` / `error log` / `IDLE` 序列。
- `Tools` 至少变为 `1`。
- `Errors` 至少变为 `2`：
  - `tool failed` 计 1 次。
  - 普通 error log 计 1 次。
  - `Tool <name> failed` 生成的 error log 不应二次计数。
- `Duration` 在活动期间递增，然后在 `IDLE` 后冻结。

## 测试步骤 C：真实 OpenCode 任务

1. 保持 Relay 和手机页面打开。
2. 在已配置插件的 OpenCode 中启动一个会调用工具的任务，例如要求它读取文件或运行简单命令。
3. 观察手机页面。

预期：

- 思考中显示 `THINKING`。
- 工具执行时显示 `EXECUTING`。
- 工具日志出现在 Activity Log。
- `Tools` 随实际工具调用增加。
- 无错误任务中 `Errors` 保持不增加。
- 任务完成后状态回到 `IDLE`，`Duration` 冻结在本轮任务耗时。

## 测试步骤 D：真实错误路径

1. 触发一个预期失败的工具调用，例如让 OpenCode 执行不存在命令或读取不存在路径。
2. 观察手机页面。

预期：

- 失败工具显示失败日志。
- `Errors` 增加 1。
- 同一个失败工具不因 `Tool <name> failed` 日志重复增加 2 次。
- 状态最终回到 `IDLE` 或进入 `ERROR`，取决于 OpenCode 事件类型。

## 测试步骤 E：Permission 审批

1. 设置环境变量 `VIBE_FORCE_TOOL_APPROVAL=1`。
2. 在 OpenCode 中启动一个会调用工具的任务。
3. 观察手机页面弹出 permission overlay。

预期：

- overlay 显示工具名称和参数摘要。
- 点击 **Allow Once** → 工具继续执行，overlay 消失。
- 点击 **Deny** → 工具被拒绝，状态回到 IDLE。
- 不操作 → 30 秒后超时，工具被拒绝。

## 测试步骤 F：Question 回答

1. 在 OpenCode 中触发一个会产生 `question.asked` 事件的会话。
2. 观察手机页面弹出 question overlay。

预期：

- overlay 显示问题和选项列表。
- 点击某个选项 → 回复发送，overlay 消失。
- 点击 **Skip** → 回复标记为 skipped，overlay 消失。
- 不操作 → 30 秒后超时，回复标记为 skipped。

## 测试步骤 G：布局和长期运行

1. 横屏持有手机。
2. 连续触发多条日志，直到 Activity Log 可滚动。
3. 观察左侧安灯面板。

预期：

- 左侧安灯面板不被日志挤到页面下方。
- 右侧日志面板独立滚动。
- 状态、stats row 始终可见。
- Permission/Question overlay 不影响底层布局。

## 测试步骤 H：无效/异常请求

1. 通过 `/api/event` 注入一个 `requestType` 不是 `permission` 或 `question` 的请求。
2. 观察手机页面。

预期：

- 不弹出任何 overlay。
- 不崩溃。
- 正常 status 消息仍可正常显示。

## 记录模板

```text
设备型号：
Android 版本：
浏览器/版本：
PC IP：
Relay 启动方式：

A 基础连接：通过 / 失败，备注：
B 注入 stats：通过 / 失败，Tools=，Errors=，Duration=，备注：
C 真实 OpenCode 工具任务：通过 / 失败，备注：
D 真实错误路径：通过 / 失败，备注：
E Permission 审批：通过 / 失败，备注：
F Question 回答：通过 / 失败，备注：
G 布局长期运行：通过 / 失败，备注：
H 无效请求：通过 / 失败，备注：

截图/录像路径：
遗留问题：
```
