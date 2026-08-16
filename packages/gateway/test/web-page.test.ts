import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { builtinWebApp, createWebApi, UiRegistry } from "@cogito/ui";
import { afterEach, describe, expect, it } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { WebChannel } from "../src/channels/web.ts";

let channel: WebChannel | undefined;

afterEach(async () => {
	await channel?.stop();
	channel = undefined;
});

describe("web page via pi-ui", () => {
	it("serves the full web app: page + chat api + dashboard api", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-full-"));
		try {
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			writeFileSync(join(dir, "proactive.sqlite"), "");
			const db = new DatabaseSync(join(dir, "proactive.sqlite"));
			db.exec(`CREATE TABLE tick_log (id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT, started_at INTEGER, finished_at INTEGER, base_score REAL, candidates INTEGER, steps INTEGER, action TEXT, skip_reason TEXT, error TEXT);
				CREATE TABLE deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT, message TEXT, message_hash TEXT, source_refs TEXT, evidence TEXT, action TEXT, state_summary_tag TEXT, delivered_at INTEGER, acked INTEGER);
				CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, recommendation TEXT, source TEXT, sub_source TEXT, title TEXT, url TEXT, summary TEXT, title_hash TEXT UNIQUE, interest_score REAL, verdict TEXT, verdict_reason TEXT, status TEXT, fetched_at INTEGER, pushed_at INTEGER, evidence TEXT);
				CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT);
				INSERT INTO tick_log (session_key, started_at, finished_at, base_score, candidates, steps, action) VALUES ('local', 1, 2, 0.5, 3, 1, 'send');`);
			db.close();
			const memoryDb = join(dir, "memory.sqlite");
			const mdb = new DatabaseSync(memoryDb);
			mdb.exec(
				`CREATE TABLE memory_items (id TEXT PRIMARY KEY, memory_type TEXT, summary TEXT, content_hash TEXT, embedding TEXT, reinforcement INTEGER, emotional_weight INTEGER, extra_json TEXT, source_ref TEXT, happened_at TEXT, status TEXT, scope_channel TEXT, scope_chat_id TEXT, created_at TEXT, updated_at TEXT);`,
			);
			mdb.close();

			const bus = new MessageBus();
			channel = new WebChannel({}, bus);
			const ui = new UiRegistry();
			ui.register(builtinWebApp);
			const webApi = createWebApi({
				sessionsDir,
				proactiveDbPath: join(dir, "proactive.sqlite"),
				memoryDbPath: memoryDb,
				settingsPath: join(dir, "web-settings.json"),
			});
			channel.registerApi("GET", "/*", (url, res, req) => {
				if (webApi.handle(req, res, url)) return;
				if (!ui.handle(req, res, url)) res.writeHead(404).end("Not found");
			});
			channel.registerApi("POST", "/api/settings/save", (url, res, req) => {
				if (!webApi.handle(req, res, url)) res.writeHead(404).end("Not found");
			});
			await channel.start();
			const base = `http://127.0.0.1:${channel.port}`;

			const page = await fetch(`${base}/`);
			expect(page.status).toBe(200);
			expect(await page.text()).toContain("pi web");

			const sessions = await fetch(`${base}/api/chat/sessions`);
			expect(sessions.status).toBe(200);
			expect((await sessions.json()) as { items: unknown[] }).toEqual({ items: [] });

			const ticks = await fetch(`${base}/api/dashboard/proactive/tick_logs`);
			const tickBody = (await ticks.json()) as { items: Array<{ action: string }> };
			expect(tickBody.items[0].action).toBe("send");

			const save = await fetch(`${base}/api/settings/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ agentTick: { model: "m" } }),
			});
			expect(save.status).toBe(200);
			const state = await fetch(`${base}/api/settings/state`);
			expect(((await state.json()) as { agentTick: { model: string } }).agentTick.model).toBe("m");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("mounts the builtin web page on the WebChannel and serves it", async () => {
		const bus = new MessageBus();
		channel = new WebChannel({}, bus);
		const ui = new UiRegistry();
		ui.register(builtinWebApp);
		channel.registerApi("GET", "/*", (url, res, req) => {
			if (!ui.handle(req, res, url)) {
				res.writeHead(404).end("Not found");
			}
		});
		await channel.start();
		const base = `http://127.0.0.1:${channel.port}`;
		const page = await fetch(`${base}/`);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toContain("text/html");
		expect(await page.text()).toContain("pi web");

		const css = await fetch(`${base}/styles.css`);
		expect(css.status).toBe(200);
		expect(await css.text()).toContain("app-shell");

		const health = await fetch(`${base}/api/health`);
		expect(await health.json()).toEqual({ ok: true });
	});

	it("supports prefix routes via trailing * (UiRegistry under /ui/*)", async () => {
		const bus = new MessageBus();
		channel = new WebChannel({}, bus);
		const ui = new UiRegistry();
		ui.register({ id: "admin", name: "admin", basePath: "/ui/admin", distDir: builtinWebApp.distDir });
		channel.registerApi("GET", "/ui/*", (url, res, req) => {
			if (!ui.handle(req, res, url)) {
				res.writeHead(404).end("Not found");
			}
		});
		await channel.start();
		const base = `http://127.0.0.1:${channel.port}`;

		const res = await fetch(`${base}/ui/admin/`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("pi web");
	});
});
