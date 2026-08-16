/**
 * UI registry — mounts multiple UI apps (web today, mobile later) on one
 * HTTP server alongside a gateway's WebChannel.
 *
 * Usage with @cogito/gateway:
 *
 *   const ui = new UiRegistry();
 *   ui.register({ id: "admin", name: "管理面板", basePath: "/admin", distDir: "..." });
 *   ui.register({ id: "mobile", name: "手机端", basePath: "/mobile", distDir: "..." });
 *
 *   webChannel.registerApi("GET", "/ui/*", (url, res) => ui.handle(url, res));
 *
 * New UIs are added by registering another UiApp — no host changes needed.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { serveStaticFile } from "./static.ts";
import type { UiApp } from "./types.ts";

export class UiRegistry {
	private readonly apps = new Map<string, UiApp>();

	/** Register (or replace) one UI app. */
	register(app: UiApp): void {
		if (!app.basePath.startsWith("/")) {
			throw new Error(`UiApp basePath must start with "/": ${app.id}`);
		}
		this.apps.set(app.id, app);
	}

	unregister(id: string): void {
		this.apps.delete(id);
	}

	list(): UiApp[] {
		return [...this.apps.values()];
	}

	get(id: string): UiApp | undefined {
		return this.apps.get(id);
	}

	/**
	 * Route one request: find the app whose basePath is the longest prefix of
	 * the URL path, serve static assets under it, and dispatch `${base}/api/*`
	 * to the app's API routes. Returns true when handled.
	 */
	handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
		const pathname = url.pathname;
		const app = this.matchApp(pathname);
		if (!app) return false;

		const rest = pathname.slice(app.basePath.length) || "/";
		if (rest.startsWith("/api")) {
			return this.dispatchApi(app, req, res, url, rest);
		}
		return serveStaticFile(app.distDir, rest, req, res, { indexFile: app.indexFile });
	}

	/** Longest-prefix app match. */
	matchApp(pathname: string): UiApp | undefined {
		let best: UiApp | undefined;
		for (const app of this.apps.values()) {
			const base = app.basePath;
			const matches =
				pathname === base || (base === "/" ? pathname.startsWith("/") : pathname.startsWith(`${base}/`));
			if (matches) {
				if (!best || base.length > best.basePath.length) {
					best = app;
				}
			}
		}
		return best;
	}

	private dispatchApi(app: UiApp, req: IncomingMessage, res: ServerResponse, url: URL, rest: string): boolean {
		const apiPath = rest.slice("/api".length) || "/";
		for (const route of app.apiRoutes ?? []) {
			if (route.method !== req.method) continue;
			if (route.path === apiPath || (route.path.endsWith("*") && apiPath.startsWith(route.path.slice(0, -1)))) {
				void route.handler(req, res, url);
				return true;
			}
		}
		res.writeHead(404).end("Not found");
		return true;
	}
}
