# Android Browser 集中测试说明

本文档定义在连接实际 Android 设备后需要执行的浏览器验收步骤。当前自动化验证链为：

1. 单元/脚本级：`npm run verify:pwa-stats --prefix server`
2. 本地浏览器集成：`npm run verify:firefox-stats --prefix server`
3. Android 浏览器真机：按本文档人工集中验证

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

本轮重点验证 stats 行为：

- `Tools` 是否随工具调用递增。
- `Errors` 是否随工具失败/错误日志递增，且不重复计数。
- `Duration` 是否在 `THINKING` / `EXECUTING` 时递增，在 `IDLE` 时冻结。
- 页面布局、日志滚动和状态回落没有回归。

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

## 测试步骤 E：布局和长期运行

1. 横屏持有手机。
2. 连续触发多条日志，直到 Activity Log 可滚动。
3. 观察左侧安灯面板。

预期：

- 左侧安灯面板不被日志挤到页面下方。
- 右侧日志面板独立滚动。
- 状态、stats row 始终可见。

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
E 布局长期运行：通过 / 失败，备注：

截图/录像路径：
遗留问题：
```
