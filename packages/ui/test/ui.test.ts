import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UiRegistry } from "../src/index.ts";

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDist(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "ui-test-"));
	tempDirs.push(dir);
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(join(dir, name.split("/").slice(0, -1).join("/")), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

async function startUiServer(ui: UiRegistry): Promise<string> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		if (!ui.handle(req, res, url)) {
			res.writeHead(404).end("Not found");
		}
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("no address");
	return `http://127.0.0.1:${address.port}`;
}

describe("UiRegistry", () => {
	it("routes to the longest-prefix app and serves static assets", async () => {
		const dist = makeDist({
			"index.html": "<h1>admin</h1>",
			"app.js": "console.log('admin')",
		});
		const ui = new UiRegistry();
		ui.register({ id: "admin", name: "管理面板", basePath: "/admin", distDir: dist });
		const base = await startUiServer(ui);

		const js = await fetch(`${base}/admin/app.js`);
		expect(js.status).toBe(200);
		expect(await js.text()).toContain("console.log");

		const html = await fetch(`${base}/admin/`);
		expect(html.status).toBe(200);
		expect(await html.text()).toContain("<h1>admin</h1>");
	});

	it("SPA fallback serves index.html for unknown paths", async () => {
		const dist = makeDist({ "index.html": "<h1>spa</h1>" });
		const ui = new UiRegistry();
		ui.register({ id: "admin", name: "x", basePath: "/admin", distDir: dist });
		const base = await startUiServer(ui);

		const res = await fetch(`${base}/admin/some/route`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("spa");
	});

	it("blocks path traversal", async () => {
		const dist = makeDist({ "index.html": "ok" });
		const ui = new UiRegistry();
		ui.register({ id: "admin", name: "x", basePath: "/admin", distDir: dist });
		const base = await startUiServer(ui);

		const res = await fetch(`${base}/admin/..%2F..%2Fetc%2Fpasswd`);
		expect(res.status).toBe(403);
	});

	it("dispatches per-app API routes", async () => {
		const dist = makeDist({ "index.html": "ok" });
		const ui = new UiRegistry();
		ui.register({
			id: "admin",
			name: "x",
			basePath: "/admin",
			distDir: dist,
			apiRoutes: [
				{
					method: "GET",
					path: "/sessions",
					handler: (_req, res) => {
						res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
					},
				},
			],
		});
		const base = await startUiServer(ui);

		const res = await fetch(`${base}/admin/api/sessions`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("root basePath app matches all paths", async () => {
		const dist = makeDist({ "index.html": "<h1>root</h1>", "app.js": "x" });
		const ui = new UiRegistry();
		ui.register({ id: "web", name: "web", basePath: "/", distDir: dist });
		const base = await startUiServer(ui);

		const root = await fetch(`${base}/`);
		expect(root.status).toBe(200);
		expect(await root.text()).toContain("root");

		const asset = await fetch(`${base}/app.js`);
		expect(asset.status).toBe(200);

		// 更长的前缀 app 优先于根路径 app。
		const adminDist = makeDist({ "index.html": "<h1>admin</h1>" });
		ui.register({ id: "admin", name: "admin", basePath: "/admin", distDir: adminDist });
		const admin = await fetch(`${base}/admin/`);
		expect(await admin.text()).toContain("admin");
	});

	it("404 when no app matches", async () => {
		const ui = new UiRegistry();
		const base = await startUiServer(ui);
		const res = await fetch(`${base}/nothing`);
		expect(res.status).toBe(404);
	});
});
