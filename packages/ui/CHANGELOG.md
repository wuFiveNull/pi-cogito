# Changelog

## [Unreleased]

### Added

- UI 托管层:`UiRegistry` 多应用注册与最长前缀路由(静态资源 + `${basePath}/api/*` 路由 + SPA fallback),新 UI 只需注册一个 `UiApp` 即可挂载,宿主代码无需改动。
- 内置 web 应用(`src/web/`,Vite + React SPA):聊天(SSE 流式、thinking 折叠块、工具调用链、markdown 渲染与代码高亮、回复引用、附件上传、停止生成)、知识与运行(记忆文档、drift skills、MCP、运行状态)、监控(会话浏览、tick 记录 + 阶段回放、投递、记忆相似检索 / 批量删除、插件面板)、设置(多 Provider 切换、模型探测)。
- 数据 API:`createWebApi` 直接读 pi 的 sqlite / jsonl,零运行时依赖,`web-api.ts` 提供全部数据端点。
- 插件 SDK 构建(`scripts/build-sdk.mjs`):产出固定路径的 ESM 静态资源(`dist/web/sdk/*.js`),页面 importmap 将 `@pi/web-sdk`、`react`、`react-dom/client`、`jsx-runtime` 指向共享运行时(宿主与插件同一 React 实例);任何 surface(桌面 / 手机 web / 独立 app)提供同一 importmap 即可复用全部插件。

### Fixed

- 修复聊天页 SSE delta 事件读取字段(读取 `delta` 而非 `content`),流式增量现在能正确追加到会话气泡;thinking 增量不再干扰正文缓冲。
