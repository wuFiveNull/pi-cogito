/**
 * Proactive push outlet — pi extension.
 *
 * Reads the proactive pusher's database (proactive.sqlite, created by the
 * resident proactive-pusher process) and surfaces new items to the user:
 *
 * - session_start: digest notification when new items are waiting
 * - during the session: periodic notification (only while idle)
 * - /digest [source]: manual listing
 * - /proactive on|off: toggle
 *
 * Items are marked pushed once notified so they never repeat.
 *
 * DB path resolution: $PROACTIVE_DB > proactive.json "dbPath" (next to this
 * extension's agent dir) > the default pusher location.
 *
 * Files:
 * - extension: agentDir/extensions/proactive-push.ts
 * - database:  proactive-pusher/proactive.sqlite (owned by the pusher)
 */

import { existsSync } from "node:fs";

import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@cogito/host";

const DEFAULT_DB = "/home/wu/projects/pi-cogito/apps/proactive-pusher/proactive.sqlite";
const PUSH_INTERVAL_MS = 15 * 60 * 1000;

interface ProactiveRow {
	id: number;
	source: string;
	sub_source: string;
	title: string;
	url: string | null;
	summary: string | null;
	status: string;
}

export default function (pi: ExtensionAPI) {
	const dbPath = resolveDbPath();
	const stateKey = "pushEnabled";
	let db: DatabaseSync | undefined;
	let timer: NodeJS.Timeout | undefined;
	let currentCtx: ExtensionContext | undefined;

	function openDb(): DatabaseSync | undefined {
		if (db) return db;
		if (!dbPath || !existsSync(dbPath)) return undefined;
		try {
			db = new DatabaseSync(dbPath);
			db.exec("PRAGMA busy_timeout = 5000");
			return db;
		} catch {
			return undefined;
		}
	}

	function listNew(limit: number): ProactiveRow[] {
		const connection = openDb();
		if (!connection) return [];
		try {
			return connection
				.prepare(
					`SELECT id, source, sub_source, title, url, summary, status FROM items WHERE status = 'new' ORDER BY fetched_at DESC, id DESC LIMIT ?`,
				)
				.all(limit) as unknown as ProactiveRow[];
		} catch {
			return [];
		}
	}

	function markPushed(ids: number[]): void {
		const connection = openDb();
		if (!connection || ids.length === 0) return;
		try {
			const statement = connection.prepare(
				`UPDATE items SET status = 'pushed', pushed_at = ? WHERE id = ? AND status = 'new'`,
			);
			for (const id of ids) statement.run(Date.now(), id);
		} catch {
			// Non-fatal: the item may be re-notified later.
		}
	}

	function isEnabled(): boolean {
		const connection = openDb();
		if (!connection) return false;
		try {
			const row = connection.prepare(`SELECT value FROM state WHERE key = ?`).get(stateKey) as
				| { value?: string }
				| undefined;
			return row?.value !== "off";
		} catch {
			return true;
		}
	}

	function notifyDigest(ctx: ExtensionContext, limit = 3): number {
		const items = listNew(limit + 2);
		if (items.length === 0) return 0;
		const shown = items.slice(0, limit);
		const more = items.length - shown.length;
		const lines = shown.map((item) => `· ${item.title}`).join("\n");
		ctx.ui.notify(`📌 热点速递\n${lines}${more > 0 ? `\n… 还有 ${more} 条, /digest 查看` : ""}`, "info");
		markPushed(items.map((item) => item.id));
		return items.length;
	}

	function scheduleTimer(): void {
		if (timer) return;
		timer = setInterval(() => {
			if (!isEnabled() || !currentCtx) return;
			notifyDigest(currentCtx, 1);
		}, PUSH_INTERVAL_MS);
		timer.unref?.();
	}

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		scheduleTimer();
		if (isEnabled()) {
			notifyDigest(ctx);
		}
	});

	pi.on("session_shutdown", () => {
		currentCtx = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	});

	pi.registerCommand("digest", {
		description: "查看主动推送的热点(/digest [source])",
		handler: async (args, ctx) => {
			const sourceFilter = args.trim() || undefined;
			const items = listNew(20).filter(
				(item) => !sourceFilter || item.source === sourceFilter || item.sub_source === sourceFilter,
			);
			if (items.length === 0) {
				ctx.ui.notify("没有新的热点。", "info");
				return;
			}
			const lines = items.slice(0, 10).map((item) => `[${item.sub_source}] ${item.title}`);
			ctx.ui.notify(
				`📌 ${items.length} 条热点:\n${lines.join("\n")}${items.length > 10 ? `\n… 还有 ${items.length - 10} 条` : ""}`,
				"info",
			);
			markPushed(items.map((item) => item.id));
		},
	});

	pi.registerCommand("proactive", {
		description: "主动推送开关:/proactive on|off",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const action = args.trim();
			const connection = openDb();
			if (!connection) {
				ctx.ui.notify("proactive 数据库不可用(推送器未运行?)", "warning");
				return;
			}
			if (action === "on" || action === "off") {
				connection
					.prepare(
						`INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
					)
					.run(stateKey, action);
				ctx.ui.notify(`主动推送已${action === "on" ? "开启" : "关闭"}`, "info");
			} else {
				ctx.ui.notify(`当前状态:${isEnabled() ? "开启" : "关闭"}。用法:/proactive on|off`, "info");
			}
		},
	});
}

function resolveDbPath(): string | undefined {
	if (process.env.PROACTIVE_DB) return process.env.PROACTIVE_DB;
	// Default to the standard pusher location when it exists.
	return existsSync(DEFAULT_DB) ? DEFAULT_DB : undefined;
}
