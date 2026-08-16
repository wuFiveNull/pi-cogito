/**
 * 跨进程 staged 投递(共享层)。
 *
 * drift daemon 把待投递消息写成 runs.message_result='staged';
 * proactive 启动时恢复这些投递(经自己的 delivery outlet 发出)。
 * 本模块提供双方共用的 staged 读取与投递状态回写,以及投递类型契约。
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DriftOutboundAttachment } from "./outbound.ts";

export interface DriftStagedDelivery {
	runId: string;
	sessionKey: string;
	skillName: string;
	message: string;
	messageHash: string;
	media: string[];
	attachments: DriftOutboundAttachment[];
	targetChannel: string;
	targetChatId: string;
	deliveredAt: number;
}

export interface DriftDeliveryRecord {
	session_key: string;
	message: string;
	message_hash: string;
	media?: readonly string[];
	attachments?: readonly DriftOutboundAttachment[];
	target_channel?: string;
	target_chat_id?: string;
	source_refs: string;
	evidence: string;
	action: string;
	state_summary_tag: string;
	delivered_at: number;
	/** Stable logical key reused when a staged Drift delivery is recovered. */
	idempotency_key?: string;
}

export type DriftDeliveryStatus = "success" | "partial" | "failed";

export interface DriftDeliveryReceipt {
	deliveryId: number;
	status: DriftDeliveryStatus;
	providerMessageId?: string;
	canonicalMedia?: readonly string[];
	detail?: string;
}

/** 投递口:finish_drift 后由 pipeline 把暂存消息写入宿主侧(proactive 的 deliveries 表)。 */
export interface DriftDeliverySink {
	insertDelivery(record: DriftDeliveryRecord): number | Promise<number>;
	/** 可选:统一写入、发送、确认，并返回可观测的投递结果。 */
	sendDelivery?(record: DriftDeliveryRecord): Promise<DriftDeliveryReceipt>;
	/** 可选:投递前查重(如 24h hash 窗口 + 最近 N 条);重复时 message_push 拒绝。 */
	dedupeCheck?(
		message: string,
		media?: readonly string[],
		targetChannel?: string,
		targetChatId?: string,
		attachments?: readonly DriftOutboundAttachment[],
	): { duplicate: boolean; reason?: string };
}

function clip(text: string, limit: number): string {
	return (text ?? "").trim().slice(0, limit);
}

function timestampMs(raw: unknown): number {
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	const parsed = Date.parse(String(raw ?? ""));
	return Number.isFinite(parsed) ? parsed : 0;
}

function decodeStringArray(raw: unknown): string[] {
	let value: unknown = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw) as unknown;
		} catch {
			return [];
		}
	}
	return Array.isArray(value)
		? value
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim())
				.filter(Boolean)
		: [];
}

function decodeAttachments(raw: unknown): DriftOutboundAttachment[] {
	let value: unknown = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw) as unknown;
		} catch {
			return [];
		}
	}
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
		const row = item as Record<string, unknown>;
		const kind = row.kind;
		const source = typeof row.source === "string" ? row.source.trim() : "";
		if ((kind !== "file" && kind !== "image") || !source) return [];
		const attachment: DriftOutboundAttachment = { kind, source };
		if (typeof row.filename === "string" && row.filename.trim()) attachment.filename = row.filename.trim();
		if (typeof row.mimeType === "string" && row.mimeType.trim()) attachment.mimeType = row.mimeType.trim();
		return [attachment];
	});
}

/** Options for {@link DriftStagedDeliveryStore}. */
export interface DriftStagedDeliveryStoreOptions {
	/** Directory containing drift.db (used when dbFile is not given). */
	driftDir?: string;
	/** The exact database file path. */
	dbFile?: string;
}

/**
 * Shared staged-delivery store: reads staged runs from drift.db and writes
 * delivery status back. drift daemon stages; proactive recovers and delivers.
 */
export class DriftStagedDeliveryStore {
	readonly dbFile: string;
	private db: DatabaseSync | null = null;

	constructor(options: DriftStagedDeliveryStoreOptions) {
		this.dbFile = options.dbFile ?? join(options.driftDir ?? ".", "drift.db");
		mkdirSync(dirname(this.dbFile), { recursive: true });
		this.ensureDb();
	}

	close(): void {
		this.db?.close();
		this.db = null;
	}

	private conn(): DatabaseSync {
		this.db ??= new DatabaseSync(this.dbFile);
		return this.db;
	}

	/**
	 * 确保 runs 表存在(runs 由 drift 的 DriftStateStore 管理;proactive
	 * 在 drift 尚未初始化时读取 staged 也要能工作,因此这里幂等建表)。
	 */
	private ensureDb(): void {
		this.conn().exec(`
CREATE TABLE IF NOT EXISTS runs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT,
	session_key TEXT NOT NULL DEFAULT 'local',
	run_at TEXT NOT NULL,
	started_at TEXT,
	finished_at TEXT,
	skill_name TEXT NOT NULL,
	status TEXT NOT NULL,
	briefing TEXT NOT NULL,
	message_result TEXT NOT NULL,
	message_hash TEXT,
	message TEXT NOT NULL DEFAULT '',
	media_json TEXT NOT NULL DEFAULT '[]',
	attachments_json TEXT NOT NULL DEFAULT '[]',
	target_channel TEXT NOT NULL DEFAULT '',
	target_chat_id TEXT NOT NULL DEFAULT '',
	delivery_id INTEGER,
	delivery_status TEXT,
	delivery_error TEXT
);
`);
	}

	/** Staged messages that survived a crash before the host delivery commit. */
	listStagedDeliveries(limit = 20): DriftStagedDelivery[] {
		const rows = this.conn()
			.prepare(
				`SELECT run_id, session_key, skill_name, message, message_hash, media_json,
					attachments_json, target_channel, target_chat_id, run_at AS delivered_at
				 FROM runs WHERE message_result = 'staged' AND message_hash IS NOT NULL
				 ORDER BY id ASC LIMIT ?`,
			)
			.all(Math.max(1, Math.trunc(limit))) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			runId: String(row.run_id ?? ""),
			sessionKey: String(row.session_key ?? "local"),
			skillName: String(row.skill_name ?? "unknown"),
			message: String(row.message ?? ""),
			messageHash: String(row.message_hash ?? ""),
			media: decodeStringArray(row.media_json),
			attachments: decodeAttachments(row.attachments_json),
			targetChannel: String(row.target_channel ?? ""),
			targetChatId: String(row.target_chat_id ?? ""),
			deliveredAt: timestampMs(row.delivered_at),
		}));
	}

	/** 投递后回写 runs 行(run_id 匹配时)。 */
	markRunDelivery(runId: string, deliveryId: number, status: string, error?: string): void {
		const key = String(runId ?? "").trim();
		if (!key) return;
		this.conn()
			.prepare(
				`UPDATE runs SET delivery_id = ?, delivery_status = ?, delivery_error = ?,
					message_result = CASE WHEN ? = 'success' THEN 'sent' ELSE message_result END
				 WHERE run_id = ?`,
			)
			.run(deliveryId, clip(status, 40), error ? clip(error, 2000) : null, status, key);
	}

	/**
	 * 投递确认回写(akashic record_commit_result):outlet 确认消息已展示后,
	 * 把对应 run 的 message_result 从 staged 更新为 sent。按 message_hash 匹配,
	 * 与投递时刻解耦,天然幂等。
	 */
	markRunMessageSent(messageHash: string): void {
		const hash = String(messageHash ?? "").trim();
		if (!hash) return;
		this.conn()
			.prepare(
				"UPDATE runs SET message_result = 'sent', delivery_status = 'success', delivery_error = NULL WHERE message_hash = ? AND message_result = 'staged'",
			)
			.run(hash);
	}
}
