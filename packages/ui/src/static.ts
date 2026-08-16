/**
 * Static asset serving for UI apps.
 *
 * Serves files from a UiApp's dist directory with:
 * - path traversal protection (no "..", no absolute escapes)
 * - content-type inference from extension
 * - index document fallback (SPA history routing)
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".map": "application/json",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
};

/** True when the URL path stays inside the given directory. */
export function isPathInside(distDir: string, urlPath: string): boolean {
	// 拒绝任何含 ".." 段的路径(normalize 会把它归一化而绕过检查)。
	if (urlPath.split("/").includes("..")) return false;
	const normalized = normalize(urlPath).replace(/^([/\\])+/, "");
	const full = resolve(distDir, normalized);
	const root = resolve(distDir);
	return full === root || full.startsWith(`${root}${sep}`);
}

/**
 * Serve one request from the app's dist directory.
 * Returns true when the request was handled (including 404 responses).
 */
export function serveStaticFile(
	distDir: string,
	urlPath: string,
	req: IncomingMessage,
	res: ServerResponse,
	options: { indexFile?: string; cacheSeconds?: number } = {},
): boolean {
	if (req.method !== "GET" && req.method !== "HEAD") return false;
	const indexFile = options.indexFile ?? "index.html";
	const cacheSeconds = options.cacheSeconds ?? 0;

	const urlDecoded = decodeURIComponent(urlPath);
	if (!isPathInside(distDir, urlDecoded)) {
		res.writeHead(403).end("Forbidden");
		return true;
	}

	let filePath = join(distDir, normalize(urlDecoded));
	if (existsSync(filePath) && statSync(filePath).isDirectory()) {
		filePath = join(filePath, indexFile);
	}

	if (!existsSync(filePath) || !statSync(filePath).isFile()) {
		// SPA fallback: serve index.html for unknown paths (except dotfiles/API).
		const fallback = join(distDir, indexFile);
		if (!existsSync(fallback)) {
			res.writeHead(404).end("Not found");
			return true;
		}
		filePath = fallback;
	}

	const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
	const headers: Record<string, string> = { "Content-Type": type };
	if (cacheSeconds > 0) headers["Cache-Control"] = `public, max-age=${cacheSeconds}`;

	res.writeHead(200, headers);
	if (req.method === "HEAD") {
		res.end();
		return true;
	}
	const stream = createReadStream(filePath);
	stream.on("error", () => {
		if (!res.headersSent) res.writeHead(500);
		res.end();
	});
	stream.pipe(res);
	return true;
}
