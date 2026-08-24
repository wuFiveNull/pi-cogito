# Changelog

## [Unreleased]

### Added

- UI 托管层:`UiRegistry` 多应用注册与最长前缀路由(静态资源 + `${basePath}/api/*` 路由 + SPA fallback),新 UI 只需注册一个 `UiApp` 即可挂载,宿主代码无需改动。
- 内置 web 应用(`src/web/`,Vite + React SPA):聊天(SSE 流式、thinking 折叠块、工具调用链、markdown 渲染与代码高亮、回复引用、附件上传、停止生成)、知识与运行(记忆文档、drift skills、MCP、运行状态)、监控(会话浏览、tick 记录 + 阶段回放、投递、记忆相似检索 / 批量删除、插件面板)、设置(多 Provider 切换、模型探测)。
- 数据 API:`createWebApi` 直接读 pi 的 sqlite / jsonl,零运行时依赖,`web-api.ts` 提供全部数据端点。
- 插件 SDK 构建(`scripts/build-sdk.mjs`):产出固定路径的 ESM 静态资源(`dist/web/sdk/*.js`),页面 importmap 将 `@pi/web-sdk`、`react`、`react-dom/client`、`jsx-runtime` 指向共享运行时(宿主与插件同一 React 实例);任何 surface(桌面 / 手机 web / 独立 app)提供同一 importmap 即可复用全部插件。

### Fixed

- 修复聊天页 SSE delta 事件读取字段(读取 `delta` 而非 `content`),流式增量现在能正确追加到会话气泡;thinking 增量不再干扰正文缓冲。
- Drift 运行列表在无进行中的 run 时回退展示最近历史运行(此前只查 `drift_active_runs` 表,daemon 空闲时面板恒为空)。
- Tick 记录读取支持 wake 库:`createWebApi` 新增 `wakeDbPath`,检测到
  `wake_tick_log` 表时按 wake 结构映射(wake_id→id、status→action、observations
  计数→步数),tick 详情/步骤路由放宽为非数字 ID。
- 新增「用量」监控页:`/api/dashboard/usage` 聚合 channel-agent-sessions 里的
  `message.usage`(总 token/成本、按渠道分布),趋势以**月历**呈现:一行一周、
  单元格显示当日用量、悬浮显示当天明细(输入/输出/调用次数/成本)、可切换月份;
  只统计真实聊天用量,不含测试。
- tick 详情回放为 content 类 observation 展示候选标题列表(前 15 条,带原文链接)。
