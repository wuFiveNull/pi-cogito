/**
 * UI app definition — one mountable user interface.
 *
 * A UiApp is a self-contained UI (web dashboard, admin panel, mobile web app,
 * ...) that registers:
 * - a base path (e.g. "/admin", "/mobile")
 * - a static asset directory (built frontend output)
 * - optional API routes handled by the host
 *
 * Future mobile UIs register the same way; the host serves all apps through
 * one HTTP server.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export interface UiApiRoute {
	method: "GET" | "POST" | "PUT" | "DELETE";
	path: string;
	handler(req: IncomingMessage, res: ServerResponse, url: URL): void | Promise<void>;
}

export interface UiApp {
	/** Unique app id (e.g. "admin", "mobile"). */
	id: string;
	/** Display name (e.g. "管理面板", "手机端"). */
	name: string;
	/** Base path prefix, e.g. "/admin". Must start with "/". */
	basePath: string;
	/** Absolute path of the built frontend output directory. */
	distDir: string;
	/** Optional API routes mounted under `${basePath}/api`. */
	apiRoutes?: UiApiRoute[];
	/** Optional index document fallback (default "index.html"). */
	indexFile?: string;
}
