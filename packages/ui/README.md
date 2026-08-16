# @cogito/ui

UI hosting layer for pi modules. Hosts multiple UI apps on one HTTP server —
web dashboards today, mobile UIs later. New UIs are plain `UiApp`
registrations; no host code changes needed.

```ts
import { createWebApi, builtinWebApp, UiRegistry } from "@cogito/ui";
import { MessageBus, WebChannel } from "@cogito/gateway";

const channel = new WebChannel({ allowFrom: ["*"] }, new MessageBus(), { port: 8787 });
const ui = new UiRegistry();
ui.register(builtinWebApp); // 内置 web 应用(聊天/知识运行/监控/设置)

const webApi = createWebApi({ sessionsDir, proactiveDbPath, memoryDbPath, mcpConfigPath, ... });
channel.registerApi("GET", "/*", (url, res, req) => {
	if (webApi.handle(req, res, url)) return;
	if (!ui.handle(req, res, url)) res.writeHead(404).end("Not found");
});
```

Features: longest-prefix app routing, static asset serving (path-traversal
protected, MIME types, SPA fallback), per-app API routes under `/api`.

## 内置 web 应用

`packages/ui/src/web/` — React SPA(Vite 构建 → `dist/web/`):

- **聊天**:会话列表、消息流(SSE,thinking 折叠块 / 工具调用链 / markdown / 代码高亮)、回复引用、附件上传、停止生成
- **知识与运行**:记忆文档、drift skills、MCP、运行状态
- **监控**:会话浏览、tick 记录 + 阶段回放、投递、记忆(相似检索 / 批量删除)、插件面板
- **设置**:多 Provider(api / opencode-go / codex)切换、模型探测

数据端点见 `src/web-api.ts`(`createWebApi`),直接读 pi 的 sqlite / jsonl,零运行时依赖。

## 插件 SDK(@pi/web-sdk)

插件模块源码通过 importmap 共享宿主运行时:

```js
// 插件 moduleSource(注册于 createWebApi 的 plugins 选项)
import { h, api, Tag } from "@pi/web-sdk";
import { createRoot } from "react-dom/client";

export function mount(container) {
	const root = createRoot(container);
	root.render(h(Tag, { tone: "send" }, api ? "sdk ok" : ""));
}
```

构建时 `scripts/build-sdk.mjs` 产出 `dist/web/sdk/*.js`(固定路径,无 hash):

| 文件 | 内容 |
|---|---|
| `react.js` / `react-dom-client.js` / `jsx-runtime.js` | esbuild 打包的共享 React(宿主与插件同一实例) |
| `sdk.js` | api 封装 + 组件库(Button / Card / Tag / MetricTile / Table)+ `h` |

页面 `index.html` 的 importmap 将这些裸 specifier 指向 `/assets/sdk/*.js`。

**手机端/未来前端**:插件只依赖「importmap 指向同一组 sdk 端点」这一约定,
任何 surface(桌面 / 手机 web / 独立 app)提供同样的 importmap 即可复用全部插件。
SDK 文件是纯 ESM 静态资源,路径稳定。

## 启动预览

仓库根目录启动 gateway(`scripts/cogito-gateway.ts`),`config.json` 中
`channels.web.enabled: true` 时挂载 web 仪表盘:

```bash
npm run gateway
```

WebChannel + 内置页面 + 数据 API + channel agent 桥(网页消息 → 流式回复)。
监听地址与端口取 `config.json` 的 `web.host` / `web.port`(本仓库示例为
`127.0.0.1:8787`);可用 `GATEWAY_CONFIG` 覆盖配置文件路径、`COGITO_PROJECT_DIR`
覆盖项目目录。
