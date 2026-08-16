/**
 * Proactive store — proactive.sqlite access (akashic proactive_v2 state.py design).
 *
 * The pusher owns this database (independent from extensions.sqlite): items
 * (candidate + push state), deliveries (sent messages + dedup), tick logs,
 * daily counts and presence. Consumers (pi extension, IM outlet, web
 * dashboard) open it read-only.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Clock, SystemClock } from "./clock.ts";

export type ProactiveItemKind = "alert" | "content" | "context";

export interface ProactiveItem {
	id: number;
	scope: string;
	recommendation: string | null;
	verdict: "interesting" | "not_interesting" | null;
	verdict_reason: string | null;
	/** Event channel (akashic channels): alert 高优先级,content 常规,context 兜底。 */
	kind: ProactiveItemKind;
	source: string;
	sub_source: string;
	/** Upstream event identity used for source acknowledgement. */
	source_event_id?: string | null;
	/** Source id that owns the acknowledgement endpoint. */
	ack_source_id?: string | null;
	title: string;
	url: string | null;
	summary: string | null;
	title_hash: string;
	interest_score: number | null;
	status: "new" | "pushed" | "dismissed";
	fetched_at: number;
	pushed_at: number | null;
	/** Evidence snippet fetched during the agent tick (used for message writing). */
	evidence: string | null;
}

export interface DeliveryRecord {
	id: number;
	session_key: string;
	message: string;
	message_hash: string;
	/** Media references (usually local image paths or URLs), decoded from JSON. */
	media: string[];
	/** Typed outbound attachments, decoded from JSON. */
	attachments: DeliveryAttachment[];
	/** Optional outbound channel route; empty means the outlet's default channel. */
	target_channel: string;
	/** Optional outbound chat route; empty means the outlet's configured targets. */
	target_chat_id: string;
	/** JSON array of {id, source, title, url} references. */
	source_refs: string;
	/** JSON array of evidence snippets. */
	evidence: string;
	/** Action that produced this delivery: send | context_only. */
	action: string;
	state_summary_tag: string;
	delivered_at: number;
	acked: number;
	delivery_status: DeliveryState;
	delivery_error: string | null;
	/** Stable logical key reused by every retry of this delivery. */
	idempotency_key: string;
	/** Provider-assigned message id when the channel returns one. */
	provider_message_id: string | null;
	/** Per-target delivery receipts, decoded from JSON. */
	target_receipts: DeliveryTargetReceipt[];
}

export type DeliveryState = "pending" | "success" | "partial" | "failed" | "cancelled";

export type DeliveryAttachmentKind = "file" | "image" | "audio" | "video";

export interface DeliveryAttachment {
	kind: DeliveryAttachmentKind;
	source: string;
	filename?: string;
	mimeType?: string;
	sizeBytes?: number;
	metadata?: Record<string, unknown>;
}

export interface DeliveryTargetReceipt {
	target: string;
	status: DeliveryState;
	attempts: number;
	messageId?: string;
	providerMessageId?: string;
	detail?: string;
	updatedAt: number;
}

export interface DeliveryReceiptUpdate {
	providerMessageId?: string;
	targetReceipts?: readonly DeliveryTargetReceipt[];
	detail?: string;
}

export type DeliveryInput = Omit<
	DeliveryRecord,
	| "id"
	| "acked"
	| "delivery_status"
	| "delivery_error"
	| "media"
	| "attachments"
	| "target_channel"
	| "target_chat_id"
	| "idempotency_key"
	| "provider_message_id"
	| "target_receipts"
> & {
	media?: readonly string[];
	attachments?: readonly DeliveryAttachment[];
	target_channel?: string;
	target_chat_id?: string;
	idempotency_key?: string;
};

export type DeliveryListener = (record: DeliveryRecord) => void;
export type DeliveryAcknowledgedListener = (record: DeliveryRecord, acknowledgedAt: number) => void;

export interface TickLogRecord {
	id: number;
	session_key: string;
	started_at: number;
	finished_at: number | null;
	base_score: number | null;
	candidates: number;
	steps: number;
	action: string;
	skip_reason: string;
	error: string | null;
	/** 判题分类结果(akashic tick_log interesting_ids 等)。 */
	interesting_ids?: string;
	discarded_ids?: string;
	cited_ids?: string;
	/** 1 = 本轮进入 drift 空闲分支。 */
	drift_entered?: number;
	/** 终局消息文本(send 时)。 */
	final_message?: string;
	/** LLM 调用次数(akashic llm_call_count)。 */
	llm_call_count?: number;
	/** 插件贡献的 effect 审计记录 JSON 数组(akashic proactive_effects)。 */
	effects_json?: string;
	/** 稳定 tick 标识(akashic tick_id UUID);旧行留空。 */
	tick_id?: string;
	/** gate 退出原因(akashic gate_exit):open / busy / cooldown / anyaction / ... */
	gate_exit?: string;
	/** 本轮候选按 kind 计数(akashic alert_count/content_count/context_count)。 */
	alert_count?: number;
	content_count?: number;
	context_count?: number;
	/** judge LLM cache token 统计(akashic record_llm_cache)。 */
	llm_cache_read_tokens?: number;
	llm_cache_write_tokens?: number;
}

export interface PresenceRow {
	session_key: string;
	last_user_at: number | null;
	last_proactive_at: number | null;
}

export interface TickStepRecord {
	id: number;
	tick_id: number;
	step_index: number;
	phase: string;
	detail: string;
	action_after: string;
	skip_reason_after: string;
	duration_ms: number;
	/** 工具级审计(akashic tick_step_log 形状);非工具步骤留空。 */
	tool_name?: string;
	tool_call_id?: string;
	tool_args_json?: string;
	tool_result_text?: string;
	interesting_ids_after?: string;
	discarded_ids_after?: string;
	cited_ids_after?: string;
	final_message_after?: string;
}

export interface SourceQuarantineRecord {
	identity: string;
	source_id: string;
	item_id: string;
	reason: string;
	payload_json: string;
	first_seen_at: number;
	last_seen_at: number;
	occurrences: number;
}

export interface SourceFailureRecord {
	id: number;
	source_id: string;
	checked_at: number;
	error: string;
	diagnostics_json: string;
}

export interface PendingSourceAcknowledgement {
	source_id: string;
	event_id: string;
	queued_at: number;
	attempts: number;
	last_error: string | null;
	last_attempt_at: number | null;
	next_attempt_at: number | null;
}

export interface ProactiveRetentionOptions {
	maxItemAgeDays?: number;
	maxDeliveryAgeDays?: number;
	maxDeliveries?: number;
	maxTickLogAgeDays?: number;
	maxTickLogs?: number;
	maxSourceFailureAgeDays?: number;
	maxSourceFailures?: number;
	maxQuarantineAgeDays?: number;
	maxContextOnlyAgeDays?: number;
	maxDailyCountAgeDays?: number;
	now?: number;
}

export interface ProactiveRetentionResult {
	itemsDeleted: number;
	deliveriesDeleted: number;
	tickLogsDeleted: number;
	tickStepsDeleted: number;
	sourceFailuresDeleted: number;
	quarantineDeleted: number;
	contextOnlyDeleted: number;
	dailyCountsDeleted: number;
}

const SOURCE_QUARANTINE_PAYLOAD_BYTES = 4096;
const SOURCE_QUARANTINE_GLOBAL_CAP = 1000;
const SOURCE_QUARANTINE_PER_SOURCE_CAP = 100;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT '',
  recommendation TEXT,
  source TEXT NOT NULL,
  sub_source TEXT NOT NULL,
  source_event_id TEXT,
  ack_source_id TEXT,
  title TEXT NOT NULL,
  url TEXT,
  summary TEXT,
  title_hash TEXT NOT NULL UNIQUE,
  interest_score REAL,
  verdict TEXT,
  verdict_reason TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  kind TEXT NOT NULL DEFAULT 'content',
  fetched_at INTEGER NOT NULL,
  pushed_at INTEGER,
  evidence TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items (status, fetched_at);
CREATE INDEX IF NOT EXISTS idx_items_source ON items (source);

CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS source_quarantine (
  identity TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_source_quarantine_time ON source_quarantine (source_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS source_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  error TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_source_failures_source_time ON source_failures (source_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS source_ack_queue (
  source_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at INTEGER,
	 next_attempt_at INTEGER,
  PRIMARY KEY (source_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_source_ack_queue_time ON source_ack_queue (queued_at, source_id);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL DEFAULT 'local',
  message TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  media TEXT NOT NULL DEFAULT '[]',
  attachments TEXT NOT NULL DEFAULT '[]',
  target_channel TEXT NOT NULL DEFAULT '',
  target_chat_id TEXT NOT NULL DEFAULT '',
  source_refs TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '[]',
  action TEXT NOT NULL DEFAULT 'send',
  state_summary_tag TEXT NOT NULL DEFAULT 'none',
  delivered_at INTEGER NOT NULL,
  acked INTEGER NOT NULL DEFAULT 0,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  delivery_error TEXT,
  idempotency_key TEXT NOT NULL DEFAULT '',
  provider_message_id TEXT,
  target_receipts TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_deliveries_at ON deliveries (delivered_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_session ON deliveries (session_key, delivered_at);

CREATE TABLE IF NOT EXISTS tick_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL DEFAULT 'local',
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  base_score REAL,
  candidates INTEGER NOT NULL DEFAULT 0,
  steps INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL DEFAULT 'none',
  skip_reason TEXT NOT NULL DEFAULT '',
  error TEXT,
  interesting_ids TEXT NOT NULL DEFAULT '[]',
  discarded_ids TEXT NOT NULL DEFAULT '[]',
  cited_ids TEXT NOT NULL DEFAULT '[]',
  drift_entered INTEGER NOT NULL DEFAULT 0,
  final_message TEXT NOT NULL DEFAULT '',
  llm_call_count INTEGER NOT NULL DEFAULT 0,
  tick_id TEXT,
  gate_exit TEXT NOT NULL DEFAULT '',
  alert_count INTEGER NOT NULL DEFAULT 0,
  content_count INTEGER NOT NULL DEFAULT 0,
  context_count INTEGER NOT NULL DEFAULT 0,
  llm_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  llm_cache_write_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tick_log_at ON tick_log (started_at);

CREATE TABLE IF NOT EXISTS tick_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick_id INTEGER NOT NULL,
  step_index INTEGER NOT NULL,
  phase TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  action_after TEXT NOT NULL DEFAULT '',
  skip_reason_after TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  tool_name TEXT NOT NULL DEFAULT '',
  tool_call_id TEXT NOT NULL DEFAULT '',
  tool_args_json TEXT NOT NULL DEFAULT '',
  tool_result_text TEXT NOT NULL DEFAULT '',
  interesting_ids_after TEXT NOT NULL DEFAULT '',
  discarded_ids_after TEXT NOT NULL DEFAULT '',
  cited_ids_after TEXT NOT NULL DEFAULT '',
  final_message_after TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tick_steps_tick ON tick_steps (tick_id, step_index);

CREATE TABLE IF NOT EXISTS daily_counts (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);

CREATE TABLE IF NOT EXISTS context_only_timestamps (
  session_key TEXT NOT NULL DEFAULT 'local',
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_only_ts ON context_only_timestamps (session_key, ts);

CREATE TABLE IF NOT EXISTS presence (
  session_key TEXT PRIMARY KEY,
  last_user_at INTEGER,
  last_proactive_at INTEGER
);
`;

function normalizeDeliveryMedia(media: readonly string[] | undefined): string[] {
	if (!media) return [];
	return media.map((item) => String(item).trim()).filter((item) => item.length > 0);
}

const DELIVERY_ATTACHMENT_KINDS = new Set<DeliveryAttachmentKind>(["file", "image", "audio", "video"]);
const DELIVERY_STATES = new Set<DeliveryState>(["pending", "success", "partial", "failed", "cancelled"]);

function normalizeDeliveryAttachments(attachments: readonly DeliveryAttachment[] | undefined): DeliveryAttachment[] {
	if (!attachments) return [];
	return attachments.flatMap((attachment) => {
		const source = String(attachment.source ?? "").trim();
		if (!source || !DELIVERY_ATTACHMENT_KINDS.has(attachment.kind)) return [];
		const normalized: DeliveryAttachment = { kind: attachment.kind, source };
		const filename = attachment.filename?.trim();
		const mimeType = attachment.mimeType?.trim();
		if (filename) normalized.filename = filename;
		if (mimeType) normalized.mimeType = mimeType;
		if (attachment.sizeBytes !== undefined && Number.isFinite(attachment.sizeBytes) && attachment.sizeBytes >= 0) {
			normalized.sizeBytes = Math.floor(attachment.sizeBytes);
		}
		if (attachment.metadata) normalized.metadata = attachment.metadata;
		return [normalized];
	});
}

function normalizeDeliveryRoute(value: string | undefined): string {
	return value?.trim() ?? "";
}

function decodeDeliveryMedia(value: unknown): string[] {
	if (Array.isArray(value))
		return normalizeDeliveryMedia(value.filter((item): item is string => typeof item === "string"));
	if (typeof value !== "string" || value.trim().length === 0) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? normalizeDeliveryMedia(parsed.filter((item): item is string => typeof item === "string"))
			: [];
	} catch {
		return [];
	}
}

function decodeDeliveryAttachments(value: unknown): DeliveryAttachment[] {
	let parsed: unknown = value;
	if (typeof value === "string") {
		if (!value.trim()) return [];
		try {
			parsed = JSON.parse(value) as unknown;
		} catch {
			return [];
		}
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.flatMap((item) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
		const row = item as Record<string, unknown>;
		const kind = row.kind;
		const source = typeof row.source === "string" ? row.source.trim() : "";
		if (typeof kind !== "string" || !DELIVERY_ATTACHMENT_KINDS.has(kind as DeliveryAttachmentKind) || !source)
			return [];
		const attachment: DeliveryAttachment = {
			kind: kind as DeliveryAttachmentKind,
			source,
		};
		if (typeof row.filename === "string" && row.filename.trim()) attachment.filename = row.filename.trim();
		if (typeof row.mimeType === "string" && row.mimeType.trim()) attachment.mimeType = row.mimeType.trim();
		if (typeof row.sizeBytes === "number" && Number.isFinite(row.sizeBytes) && row.sizeBytes >= 0) {
			attachment.sizeBytes = Math.floor(row.sizeBytes);
		}
		if (typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)) {
			attachment.metadata = row.metadata as Record<string, unknown>;
		}
		return [attachment];
	});
}

function decodeDeliveryState(value: unknown): DeliveryState {
	return typeof value === "string" && DELIVERY_STATES.has(value as DeliveryState)
		? (value as DeliveryState)
		: "pending";
}

function decodeDeliveryTargetReceipts(value: unknown): DeliveryTargetReceipt[] {
	let parsed: unknown = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value) as unknown;
		} catch {
			return [];
		}
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.flatMap((item) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
		const row = item as Record<string, unknown>;
		const target = typeof row.target === "string" ? row.target.trim() : "";
		const status = decodeDeliveryState(row.status);
		if (!target || status === "pending") return [];
		const attempts =
			typeof row.attempts === "number" && Number.isFinite(row.attempts) ? Math.max(1, Math.floor(row.attempts)) : 1;
		const updatedAt = typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : 0;
		const receipt: DeliveryTargetReceipt = { target, status, attempts, updatedAt };
		if (typeof row.messageId === "string" && row.messageId.trim()) receipt.messageId = row.messageId.trim();
		if (typeof row.providerMessageId === "string" && row.providerMessageId.trim()) {
			receipt.providerMessageId = row.providerMessageId.trim();
		}
		if (typeof row.detail === "string" && row.detail.trim()) receipt.detail = row.detail.slice(0, 2000);
		return [receipt];
	});
}

function decodeItemRow(row: Record<string, unknown>): ProactiveItem {
	const kindRaw = String(row.kind ?? "content").trim();
	const kind: ProactiveItemKind = kindRaw === "alert" || kindRaw === "context" ? kindRaw : "content";
	return {
		id: Number(row.id),
		scope: String(row.scope ?? ""),
		recommendation: typeof row.recommendation === "string" ? row.recommendation : null,
		verdict: row.verdict === "interesting" || row.verdict === "not_interesting" ? row.verdict : null,
		verdict_reason: typeof row.verdict_reason === "string" ? row.verdict_reason : null,
		kind,
		source: String(row.source ?? ""),
		sub_source: String(row.sub_source ?? ""),
		source_event_id: typeof row.source_event_id === "string" ? row.source_event_id : null,
		ack_source_id: typeof row.ack_source_id === "string" ? row.ack_source_id : null,
		title: String(row.title ?? ""),
		url: typeof row.url === "string" ? row.url : null,
		summary: typeof row.summary === "string" ? row.summary : null,
		title_hash: String(row.title_hash ?? ""),
		interest_score: typeof row.interest_score === "number" ? row.interest_score : null,
		status: row.status === "pushed" || row.status === "dismissed" ? row.status : "new",
		fetched_at: Number(row.fetched_at),
		pushed_at: typeof row.pushed_at === "number" ? row.pushed_at : null,
		evidence: typeof row.evidence === "string" ? row.evidence : null,
	};
}

function decodeDeliveryRow(value: unknown): DeliveryRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const row = value as Record<string, unknown>;
	return {
		id: Number(row.id),
		session_key: String(row.session_key ?? ""),
		message: String(row.message ?? ""),
		message_hash: String(row.message_hash ?? ""),
		media: decodeDeliveryMedia(row.media),
		attachments: decodeDeliveryAttachments(row.attachments),
		target_channel: String(row.target_channel ?? "").trim(),
		target_chat_id: String(row.target_chat_id ?? "").trim(),
		source_refs: String(row.source_refs ?? "[]"),
		evidence: String(row.evidence ?? "[]"),
		action: String(row.action ?? "send"),
		state_summary_tag: String(row.state_summary_tag ?? "none"),
		delivered_at: Number(row.delivered_at),
		acked: Number(row.acked ?? 0),
		delivery_status: decodeDeliveryState(row.delivery_status),
		delivery_error: typeof row.delivery_error === "string" ? row.delivery_error : null,
		idempotency_key: String(row.idempotency_key ?? `delivery:${Number(row.id)}`),
		provider_message_id: typeof row.provider_message_id === "string" ? row.provider_message_id : null,
		target_receipts: decodeDeliveryTargetReceipts(row.target_receipts),
	};
}

export class ProactiveStore {
	private readonly db: DatabaseSync;
	private readonly clock: Clock;
	private readonly deliveryListeners = new Set<DeliveryListener>();
	private readonly deliveryAcknowledgedListeners = new Set<DeliveryAcknowledgedListener>();

	constructor(dbPath: string, clock: Clock = SystemClock) {
		this.clock = clock;
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SCHEMA);
		this.migrate();
	}

	/** 旧库补列(verdict/verdict_reason/evidence;tick_log 审计列)。 */
	private migrate(): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const cols = this.tableColumns("items");
			if (!cols.has("verdict")) this.db.exec("ALTER TABLE items ADD COLUMN verdict TEXT");
			if (!cols.has("verdict_reason")) this.db.exec("ALTER TABLE items ADD COLUMN verdict_reason TEXT");
			if (!cols.has("evidence")) this.db.exec("ALTER TABLE items ADD COLUMN evidence TEXT");
			if (!cols.has("source_event_id")) this.db.exec("ALTER TABLE items ADD COLUMN source_event_id TEXT");
			if (!cols.has("ack_source_id")) this.db.exec("ALTER TABLE items ADD COLUMN ack_source_id TEXT");
			if (!cols.has("kind")) this.db.exec("ALTER TABLE items ADD COLUMN kind TEXT NOT NULL DEFAULT 'content'");
			this.db.exec("CREATE INDEX IF NOT EXISTS idx_items_source_event ON items (ack_source_id, source_event_id)");
			const sourceAckCols = this.tableColumns("source_ack_queue");
			if (!sourceAckCols.has("next_attempt_at")) {
				this.db.exec("ALTER TABLE source_ack_queue ADD COLUMN next_attempt_at INTEGER");
			}
			const deliveryCols = this.tableColumns("deliveries");
			if (!deliveryCols.has("acked")) {
				this.db.exec("ALTER TABLE deliveries ADD COLUMN acked INTEGER NOT NULL DEFAULT 0");
			}
			if (!deliveryCols.has("delivery_status")) {
				this.db.exec("ALTER TABLE deliveries ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending'");
			}
			if (!deliveryCols.has("delivery_error")) {
				this.db.exec("ALTER TABLE deliveries ADD COLUMN delivery_error TEXT");
			}
			if (!deliveryCols.has("idempotency_key")) {
				this.db.exec("ALTER TABLE deliveries ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT ''");
			}
			if (!deliveryCols.has("provider_message_id")) {
				this.db.exec("ALTER TABLE deliveries ADD COLUMN provider_message_id TEXT");
			}
			if (!deliveryCols.has("target_receipts")) {
				this.db.exec("ALTER TABLE deliveries ADD COLUMN target_receipts TEXT NOT NULL DEFAULT '[]'");
			}
			this.db.exec("UPDATE deliveries SET idempotency_key = 'delivery:' || id WHERE idempotency_key = ''");
			this.db.exec(
				"UPDATE deliveries SET delivery_status = 'success', delivery_error = NULL WHERE acked = 1 AND delivery_status = 'pending'",
			);
			if (!deliveryCols.has("media")) {
				this.db.exec("ALTER TABLE deliveries ADD COLUMN media TEXT NOT NULL DEFAULT '[]'");
			}
			if (!deliveryCols.has("attachments")) {
				this.db.exec("ALTER TABLE deliveries ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
			}
			if (!deliveryCols.has("target_channel")) {
				this.db.exec("ALTER TABLE deliveries ADD COLUMN target_channel TEXT NOT NULL DEFAULT ''");
			}
			if (!deliveryCols.has("target_chat_id")) {
				this.db.exec("ALTER TABLE deliveries ADD COLUMN target_chat_id TEXT NOT NULL DEFAULT ''");
			}
			this.db.exec(
				`UPDATE deliveries SET idempotency_key = 'delivery:' || id
				 WHERE idempotency_key IN (
					SELECT idempotency_key FROM deliveries WHERE idempotency_key <> ''
					GROUP BY idempotency_key HAVING COUNT(*) > 1
				 )`,
			);
			this.db.exec(
				"CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_idempotency ON deliveries(idempotency_key) WHERE idempotency_key <> ''",
			);
			const logCols = this.tableColumns("tick_log");
			if (!logCols.has("interesting_ids"))
				this.db.exec("ALTER TABLE tick_log ADD COLUMN interesting_ids TEXT NOT NULL DEFAULT '[]'");
			if (!logCols.has("discarded_ids"))
				this.db.exec("ALTER TABLE tick_log ADD COLUMN discarded_ids TEXT NOT NULL DEFAULT '[]'");
			if (!logCols.has("cited_ids"))
				this.db.exec("ALTER TABLE tick_log ADD COLUMN cited_ids TEXT NOT NULL DEFAULT '[]'");
			if (!logCols.has("drift_entered"))
				this.db.exec("ALTER TABLE tick_log ADD COLUMN drift_entered INTEGER NOT NULL DEFAULT 0");
			if (!logCols.has("final_message"))
				this.db.exec("ALTER TABLE tick_log ADD COLUMN final_message TEXT NOT NULL DEFAULT ''");
			if (!logCols.has("llm_call_count"))
				this.db.exec("ALTER TABLE tick_log ADD COLUMN llm_call_count INTEGER NOT NULL DEFAULT 0");
			if (!logCols.has("tick_id")) this.db.exec("ALTER TABLE tick_log ADD COLUMN tick_id TEXT");
			if (!logCols.has("gate_exit"))
				this.db.exec("ALTER TABLE tick_log ADD COLUMN gate_exit TEXT NOT NULL DEFAULT ''");
			if (!logCols.has("alert_count"))
				this.db.exec("ALTER TABLE tick_log ADD COLUMN alert_count INTEGER NOT NULL DEFAULT 0");
			if (!logCols.has("content_count"))
				this.db.exec("ALTER TABLE tick_log ADD COLUMN content_count INTEGER NOT NULL DEFAULT 0");
			if (!logCols.has("context_count"))
				this.db.exec("ALTER TABLE tick_log ADD COLUMN context_count INTEGER NOT NULL DEFAULT 0");
			if (!logCols.has("llm_cache_read_tokens"))
				this.db.exec("ALTER TABLE tick_log ADD COLUMN llm_cache_read_tokens INTEGER NOT NULL DEFAULT 0");
			if (!logCols.has("llm_cache_write_tokens"))
				this.db.exec("ALTER TABLE tick_log ADD COLUMN llm_cache_write_tokens INTEGER NOT NULL DEFAULT 0");
			if (!logCols.has("effects_json"))
				this.db.exec("ALTER TABLE tick_log ADD COLUMN effects_json TEXT NOT NULL DEFAULT '[]'");
			const stepCols = this.tableColumns("tick_steps");
			if (!stepCols.has("tool_name"))
				this.db.exec("ALTER TABLE tick_steps ADD COLUMN tool_name TEXT NOT NULL DEFAULT ''");
			if (!stepCols.has("tool_call_id"))
				this.db.exec("ALTER TABLE tick_steps ADD COLUMN tool_call_id TEXT NOT NULL DEFAULT ''");
			if (!stepCols.has("tool_args_json"))
				this.db.exec("ALTER TABLE tick_steps ADD COLUMN tool_args_json TEXT NOT NULL DEFAULT ''");
			if (!stepCols.has("tool_result_text"))
				this.db.exec("ALTER TABLE tick_steps ADD COLUMN tool_result_text TEXT NOT NULL DEFAULT ''");
			if (!stepCols.has("interesting_ids_after"))
				this.db.exec("ALTER TABLE tick_steps ADD COLUMN interesting_ids_after TEXT NOT NULL DEFAULT ''");
			if (!stepCols.has("discarded_ids_after"))
				this.db.exec("ALTER TABLE tick_steps ADD COLUMN discarded_ids_after TEXT NOT NULL DEFAULT ''");
			if (!stepCols.has("cited_ids_after"))
				this.db.exec("ALTER TABLE tick_steps ADD COLUMN cited_ids_after TEXT NOT NULL DEFAULT ''");
			if (!stepCols.has("final_message_after"))
				this.db.exec("ALTER TABLE tick_steps ADD COLUMN final_message_after TEXT NOT NULL DEFAULT ''");
			this.db.exec("PRAGMA user_version = 9");
			this.db.exec("COMMIT");
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// Preserve the migration error.
			}
			throw error;
		}
	}

	private tableColumns(table: string): Set<string> {
		return new Set(
			(this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
		);
	}

	close(): void {
		this.deliveryListeners.clear();
		this.deliveryAcknowledgedListeners.clear();
		this.db.close();
	}

	onDelivery(listener: DeliveryListener): () => void {
		this.deliveryListeners.add(listener);
		return () => this.deliveryListeners.delete(listener);
	}

	onDeliveryAcknowledged(listener: DeliveryAcknowledgedListener): () => void {
		this.deliveryAcknowledgedListeners.add(listener);
		return () => this.deliveryAcknowledgedListeners.delete(listener);
	}

	// ------------------------------------------------------------------
	// Items
	// ------------------------------------------------------------------

	/** Insert an item, skipping duplicates by title_hash. Returns false when skipped. */
	insertItem(
		item: Omit<ProactiveItem, "id" | "status" | "pushed_at" | "evidence" | "kind"> & {
			kind?: ProactiveItemKind;
		},
	): boolean {
		const result = this.db
			.prepare(
				`INSERT OR IGNORE INTO items (
					scope, source, sub_source, source_event_id, ack_source_id, title, url, summary,
					title_hash, interest_score, recommendation, kind, fetched_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				item.scope,
				item.source,
				item.sub_source,
				item.source_event_id ?? null,
				item.ack_source_id ?? null,
				item.title,
				item.url,
				item.summary,
				item.title_hash,
				item.interest_score,
				item.recommendation,
				item.kind ?? "content",
				item.fetched_at,
			);
		return result.changes > 0;
	}

	/** New (never pushed) items, newest first. */
	listNew(limit = 50, scope = ""): ProactiveItem[] {
		const rows = this.db
			.prepare(`SELECT * FROM items WHERE status = 'new' AND scope = ? ORDER BY fetched_at DESC, id DESC LIMIT ?`)
			.all(scope, limit) as unknown as Record<string, unknown>[];
		return rows.map(decodeItemRow);
	}

	getItem(id: number): ProactiveItem | undefined {
		const row = this.db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
		return row ? decodeItemRow(row) : undefined;
	}

	markPushed(id: number, pushedAt?: number): void {
		this.db
			.prepare(`UPDATE items SET status = 'pushed', pushed_at = ? WHERE id = ?`)
			.run(pushedAt ?? this.clock.nowMs(), id);
	}

	markDismissed(id: number): void {
		this.db.prepare(`UPDATE items SET status = 'dismissed' WHERE id = ?`).run(id);
	}

	setItemEvidence(id: number, evidence: string): void {
		this.db.prepare(`UPDATE items SET evidence = ? WHERE id = ?`).run(evidence, id);
	}

	/** 落库判题分类(akashic mark_interesting / mark_not_interesting)。 */
	setVerdict(id: number, verdict: "interesting" | "not_interesting", reason: string | null): void {
		this.db.prepare(`UPDATE items SET verdict = ?, verdict_reason = ? WHERE id = ?`).run(verdict, reason, id);
	}

	getState(key: string): string | undefined {
		const row = this.db.prepare(`SELECT value FROM state WHERE key = ?`).get(key) as { value: string } | undefined;
		return row?.value;
	}

	setState(key: string, value: string): void {
		this.db
			.prepare(`INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
			.run(key, value);
	}

	/** Record a bad source item without aborting the rest of its batch. */
	recordSourceQuarantine(record: {
		sourceId: string;
		itemId: string;
		reason: string;
		payload: unknown;
		now?: number;
	}): void {
		const now = record.now ?? this.clock.nowMs();
		const identity = `${record.sourceId}:${record.itemId}`;
		const payloadJson = serializeQuarantinePayload(record.payload);
		this.db
			.prepare(
				`INSERT INTO source_quarantine(
					identity, source_id, item_id, reason, payload_json, first_seen_at, last_seen_at, occurrences
				) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
				ON CONFLICT(identity) DO UPDATE SET
					reason=excluded.reason,
					payload_json=excluded.payload_json,
					last_seen_at=excluded.last_seen_at,
					occurrences=source_quarantine.occurrences + 1`,
			)
			.run(identity, record.sourceId, record.itemId, record.reason.slice(0, 500), payloadJson, now, now);
		this.db
			.prepare(
				`DELETE FROM source_quarantine WHERE source_id = ? AND identity NOT IN (
					SELECT identity FROM source_quarantine WHERE source_id = ? ORDER BY last_seen_at DESC LIMIT ?
				)`,
			)
			.run(record.sourceId, record.sourceId, SOURCE_QUARANTINE_PER_SOURCE_CAP);
		this.db
			.prepare(
				`DELETE FROM source_quarantine WHERE identity NOT IN (
					SELECT identity FROM source_quarantine ORDER BY last_seen_at DESC LIMIT ?
				)`,
			)
			.run(SOURCE_QUARANTINE_GLOBAL_CAP);
	}

	listSourceQuarantine(limit = 100): SourceQuarantineRecord[] {
		return this.db
			.prepare(`SELECT * FROM source_quarantine ORDER BY last_seen_at DESC LIMIT ?`)
			.all(Math.max(0, limit)) as unknown as SourceQuarantineRecord[];
	}

	recordSourceFailure(record: { sourceId: string; error: string; diagnostics?: unknown; now?: number }): void {
		let diagnosticsJson = "{}";
		try {
			diagnosticsJson = JSON.stringify(record.diagnostics ?? {});
		} catch {
			diagnosticsJson = JSON.stringify({ unserializable: String(record.diagnostics) });
		}
		this.db
			.prepare(
				`INSERT INTO source_failures(source_id, checked_at, error, diagnostics_json)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(
				record.sourceId,
				record.now ?? this.clock.nowMs(),
				record.error.slice(0, 2000),
				diagnosticsJson.slice(0, 4096),
			);
		this.db
			.prepare(
				`DELETE FROM source_failures WHERE id NOT IN (
					SELECT id FROM source_failures ORDER BY checked_at DESC, id DESC LIMIT 2000
				)`,
			)
			.run();
	}

	listSourceFailures(limit = 100): SourceFailureRecord[] {
		return this.db
			.prepare(`SELECT * FROM source_failures ORDER BY checked_at DESC, id DESC LIMIT ?`)
			.all(Math.max(0, limit)) as unknown as SourceFailureRecord[];
	}

	/** Queue upstream event acknowledgements until the source accepts them. */
	queueSourceAcknowledgements(sourceId: string, eventIds: readonly string[], now?: number): void {
		const normalizedSourceId = sourceId.trim();
		if (!normalizedSourceId) return;
		const queuedAt = now ?? this.clock.nowMs();
		const insert = this.db.prepare(
			`INSERT OR IGNORE INTO source_ack_queue (source_id, event_id, queued_at)
			 VALUES (?, ?, ?)`,
		);
		for (const eventId of eventIds) {
			const normalizedEventId = eventId.trim();
			if (normalizedEventId) insert.run(normalizedSourceId, normalizedEventId, queuedAt);
		}
	}

	listPendingSourceAcknowledgements(limit = 1000): PendingSourceAcknowledgement[] {
		return this.db
			.prepare(
				`SELECT source_id, event_id, queued_at, attempts, last_error, last_attempt_at, next_attempt_at
				 FROM source_ack_queue ORDER BY queued_at ASC, source_id ASC, event_id ASC LIMIT ?`,
			)
			.all(Math.max(1, Math.floor(limit))) as unknown as PendingSourceAcknowledgement[];
	}

	listDueSourceAcknowledgements(now: number, limit = 1000): PendingSourceAcknowledgement[] {
		return this.db
			.prepare(
				`SELECT source_id, event_id, queued_at, attempts, last_error, last_attempt_at, next_attempt_at
				 FROM source_ack_queue
				 WHERE next_attempt_at IS NULL OR next_attempt_at <= ?
				 ORDER BY queued_at ASC, source_id ASC, event_id ASC LIMIT ?`,
			)
			.all(now, Math.max(1, Math.floor(limit))) as unknown as PendingSourceAcknowledgement[];
	}

	markSourceAcknowledgements(sourceId: string, eventIds: readonly string[]): void {
		const statement = this.db.prepare(`DELETE FROM source_ack_queue WHERE source_id = ? AND event_id = ?`);
		for (const eventId of eventIds) statement.run(sourceId, eventId);
	}

	recordSourceAcknowledgementFailure(
		sourceId: string,
		eventIds: readonly string[],
		error: string,
		now?: number,
		nextAttemptAt?: number,
	): void {
		const statement = this.db.prepare(
			`UPDATE source_ack_queue
			 SET attempts = attempts + 1, last_error = ?, last_attempt_at = ?, next_attempt_at = ?
			 WHERE source_id = ? AND event_id = ?`,
		);
		const timestamp = now ?? this.clock.nowMs();
		for (const eventId of eventIds)
			statement.run(error.slice(0, 2000), timestamp, nextAttemptAt ?? timestamp, sourceId, eventId);
	}

	/** Prune old pushed/dismissed items beyond retention days. Returns removed count. */
	prune(retentionDays = 30): number {
		const cutoff = this.clock.nowMs() - retentionDays * 24 * 60 * 60 * 1000;
		const result = this.db
			.prepare(`DELETE FROM items WHERE status != 'new' AND COALESCE(pushed_at, fetched_at) < ?`)
			.run(cutoff);
		return Number(result.changes);
	}

	/** Prune terminal runtime history while retaining pending deliveries and ACK work. */
	pruneHistory(options: ProactiveRetentionOptions = {}): ProactiveRetentionResult {
		const result: ProactiveRetentionResult = {
			itemsDeleted: 0,
			deliveriesDeleted: 0,
			tickLogsDeleted: 0,
			tickStepsDeleted: 0,
			sourceFailuresDeleted: 0,
			quarantineDeleted: 0,
			contextOnlyDeleted: 0,
			dailyCountsDeleted: 0,
		};
		const hasPolicy = Object.entries(options).some(([key, value]) => key !== "now" && value !== undefined);
		if (!hasPolicy) return result;

		const now = options.now ?? this.clock.nowMs();
		const cutoff = (days: number | undefined): number | undefined =>
			days !== undefined && Number.isFinite(days) && days >= 0 ? now - days * 24 * 3600_000 : undefined;
		const ageCutoffs = {
			items: cutoff(options.maxItemAgeDays),
			deliveries: cutoff(options.maxDeliveryAgeDays),
			ticks: cutoff(options.maxTickLogAgeDays),
			failures: cutoff(options.maxSourceFailureAgeDays),
			quarantine: cutoff(options.maxQuarantineAgeDays),
			contextOnly: cutoff(options.maxContextOnlyAgeDays),
			dailyCounts: cutoff(options.maxDailyCountAgeDays),
		};
		const normalizeCount = (value: number | undefined): number | undefined =>
			value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
		const db = this.db;
		db.exec("BEGIN IMMEDIATE");
		try {
			const selectIds = (
				table: string,
				timeExpression: string,
				where: string,
				cutoffValue: number | undefined,
				maxRows: number | undefined,
			): number[] => {
				const clauses = [where];
				const args: Array<number> = [];
				if (cutoffValue !== undefined) {
					clauses.push(`${timeExpression} < ?`);
					args.push(cutoffValue);
				}
				if (cutoffValue === undefined && maxRows === undefined) return [];
				const rows = db
					.prepare(
						`SELECT id, ${timeExpression} AS retention_time FROM ${table}
						 WHERE ${clauses.join(" AND ")}
						 ORDER BY ${timeExpression} DESC, id DESC`,
					)
					.all(...args) as Array<{ id: number; retention_time: number }>;
				const keep = new Set(maxRows === undefined ? [] : rows.slice(0, maxRows).map((row) => row.id));
				return rows
					.filter(
						(row) =>
							(cutoffValue !== undefined && row.retention_time < cutoffValue) ||
							(maxRows !== undefined && !keep.has(row.id)),
					)
					.map((row) => row.id);
			};

			const itemIds = selectIds(
				"items",
				"COALESCE(pushed_at, fetched_at)",
				"status <> 'new'",
				ageCutoffs.items,
				undefined,
			);
			for (const id of itemIds)
				result.itemsDeleted += Number(db.prepare("DELETE FROM items WHERE id = ?").run(id).changes);

			const deliveryIds = selectIds(
				"deliveries",
				"delivered_at",
				"acked = 1",
				ageCutoffs.deliveries,
				normalizeCount(options.maxDeliveries),
			);
			for (const id of deliveryIds) {
				result.deliveriesDeleted += Number(
					db.prepare("DELETE FROM deliveries WHERE id = ? AND acked = 1").run(id).changes,
				);
			}

			const tickIds = selectIds(
				"tick_log",
				"finished_at",
				"finished_at IS NOT NULL",
				ageCutoffs.ticks,
				normalizeCount(options.maxTickLogs),
			);
			for (const id of tickIds) {
				result.tickStepsDeleted += Number(db.prepare("DELETE FROM tick_steps WHERE tick_id = ?").run(id).changes);
				result.tickLogsDeleted += Number(db.prepare("DELETE FROM tick_log WHERE id = ?").run(id).changes);
			}

			const failureIds = selectIds(
				"source_failures",
				"checked_at",
				"1 = 1",
				ageCutoffs.failures,
				normalizeCount(options.maxSourceFailures),
			);
			for (const id of failureIds) {
				result.sourceFailuresDeleted += Number(
					db.prepare("DELETE FROM source_failures WHERE id = ?").run(id).changes,
				);
			}

			if (ageCutoffs.quarantine !== undefined) {
				result.quarantineDeleted += Number(
					db.prepare("DELETE FROM source_quarantine WHERE last_seen_at < ?").run(ageCutoffs.quarantine).changes,
				);
			}
			if (ageCutoffs.contextOnly !== undefined) {
				result.contextOnlyDeleted += Number(
					db.prepare("DELETE FROM context_only_timestamps WHERE ts < ?").run(ageCutoffs.contextOnly).changes,
				);
			}
			if (ageCutoffs.dailyCounts !== undefined) {
				const cutoffDay = new Date(ageCutoffs.dailyCounts).toISOString().slice(0, 10);
				result.dailyCountsDeleted += Number(
					db.prepare("DELETE FROM daily_counts WHERE day < ?").run(cutoffDay).changes,
				);
			}
			db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// Preserve the original cleanup error.
			}
			throw error;
		}
	}

	// ------------------------------------------------------------------
	// Deliveries (akashic state.py: delivery dedup + recent-N dedup)
	// ------------------------------------------------------------------

	insertDelivery(record: DeliveryInput, options: { notify?: boolean } = {}): number {
		const media = normalizeDeliveryMedia(record.media);
		const attachments = normalizeDeliveryAttachments(record.attachments);
		const targetChannel = normalizeDeliveryRoute(record.target_channel);
		const targetChatId = normalizeDeliveryRoute(record.target_chat_id);
		const idempotencyKey = normalizeDeliveryRoute(record.idempotency_key) || `delivery:${randomUUID()}`;
		const existing = this.db
			.prepare("SELECT id FROM deliveries WHERE idempotency_key = ? LIMIT 1")
			.get(idempotencyKey) as { id: number } | undefined;
		if (existing) return Number(existing.id);
		const result = this.db
			.prepare(
				`INSERT OR IGNORE INTO deliveries (
					session_key, message, message_hash, media, attachments, target_channel, target_chat_id,
					source_refs, evidence, action, state_summary_tag, delivered_at, delivery_status,
					delivery_error, idempotency_key, provider_message_id, target_receipts
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				record.session_key,
				record.message,
				record.message_hash,
				JSON.stringify(media),
				JSON.stringify(attachments),
				targetChannel,
				targetChatId,
				record.source_refs,
				record.evidence,
				record.action,
				record.state_summary_tag,
				record.delivered_at,
				"pending",
				null,
				idempotencyKey,
				null,
				"[]",
			);
		const inserted = result.changes > 0;
		const id = inserted
			? Number(result.lastInsertRowid ?? 0)
			: Number(
					(
						this.db.prepare("SELECT id FROM deliveries WHERE idempotency_key = ? LIMIT 1").get(idempotencyKey) as
							| { id: number }
							| undefined
					)?.id ?? 0,
				);
		if (!id) throw new Error(`failed to persist delivery ${idempotencyKey}`);
		const delivery: DeliveryRecord = {
			...record,
			media,
			attachments,
			target_channel: targetChannel,
			target_chat_id: targetChatId,
			idempotency_key: idempotencyKey,
			provider_message_id: null,
			target_receipts: [],
			id,
			acked: 0,
			delivery_status: "pending",
			delivery_error: null,
		};
		if (!inserted || options.notify === false) return id;
		for (const listener of this.deliveryListeners) {
			try {
				listener(delivery);
			} catch (error) {
				console.error(
					`proactive delivery listener failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return id;
	}

	getDelivery(id: number): DeliveryRecord | undefined {
		return decodeDeliveryRow(this.db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(id));
	}

	/** Read an existing logical delivery before deciding whether a retry is safe. */
	getDeliveryByIdempotencyKey(key: string): DeliveryRecord | undefined {
		return decodeDeliveryRow(this.db.prepare(`SELECT * FROM deliveries WHERE idempotency_key = ? LIMIT 1`).get(key));
	}

	/** True when the same message hash was delivered within the dedup window. */
	isMessageDelivered(messageHash: string, withinHours: number, now?: number): boolean {
		const cutoff = (now ?? this.clock.nowMs()) - withinHours * 3600_000;
		const row = this.db
			.prepare(
				`SELECT 1 AS found FROM deliveries
				 WHERE message_hash = ? AND delivered_at >= ? AND acked = 1 AND delivery_status = 'success' LIMIT 1`,
			)
			.get(messageHash, cutoff) as { found: number } | undefined;
		return row !== undefined;
	}

	/** 投递冷却计数(akashic count_deliveries_in_window):窗口内有投递则 gate 拒绝本轮。 */
	countDeliveriesInWindow(withinHours: number, now?: number): number {
		const cutoff = (now ?? this.clock.nowMs()) - withinHours * 3600_000;
		const row = this.db
			.prepare(
				`SELECT COUNT(*) AS count FROM deliveries
				 WHERE delivered_at >= ? AND acked = 1 AND delivery_status = 'success'`,
			)
			.get(cutoff) as { count: number };
		return row.count;
	}

	/** True when the content ids were delivered within the dedup window (delivery_dedupe_hours). */
	isContentDelivered(contentIds: readonly string[], withinHours: number, now?: number): boolean {
		if (contentIds.length === 0) return false;
		const cutoff = (now ?? this.clock.nowMs()) - withinHours * 3600_000;
		const rows = this.db
			.prepare(
				`SELECT source_refs FROM deliveries
				 WHERE delivered_at >= ? AND acked = 1 AND delivery_status = 'success'`,
			)
			.all(cutoff) as Array<{ source_refs: string }>;
		for (const row of rows) {
			try {
				const refs = JSON.parse(row.source_refs) as Array<{ id: string | number }>;
				if (refs.some((ref) => contentIds.includes(String(ref.id)))) return true;
			} catch {
				// Corrupt refs row; skip.
			}
		}
		return false;
	}

	/** Recent delivered messages (message_dedupe_recent_n). */
	recentDeliveredMessages(n: number): string[] {
		const rows = this.db
			.prepare(
				`SELECT message FROM deliveries
				 WHERE acked = 1 AND delivery_status = 'success'
				 ORDER BY delivered_at DESC LIMIT ?`,
			)
			.all(n) as Array<{ message: string }>;
		return rows.map((row) => row.message);
	}

	listDeliveries(limit = 20): DeliveryRecord[] {
		return this.db
			.prepare(`SELECT * FROM deliveries ORDER BY delivered_at DESC LIMIT ?`)
			.all(limit)
			.map(decodeDeliveryRow)
			.filter((record): record is DeliveryRecord => record !== undefined);
	}

	/** Successfully delivered rows for semantic dedupe and recent-message context. */
	listDeliveredDeliveries(limit = 20): DeliveryRecord[] {
		return this.db
			.prepare(
				`SELECT * FROM deliveries
				 WHERE acked = 1 AND delivery_status = 'success'
				 ORDER BY delivered_at DESC LIMIT ?`,
			)
			.all(limit)
			.map(decodeDeliveryRow)
			.filter((record): record is DeliveryRecord => record !== undefined);
	}

	/** Undelivered deliveries (not yet acked by the outlet), newest first. */
	listPendingDeliveries(limit = 10): DeliveryRecord[] {
		return this.db
			.prepare(`SELECT * FROM deliveries WHERE acked = 0 ORDER BY delivered_at ASC LIMIT ?`)
			.all(limit)
			.map(decodeDeliveryRow)
			.filter((record): record is DeliveryRecord => record !== undefined);
	}

	recordDeliveryReceipt(id: number, receipt: DeliveryReceiptUpdate): void {
		const current = this.getDelivery(id);
		if (!current) return;
		const targetReceipts = mergeTargetReceipts(current.target_receipts, receipt.targetReceipts ?? []);
		const providerMessageId = receipt.providerMessageId?.trim() || current.provider_message_id;
		this.db
			.prepare(`UPDATE deliveries SET provider_message_id = ?, target_receipts = ? WHERE id = ?`)
			.run(providerMessageId || null, JSON.stringify(targetReceipts), id);
	}

	/** Record a non-terminal delivery attempt without marking source items pushed. */
	recordDeliveryFailure(
		id: number,
		status: Exclude<DeliveryState, "pending" | "success">,
		detail?: string,
		receipt?: DeliveryReceiptUpdate,
	): void {
		if (receipt) this.recordDeliveryReceipt(id, receipt);
		this.db
			.prepare(`UPDATE deliveries SET acked = 0, delivery_status = ?, delivery_error = ? WHERE id = ?`)
			.run(status, detail?.slice(0, 2000) ?? null, id);
	}

	/** Mark deliveries as shown by the outlet. */
	ackDeliveries(
		ids: readonly number[],
		acknowledgedAt = this.clock.nowMs(),
		options: { notify?: boolean } = {},
	): void {
		if (ids.length === 0) return;
		const update = this.db.prepare(
			`UPDATE deliveries SET acked = 1, delivery_status = 'success', delivery_error = NULL WHERE id = ?`,
		);
		for (const id of ids) {
			const row = this.getDelivery(id);
			if (!row) continue;
			if (row.acked !== 0) continue;
			update.run(id);
			const acknowledged: DeliveryRecord = {
				...row,
				acked: 1,
				delivery_status: "success",
				delivery_error: null,
			};
			this.setState("lastDelivery", row.message.slice(0, 500));
			try {
				const refs = JSON.parse(row.source_refs) as Array<{ id?: string | number }>;
				for (const ref of refs) {
					const itemId = typeof ref.id === "number" ? ref.id : Number(ref.id);
					if (Number.isSafeInteger(itemId) && itemId > 0) this.markPushed(itemId, acknowledgedAt);
				}
			} catch {
				// Corrupt source refs do not prevent the delivery row from being acked.
			}
			if (options.notify === false) continue;
			for (const listener of this.deliveryAcknowledgedListeners) {
				try {
					listener(acknowledged, acknowledgedAt);
				} catch (error) {
					console.error(
						`proactive delivery acknowledgement listener failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}
	}

	// ------------------------------------------------------------------
	// Tick log + daily counts (akashic state.py)
	// ------------------------------------------------------------------

	recordTickLog(record: Omit<TickLogRecord, "id">): number {
		const result = this.db
			.prepare(
				`INSERT INTO tick_log (session_key, started_at, finished_at, base_score, candidates, steps, action, skip_reason, error,
				 interesting_ids, discarded_ids, cited_ids, drift_entered, final_message, llm_call_count,
				 tick_id, gate_exit, alert_count, content_count, context_count, llm_cache_read_tokens, llm_cache_write_tokens)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				record.session_key,
				record.started_at,
				record.finished_at,
				record.base_score,
				record.candidates,
				record.steps,
				record.action,
				record.skip_reason,
				record.error,
				record.interesting_ids ?? "[]",
				record.discarded_ids ?? "[]",
				record.cited_ids ?? "[]",
				record.drift_entered ?? 0,
				record.final_message ?? "",
				record.llm_call_count ?? 0,
				record.tick_id ?? randomUUID(),
				record.gate_exit ?? "",
				record.alert_count ?? 0,
				record.content_count ?? 0,
				record.context_count ?? 0,
				record.llm_cache_read_tokens ?? 0,
				record.llm_cache_write_tokens ?? 0,
			);
		return Number(result.lastInsertRowid ?? 0);
	}

	finishTickLog(
		id: number,
		record: Pick<
			TickLogRecord,
			| "finished_at"
			| "base_score"
			| "steps"
			| "action"
			| "skip_reason"
			| "error"
			| "interesting_ids"
			| "discarded_ids"
			| "cited_ids"
			| "drift_entered"
			| "final_message"
			| "llm_call_count"
			| "llm_cache_read_tokens"
			| "llm_cache_write_tokens"
			| "effects_json"
		>,
	): void {
		this.db
			.prepare(
				`UPDATE tick_log SET finished_at = ?, base_score = ?, steps = ?, action = ?, skip_reason = ?, error = ?,
				 interesting_ids = ?, discarded_ids = ?, cited_ids = ?, drift_entered = ?, final_message = ?, llm_call_count = ?,
				 llm_cache_read_tokens = ?, llm_cache_write_tokens = ?, effects_json = ?
				 WHERE id = ?`,
			)
			.run(
				record.finished_at,
				record.base_score,
				record.steps,
				record.action,
				record.skip_reason,
				record.error,
				record.interesting_ids ?? "[]",
				record.discarded_ids ?? "[]",
				record.cited_ids ?? "[]",
				record.drift_entered ?? 0,
				record.final_message ?? "",
				record.llm_call_count ?? 0,
				record.llm_cache_read_tokens ?? 0,
				record.llm_cache_write_tokens ?? 0,
				record.effects_json ?? "[]",
				id,
			);
	}

	/** 记录 tick 的一个阶段步骤(供监控页回放)。 */
	recordTickStep(record: Omit<TickStepRecord, "id">): void {
		this.db
			.prepare(
				`INSERT INTO tick_steps (tick_id, step_index, phase, detail, action_after, skip_reason_after, duration_ms,
				 tool_name, tool_call_id, tool_args_json, tool_result_text,
				 interesting_ids_after, discarded_ids_after, cited_ids_after, final_message_after)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				record.tick_id,
				record.step_index,
				record.phase,
				record.detail,
				record.action_after,
				record.skip_reason_after,
				record.duration_ms,
				record.tool_name ?? "",
				record.tool_call_id ?? "",
				record.tool_args_json ?? "",
				record.tool_result_text ?? "",
				record.interesting_ids_after ?? "",
				record.discarded_ids_after ?? "",
				record.cited_ids_after ?? "",
				record.final_message_after ?? "",
			);
	}

	/** 查询一个 tick 的步骤(按执行顺序)。 */
	listTickSteps(tickId: number): TickStepRecord[] {
		return this.db
			.prepare(`SELECT * FROM tick_steps WHERE tick_id = ? ORDER BY step_index ASC`)
			.all(tickId) as unknown as TickStepRecord[];
	}

	/** 写入 tick 的候选 kind 计数(akashic alert_count/content_count/context_count)。 */
	updateTickLogCounts(id: number, counts: { alertCount: number; contentCount: number; contextCount: number }): void {
		this.db
			.prepare(`UPDATE tick_log SET alert_count = ?, content_count = ?, context_count = ? WHERE id = ?`)
			.run(counts.alertCount, counts.contentCount, counts.contextCount, id);
	}

	/** 写入 tick 的 gate 退出原因(akashic gate_exit)。 */
	updateTickLogGateExit(id: number, gateExit: string): void {
		this.db.prepare(`UPDATE tick_log SET gate_exit = ? WHERE id = ?`).run(gateExit, id);
	}

	/** Increment a daily counter; returns the new count. */
	incrementDailyCount(kind: string, now?: number): number {
		const day = new Date(now ?? this.clock.nowMs()).toISOString().slice(0, 10);
		this.db
			.prepare(
				`INSERT INTO daily_counts (day, kind, count) VALUES (?, ?, 1)
				 ON CONFLICT(day, kind) DO UPDATE SET count = count + 1`,
			)
			.run(day, kind);
		const row = this.db.prepare(`SELECT count FROM daily_counts WHERE day = ? AND kind = ?`).get(day, kind) as {
			count: number;
		};
		return Number(row.count);
	}

	getDailyCount(kind: string, now?: number): number {
		const day = new Date(now ?? this.clock.nowMs()).toISOString().slice(0, 10);
		const row = this.db.prepare(`SELECT count FROM daily_counts WHERE day = ? AND kind = ?`).get(day, kind) as
			| { count: number }
			| undefined;
		return row?.count ?? 0;
	}

	// ------------------------------------------------------------------
	// Context-only 滚动窗口计数(akashic context_only_timestamps)
	// ------------------------------------------------------------------

	/** 记录一次 context_only 兜底发送(akashic mark_context_only_send)。 */
	markContextOnlySend(sessionKey: string, now?: number): void {
		const timestamp = now ?? this.clock.nowMs();
		this.db.prepare(`INSERT INTO context_only_timestamps (session_key, ts) VALUES (?, ?)`).run(sessionKey, timestamp);
		this.setState("lastContextOnly", String(timestamp));
	}

	/** 滚动窗口内的 context_only 次数(akashic count_context_only_in_window)。 */
	countContextOnlyInWindow(windowHours: number, now?: number): number {
		const cutoff = (now ?? this.clock.nowMs()) - windowHours * 3600_000;
		const row = this.db
			.prepare(`SELECT COUNT(*) AS count FROM context_only_timestamps WHERE ts >= ?`)
			.get(cutoff) as { count: number };
		return Number(row.count);
	}

	// ------------------------------------------------------------------
	// Presence (akashic presence.py)
	// ------------------------------------------------------------------

	getPresence(sessionKey: string): PresenceRow {
		return (
			(this.db.prepare(`SELECT * FROM presence WHERE session_key = ?`).get(sessionKey) as
				| PresenceRow
				| undefined) ?? {
				session_key: sessionKey,
				last_user_at: null,
				last_proactive_at: null,
			}
		);
	}

	updatePresence(sessionKey: string, patch: Partial<Pick<PresenceRow, "last_user_at" | "last_proactive_at">>): void {
		const current = this.getPresence(sessionKey);
		this.db
			.prepare(
				`INSERT INTO presence (session_key, last_user_at, last_proactive_at) VALUES (?, ?, ?)
				 ON CONFLICT(session_key) DO UPDATE SET
				   last_user_at = COALESCE(?, last_user_at),
				   last_proactive_at = COALESCE(?, last_proactive_at)`,
			)
			.run(
				sessionKey,
				patch.last_user_at ?? current.last_user_at,
				patch.last_proactive_at ?? current.last_proactive_at,
				patch.last_user_at ?? null,
				patch.last_proactive_at ?? null,
			);
	}

	mostRecentUserAt(): number | null {
		const row = this.db.prepare(`SELECT MAX(last_user_at) AS latest FROM presence`).get() as {
			latest: number | null;
		};
		return row.latest ?? null;
	}
}

function serializeQuarantinePayload(payload: unknown): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(payload ?? {});
	} catch {
		serialized = JSON.stringify({ unserializable: String(payload) });
	}
	if (Buffer.byteLength(serialized, "utf-8") <= SOURCE_QUARANTINE_PAYLOAD_BYTES) return serialized;
	const previewBudget = Math.max(0, SOURCE_QUARANTINE_PAYLOAD_BYTES - 96);
	return JSON.stringify({ truncated: true, preview: serialized.slice(0, previewBudget) });
}

function mergeTargetReceipts(
	current: readonly DeliveryTargetReceipt[],
	updates: readonly DeliveryTargetReceipt[],
): DeliveryTargetReceipt[] {
	const merged = new Map(current.map((receipt) => [receipt.target, receipt]));
	for (const update of updates) {
		if (!update.target.trim() || update.status === "pending") continue;
		merged.set(update.target, {
			...update,
			target: update.target.trim(),
			detail: update.detail?.slice(0, 2000),
		});
	}
	return [...merged.values()];
}
