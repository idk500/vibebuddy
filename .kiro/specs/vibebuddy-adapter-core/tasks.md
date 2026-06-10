# VibeBuddy Adapter 统一 + Kiro 验证

## 概述

提取 `@vibebuddy/adapter-core` 共享层消除 adapter 重复，然后实测 Kiro hook 阻塞语义确定权限闭环可行性。

## 阶段一：adapter-core 提取

- [ ] 1. 创建 adapter-core（identity + transport + canonical helpers + permission + mapping）
- [ ] 2. 为 adapter-core 写 node:test 单元测试（身份确定性、状态优先级、消息形状）
- [ ] 3. 迁移 kiro-adapter 使用 core，对运行中的 relay 验证
- [ ] 4. 迁移 zcode-adapter 的 transport/identity/emit 使用 core
- [ ] 5. 迁移 opencode-plugin 的 transport/identity/permission 使用 core，本地模拟加载验证
- [ ] 6. 更新文档（adapter-architecture / operations / AGENTS）并提交

## 阶段二：Kiro hook 阻塞语义验证

- [ ] 7. 受控创建 preToolUse hook，实测是否阻塞等待退出码/输出
- [ ] 8. 记录结论，更新 adapter-architecture.md（确定 Kiro 是 Tier B 真闭环还是 Tier C），清理测试 hook，提交
