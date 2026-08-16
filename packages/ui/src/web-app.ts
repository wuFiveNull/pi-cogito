/**
 * 内置 web 页面(cogito web dashboard)。
 *
 * 页面代码在 src/web/(index.html + app.tsx + styles.css),构建时产出到
 * dist/web/。通过 UiRegistry 挂到 WebChannel:
 *
 *   const ui = new UiRegistry();
 *   ui.register(builtinWebApp);                    // basePath "/"
 *   webChannel.registerApi("GET", "/*", (url, res) => ui.handle(req, res, url));
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { UiApp } from "./types.ts";

/**
 * 内置页面目录。
 *
 * 优先使用构建后的 dist/web(包含打包好的 assets);源码运行时(tsx)回退到
 * src/web。两个候选:
 * - 从 dist 运行:import.meta.dirname = packages/ui/dist → dist/web
 * - 从 src 运行:import.meta.dirname = packages/ui/src → ../dist/web
 */
const WEB_PAGE_CANDIDATES = [join(import.meta.dirname, "..", "dist", "web"), join(import.meta.dirname, "web")];

/** 内置页面目录(dist/web 或 src/web)。 */
export const WEB_PAGE_DIR =
	WEB_PAGE_CANDIDATES.find((dir) => existsSync(join(dir, "index.html"))) ?? WEB_PAGE_CANDIDATES[0];

/** 内置聊天页的 UiApp 注册(挂在根路径)。 */
export const builtinWebApp: UiApp = {
	id: "web",
	name: "cogito web",
	basePath: "/",
	distDir: WEB_PAGE_DIR,
	indexFile: "index.html",
};
