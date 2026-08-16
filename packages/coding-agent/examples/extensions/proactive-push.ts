/**
 * Proactive push outlet — pi extension (akashic delivery port).
 *
 * Reads the proactive pusher's database (proactive.sqlite, owned by the
 * resident proactive-pusher process) and surfaces **deliveries** to the
 * user: the Evidence-First messages written by the pusher's resolve stage,
 * with their source references. Raw candidate digests remain available via
 * /digest.
 *
 * - session_start: show pending deliveries
 * - during the session: periodic check (only while idle)
 * - /digest [source]: raw candidate listing (not the written message)
 * - /proactive on|off: toggle
 *
 * Deliveries are acked once shown so they never repeat.
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
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_DB = "/home/wu/projects/pi-cogito/proactive-pusher/proactive.sqlite";
const PUSH_INTERVAL_MS = 15 * 60 * 1000;

interface DeliveryRow {
	id: number;
	message: string;
	source_refs: string;
	evidence: string;
	action: string;
	state_summary_tag: string;
	delivered_at: number;
}

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

	function listPendingDeliveries(limit: number): DeliveryRow[] {
		const connection = openDb();
		if (!connection) return [];
		try {
			return connection
				.prepare(
					`SELECT id, message, source_refs, evidence, action, state_summary_tag, delivered_at
					 FROM deliveries WHERE acked = 0 ORDER BY delivered_at ASC LIMIT ?`,
				)
				.all(limit) as unknown as DeliveryRow[];
		} catch {
			return [];
		}
	}

	function ackDeliveries(ids: number[]): void {
		const connection = openDb();
		if (!connection || ids.length === 0) return;
		try {
			const statement = connection.prepare(`UPDATE deliveries SET acked = 1 WHERE id = ?`);
			for (const id of ids) statement.run(id);
		} catch {
			// Non-fatal: the delivery may be re-shown later.
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

	/** Show pending delivery messages (with source refs) and ack them. */
	function notifyDeliveries(ctx: ExtensionContext, limit = 3): number {
		const deliveries = listPendingDeliveries(limit);
		if (deliveries.length === 0) return 0;
		const blocks = deliveries.map((delivery) => {
			const refs = parseRefs(delivery.source_refs);
			const sources = refs.map((ref) => (ref.url ? `${ref.title} (${ref.url})` : ref.title)).join("；");
			const tag =
				delivery.state_summary_tag && delivery.state_summary_tag !== "none"
					? `\n[状态:${delivery.state_summary_tag}]`
					: "";
			return `${delivery.message}${sources ? `\n\n来源:${sources}` : ""}${tag}`;
		});
		ctx.ui.notify(`🔔 主动推送\n\n${blocks.join("\n\n---\n\n")}`, "info");
		ackDeliveries(deliveries.map((delivery) => delivery.id));
		return deliveries.length;
	}

	function scheduleTimer(): void {
		if (timer) return;
		timer = setInterval(() => {
			if (!isEnabled() || !currentCtx) return;
			notifyDeliveries(currentCtx, 1);
		}, PUSH_INTERVAL_MS);
		timer.unref?.();
	}

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		scheduleTimer();
		if (isEnabled()) {
			notifyDeliveries(ctx);
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
		description: "查看主动推送的候选热点(/digest [source])",
		handler: async (args, ctx) => {
			const sourceFilter = args.trim() || undefined;
			const items = listNew(20).filter(
				(item) => !sourceFilter || item.source === sourceFilter || item.sub_source === sourceFilter,
			);
			if (items.length === 0) {
				ctx.ui.notify("没有新的候选热点。", "info");
				return;
			}
			const lines = items.slice(0, 10).map((item) => `[${item.sub_source}] ${item.title}`);
			ctx.ui.notify(
				`📌 ${items.length} 条候选:\n${lines.join("\n")}${items.length > 10 ? `\n… 还有 ${items.length - 10} 条` : ""}`,
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

interface SourceRef {
	id?: string | number;
	source?: string;
	title?: string;
	url?: string;
}

function parseRefs(raw: string): SourceRef[] {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? (parsed as SourceRef[]) : [];
	} catch {
		return [];
	}
}

function resolveDbPath(): string | undefined {
	if (process.env.PROACTIVE_DB) return process.env.PROACTIVE_DB;
	// Default to the standard pusher location when it exists.
	return existsSync(DEFAULT_DB) ? DEFAULT_DB : undefined;
}
