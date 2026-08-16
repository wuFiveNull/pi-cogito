/**
 * Wake 蓄水池存储(akashic plugins/wake_proactive/state.py port)。
 *
 * wake_proactive.db:reservoir_events(蓄水池)+ 隔离区/墓碑 + hazard/context/drift
 * 状态 + 待 ack 队列 + wake 审计(wake_runs / wake_observations)。
 */

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { type Clock, SystemClock } from "../clock.ts";
import { type ContextDriveResult, evaluateContext, type NormalizedContext } from "./context-drive.ts";
import type { HazardResult } from "./hazard.ts";
import type { WakeContext, WakeEvent } from "./types.ts";

const MAX_FUTURE_TIMESTAMP_SKEW_MS = 24 * 3600_000;
const QUARANTINE_PAYLOAD_BYTES = 4096;
const QUARANTINE_GLOBAL_CAP = 1000;
const QUARANTINE_PER_SOURCE_CAP = 100;
const TOMBSTONE_RETENTION_MS = 30 * 86_400_000;
const TOMBSTONE_GLOBAL_CAP = 10_000;

export type WakeTickStatus = "running" | "success" | "error";

export interface WakeTickRecord {
	wake_id: string;
	session_key: string;
	started_at: string;
	finished_at: string | null;
	status: WakeTickStatus;
	base_score: number | null;
	next_interval_seconds: number | null;
	error: string | null;
}

function parseOptionalTime(value: string | null): Date | null {
	if (!value) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function stableQuarantineId(kind: string, payload: unknown): string {
	const encoded = JSON.stringify(payload ?? {}, (_, value) =>
		typeof value === "object" && value !== null ? value : value,
	);
	const digest = createHash("sha256").update(encoded).digest("hex").slice(0, 24);
	return `${kind}:${digest}`;
}

function decodeContextRow(row: Record<string, unknown>): NormalizedContext {
	return {
		presence: row.presence as NormalizedContext["presence"],
		interruptibility: Number(row.interruptibility),
		confidence: Number(row.confidence),
		transition: String(row.transition_name ?? ""),
		observedAt: parseOptionalTime(row.observed_at as string | null),
		expiresAt: parseOptionalTime(row.expires_at as string | null),
		raw: JSON.parse(String(row.payload_json ?? "{}")) as Record<string, unknown>,
	};
}

export class WakeStateStore {
	private readonly db: DatabaseSync;
	private readonly clock: Clock;
	/** commit:false 延后的隔离区记录,随下一个批量 ingest 事务一起落库(akashic record_quarantine commit=False)。 */
	private deferredQuarantine: Array<{ sourceId: string; itemId: string; reason: string; payload: unknown }> = [];

	constructor(dbPath: string, clock: Clock = SystemClock) {
		this.clock = clock;
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.db.exec(`
CREATE TABLE IF NOT EXISTS wake_runs (
  wake_id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  now_utc TEXT NOT NULL,
  scratchpad_json TEXT NOT NULL,
  investigations_json TEXT NOT NULL,
  final_message TEXT NOT NULL,
  cited_ids_json TEXT NOT NULL,
  display_event_map_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  investigation_completed INTEGER NOT NULL DEFAULT 0,
  terminal_action TEXT
);
CREATE TABLE IF NOT EXISTS wake_tick_log (
  wake_id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  base_score REAL,
  next_interval_seconds INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_wake_tick_log_started ON wake_tick_log (started_at DESC);
CREATE TABLE IF NOT EXISTS wake_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wake_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  now_utc TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  llm_input_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reservoir_events (
  item_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  original_source_id TEXT NOT NULL,
  ack_source_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  preprocess_score REAL NOT NULL,
  payload_json TEXT NOT NULL,
  embedding_json TEXT,
  status TEXT NOT NULL DEFAULT 'unread',
  consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS reservoir_quarantine (
  identity TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS reservoir_tombstones (
  identity TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hazard_state (
  session_key TEXT PRIMARY KEY,
  hazard REAL NOT NULL,
  threshold REAL NOT NULL,
  updated_at TEXT NOT NULL,
  last_wake_at TEXT
);
CREATE TABLE IF NOT EXISTS hazard_monitor (
  session_key TEXT PRIMARY KEY,
  hazard_before REAL NOT NULL,
  hazard_after REAL NOT NULL,
  preference_pressure REAL NOT NULL,
  threshold REAL NOT NULL,
  evidence REAL NOT NULL,
  rate REAL NOT NULL,
  driver_item_id TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  should_wake INTEGER NOT NULL,
  evaluated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS context_state (
  source_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  presence TEXT NOT NULL,
  interruptibility REAL NOT NULL,
  confidence REAL NOT NULL,
  transition_name TEXT NOT NULL,
  observed_at TEXT,
  expires_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS context_reevaluate_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  last_signaled_at TEXT,
  last_candidate_at TEXT,
  suppressed_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS drift_state (
  session_key TEXT PRIMARY KEY,
  hazard REAL NOT NULL,
  threshold REAL NOT NULL,
  updated_at TEXT NOT NULL,
  last_drift_at TEXT,
  last_fingerprint TEXT NOT NULL DEFAULT '',
  repeat_count INTEGER NOT NULL DEFAULT 0,
  timer_anchor TEXT,
  next_attempt_at TEXT
);
CREATE TABLE IF NOT EXISTS pending_acknowledgements (
  source_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  item_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT 'consume',
  queued_at TEXT NOT NULL,
  PRIMARY KEY(source_id, source_event_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_reservoir_unread
  ON reservoir_events(kind, status, original_source_id, published_at DESC, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_reservoir_expiry
  ON reservoir_events(kind, status, first_seen_at);
CREATE INDEX IF NOT EXISTS idx_quarantine_source_time
  ON reservoir_quarantine(source_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_tombstone_time
  ON reservoir_tombstones(acknowledged_at);
`);
	}

	// ------------------------------------------------------------------
	// Wake 审计(wake_runs / wake_observations)
	// ------------------------------------------------------------------

	recordTickStart(options: { wakeId: string; sessionKey: string; startedAt: Date }): void {
		this.db
			.prepare(
				`INSERT INTO wake_tick_log(
					wake_id, session_key, started_at, finished_at, status, base_score, next_interval_seconds, error
				) VALUES (?, ?, ?, NULL, 'running', NULL, NULL, NULL)
				ON CONFLICT(wake_id) DO UPDATE SET
					session_key=excluded.session_key,
					started_at=excluded.started_at,
					finished_at=NULL,
					status='running',
					base_score=NULL,
					next_interval_seconds=NULL,
					error=NULL`,
			)
			.run(options.wakeId, options.sessionKey, options.startedAt.toISOString());
	}

	finishTick(options: {
		wakeId: string;
		finishedAt: Date;
		status: Exclude<WakeTickStatus, "running">;
		baseScore?: number | null;
		nextIntervalSeconds?: number | null;
		error?: string | null;
	}): void {
		this.db
			.prepare(
				`UPDATE wake_tick_log SET
					finished_at=?, status=?, base_score=?, next_interval_seconds=?, error=?
				 WHERE wake_id=? AND status='running'`,
			)
			.run(
				options.finishedAt.toISOString(),
				options.status,
				options.baseScore ?? null,
				options.nextIntervalSeconds ?? null,
				options.error?.slice(0, 2000) ?? null,
				options.wakeId,
			);
	}

	listTickLogs(limit = 100): WakeTickRecord[] {
		return this.db
			.prepare(`SELECT * FROM wake_tick_log ORDER BY started_at DESC LIMIT ?`)
			.all(Math.max(0, limit)) as unknown as WakeTickRecord[];
	}

	listTickErrors(limit = 100): WakeTickRecord[] {
		return this.db
			.prepare(`SELECT * FROM wake_tick_log WHERE status = 'error' ORDER BY started_at DESC LIMIT ?`)
			.all(Math.max(0, limit)) as unknown as WakeTickRecord[];
	}

	save(ctx: WakeContext): void {
		const scratchpad = {
			items: Object.fromEntries(
				Object.entries(ctx.scratchpad).map(([itemId, item]) => [
					itemId,
					{ initial_interest: item.initialInterest, question: item.question },
				]),
			),
			preference_probe: ctx.preferenceProbe
				? {
						candidate_ids: ctx.preferenceProbe.candidateIds,
						topic: ctx.preferenceProbe.topic,
						query: ctx.preferenceProbe.query,
					}
				: null,
		};
		const investigations = { items: ctx.investigationResults, preference_evidence: ctx.preferenceEvidence };
		this.db
			.prepare(
				`INSERT INTO wake_runs (
					wake_id, session_key, now_utc, scratchpad_json, investigations_json,
					final_message, cited_ids_json, display_event_map_json, source_refs_json,
					investigation_completed, terminal_action
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(wake_id) DO UPDATE SET
					scratchpad_json=excluded.scratchpad_json,
					investigations_json=excluded.investigations_json,
					final_message=excluded.final_message,
					cited_ids_json=excluded.cited_ids_json,
					display_event_map_json=excluded.display_event_map_json,
					source_refs_json=excluded.source_refs_json,
					investigation_completed=excluded.investigation_completed,
					terminal_action=excluded.terminal_action`,
			)
			.run(
				ctx.wakeId,
				ctx.sessionKey,
				ctx.nowUtc.toISOString(),
				JSON.stringify(scratchpad),
				JSON.stringify(investigations),
				ctx.finalMessage,
				JSON.stringify(ctx.citedItemIds),
				JSON.stringify(ctx.displayEventMap),
				JSON.stringify(ctx.sourceRefs),
				ctx.investigationCompleted ? 1 : 0,
				ctx.terminalAction,
			);
	}

	get(wakeId: string): Record<string, unknown> | undefined {
		return this.db.prepare(`SELECT * FROM wake_runs WHERE wake_id = ?`).get(wakeId) as
			| Record<string, unknown>
			| undefined;
	}

	recordObservation(options: {
		wakeId: string;
		sessionKey: string;
		kind: string;
		now: Date;
		trigger: Record<string, unknown>;
		candidates: unknown[];
		llmInput: unknown[];
	}): void {
		this.db
			.prepare(
				`INSERT INTO wake_observations(
					wake_id, session_key, kind, now_utc, trigger_json, candidates_json, llm_input_json
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				options.wakeId,
				options.sessionKey,
				options.kind,
				options.now.toISOString(),
				JSON.stringify(options.trigger),
				JSON.stringify(options.candidates),
				JSON.stringify(options.llmInput),
			);
	}

	observations(kind?: string): Array<Record<string, unknown>> {
		const rows = kind
			? (this.db.prepare(`SELECT * FROM wake_observations WHERE kind = ? ORDER BY id`).all(kind) as unknown[])
			: (this.db.prepare(`SELECT * FROM wake_observations ORDER BY id`).all() as unknown[]);
		return rows as Array<Record<string, unknown>>;
	}

	// ------------------------------------------------------------------
	// 蓄水池(reservoir)
	// ------------------------------------------------------------------

	ingest(kind: string, events: WakeEvent[], now: Date): number {
		return this.ingestWithIds(kind, events, now).length;
	}

	ingestWithIds(kind: string, events: WakeEvent[], now: Date): string[] {
		// 整批一个事务(akashic ingest_with_ids 单 commit):事件入库与延后
		// 隔离区一起原子提交,中途异常全部回滚,不留半批。
		return this.withTransaction(() => {
			this.flushDeferredQuarantine();
			const insertedIds: string[] = [];
			for (const event of events) {
				const eventKind = String(event.kind ?? kind).trim();
				if (eventKind !== kind) {
					this.writeQuarantine({
						sourceId: String(event.ackSourceId ?? event._source ?? "unknown"),
						itemId: String(event.eventId ?? event.id ?? stableQuarantineId(kind, event)),
						reason: `kind 与目标 channel 不匹配: ${eventKind} != ${kind}`,
						payload: event,
					});
					continue;
				}
				const ackSourceId = String(event.ackSourceId ?? event._source ?? "").trim();
				const originalSourceId = String(event.sourceId ?? event.source ?? event.source_name ?? ackSourceId).trim();
				const sourceEventId = String(event.eventId ?? event.id ?? "").trim();
				if (!ackSourceId || !originalSourceId || !sourceEventId) {
					this.writeQuarantine({
						sourceId: ackSourceId || originalSourceId || "unknown",
						itemId: sourceEventId || stableQuarantineId(kind, event),
						reason: "缺少 source/event identity",
						payload: event,
					});
					continue;
				}
				const itemId = `${ackSourceId}:${sourceEventId}`;
				const tombstone = this.db.prepare(`SELECT 1 FROM reservoir_tombstones WHERE identity = ?`).get(itemId);
				if (tombstone) continue;
				const payload = { ...event, id: itemId, item_id: itemId };
				const scoreValue = event.preprocessScore ?? event.rank_score ?? 0;
				const score = Number(scoreValue);
				if (!Number.isFinite(score) || score < 0 || score > 1) {
					this.writeQuarantine({
						sourceId: ackSourceId,
						itemId,
						reason: "score 超出 [0,1] 或非 finite",
						payload: event,
					});
					continue;
				}
				let timestampInvalid: string | null = null;
				for (const field of ["publishedAt", "triggeredAt", "firstSeenAt"]) {
					const value = event[field];
					if (value === null || value === undefined || value === "") continue;
					try {
						event[field] = normalizeReservoirTimestamp(value, field, now);
					} catch (error) {
						timestampInvalid = formatStateError(error);
						break;
					}
				}
				if (timestampInvalid !== null) {
					this.writeQuarantine({
						sourceId: ackSourceId,
						itemId,
						reason: timestampInvalid,
						payload: event,
					});
					continue;
				}
				const publishedAt = String(event.publishedAt ?? event.triggeredAt ?? "");
				const existing = this.db.prepare(`SELECT 1 FROM reservoir_events WHERE item_id = ?`).get(itemId);
				this.db
					.prepare(
						`INSERT INTO reservoir_events(
							item_id, kind, source_id, original_source_id, ack_source_id,
							source_event_id, published_at, first_seen_at, preprocess_score, payload_json, status
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT(item_id) DO UPDATE SET
							original_source_id=excluded.original_source_id,
							ack_source_id=excluded.ack_source_id,
							published_at=excluded.published_at,
							preprocess_score=excluded.preprocess_score,
							payload_json=excluded.payload_json,
							status=reservoir_events.status`,
					)
					.run(
						itemId,
						kind,
						ackSourceId,
						originalSourceId,
						ackSourceId,
						sourceEventId,
						publishedAt,
						now.toISOString(),
						score,
						JSON.stringify(payload),
						"unread",
					);
				if (!existing) insertedIds.push(itemId);
			}
			return insertedIds;
		});
	}

	unread(kind: string, limit?: number): Array<Record<string, unknown>> {
		const rows =
			limit === undefined
				? (this.db
						.prepare(
							`SELECT * FROM reservoir_events WHERE kind = ? AND status = 'unread'
					 ORDER BY original_source_id ASC, published_at DESC, first_seen_at DESC`,
						)
						.all(kind) as Array<Record<string, unknown>>)
				: (this.db
						.prepare(
							`SELECT * FROM reservoir_events WHERE kind = ? AND status = 'unread'
					 ORDER BY original_source_id ASC, published_at DESC, first_seen_at DESC LIMIT ?`,
						)
						.all(kind, Math.max(0, limit)) as Array<Record<string, unknown>>);
		return rows.map((row) => {
			const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
			payload.id = row.item_id;
			payload.item_id = row.item_id;
			payload._reservoir_original_source_id = row.original_source_id;
			payload._reservoir_ack_source_id = row.ack_source_id;
			payload._reservoir_source_id = row.original_source_id;
			payload._reservoir_source_event_id = row.source_event_id;
			payload.published_at = String(row.published_at ?? "");
			payload.first_seen_at = String(row.first_seen_at ?? "");
			payload.preprocess_score = row.preprocess_score;
			if (row.embedding_json) payload._event_embedding = JSON.parse(String(row.embedding_json));
			return payload;
		});
	}

	unreadCount(kind: string): number {
		const row = this.db
			.prepare(`SELECT count(*) AS count FROM reservoir_events WHERE kind = ? AND status = 'unread'`)
			.get(kind) as {
			count: number;
		};
		return row.count;
	}

	/** 带时间衰减的旧池总分(akashic unread_aggregate_mass,36h 半衰期)。 */
	unreadAggregateMass(kind: string, now: Date): number {
		const row = this.db
			.prepare(
				`SELECT coalesce(sum(
					-ln(max(1e-9, 1.0 - preprocess_score))
					* exp(
						-0.6931471805599453
						* max(0.0, julianday(?) - julianday(coalesce(nullif(published_at, ''), first_seen_at)))
						* 24.0 / 36.0
					)
				), 0.0) AS mass
				FROM reservoir_events
				WHERE kind = ? AND status IN ('unread', 'pending_expiry')`,
			)
			.get(now.toISOString(), kind) as { mass: number };
		return row.mass;
	}

	expiryCandidates(kind: string, before: Date, limit = 256): Array<Record<string, unknown>> {
		return this.db
			.prepare(
				`SELECT item_id, original_source_id, ack_source_id, source_event_id,
					published_at, first_seen_at, preprocess_score
				FROM reservoir_events
				WHERE kind = ? AND status = 'unread' AND first_seen_at <= ?
				ORDER BY first_seen_at ASC LIMIT ?`,
			)
			.all(kind, before.toISOString(), Math.max(0, limit)) as Array<Record<string, unknown>>;
	}

	// ------------------------------------------------------------------
	// 隔离区 / 墓碑
	// ------------------------------------------------------------------

	recordQuarantine(options: {
		sourceId: string;
		itemId: string;
		reason: string;
		payload: unknown;
		commit?: boolean;
	}): void {
		const { sourceId, itemId, reason, payload, commit } = options;
		if (commit === false) {
			// 延后到下一个批量 ingest 事务统一落库(akashic record_quarantine(commit=False))。
			this.deferredQuarantine.push({ sourceId, itemId, reason, payload });
			return;
		}
		this.writeQuarantine({ sourceId, itemId, reason, payload });
	}

	/** 立即写入一条隔离区记录(含 per-source/global cap 清理)。 */
	private writeQuarantine(options: { sourceId: string; itemId: string; reason: string; payload: unknown }): void {
		const { sourceId, itemId, reason, payload } = options;
		const identity = `${sourceId}:${itemId}`;
		const now = this.clock.now().toISOString();
		let payloadJson = JSON.stringify(payload ?? {}, (_, value) => (typeof value === "string" ? value : value));
		if (Buffer.byteLength(payloadJson, "utf-8") > QUARANTINE_PAYLOAD_BYTES) {
			const previewBudget = Math.max(0, QUARANTINE_PAYLOAD_BYTES - 96);
			const preview = payloadJson.slice(0, previewBudget);
			payloadJson = JSON.stringify({ truncated: true, preview });
		}
		this.db
			.prepare(
				`INSERT INTO reservoir_quarantine(
					identity, source_id, item_id, reason, payload_json, first_seen_at, last_seen_at, occurrences
				) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
				ON CONFLICT(identity) DO UPDATE SET
					reason=excluded.reason,
					payload_json=excluded.payload_json,
					last_seen_at=excluded.last_seen_at,
					occurrences=reservoir_quarantine.occurrences + 1`,
			)
			.run(identity, sourceId, itemId, reason, payloadJson, now, now);
		this.db
			.prepare(
				`DELETE FROM reservoir_quarantine WHERE source_id = ? AND identity NOT IN (
					SELECT identity FROM reservoir_quarantine WHERE source_id = ? ORDER BY last_seen_at DESC LIMIT ?
				)`,
			)
			.run(sourceId, sourceId, QUARANTINE_PER_SOURCE_CAP);
		this.db
			.prepare(
				`DELETE FROM reservoir_quarantine WHERE identity NOT IN (
					SELECT identity FROM reservoir_quarantine ORDER BY last_seen_at DESC LIMIT ?
				)`,
			)
			.run(QUARANTINE_GLOBAL_CAP);
	}

	/** 在批量 ingest 事务内落库延后的隔离区记录。 */
	flushDeferredQuarantine(): void {
		if (this.deferredQuarantine.length === 0) return;
		for (const entry of this.deferredQuarantine.splice(0)) {
			this.writeQuarantine(entry);
		}
	}

	quarantined(limit = 100): Array<Record<string, unknown>> {
		return this.db
			.prepare(`SELECT * FROM reservoir_quarantine ORDER BY last_seen_at DESC LIMIT ?`)
			.all(Math.max(0, limit)) as Array<Record<string, unknown>>;
	}

	consume(itemIds: string[], now: Date): void {
		if (itemIds.length === 0) return;
		// 事务内执行:rowcount 不匹配抛错时回滚(akashic consume rollback 语义)。
		this.withTransaction(() => {
			const unique = [...new Set(itemIds)];
			const placeholders = unique.map(() => "?").join(",");
			const result = this.db
				.prepare(
					`UPDATE reservoir_events SET status = 'consumed', consumed_at = ? WHERE item_id IN (${placeholders})`,
				)
				.run(now.toISOString(), ...unique);
			if (result.changes !== unique.length) {
				throw new Error("wake reservoir consume did not match every canonical item_id");
			}
		});
	}

	expire(itemIds: string[], now: Date): void {
		if (itemIds.length === 0) return;
		this.withTransaction(() => {
			const placeholders = itemIds.map(() => "?").join(",");
			this.db
				.prepare(
					`UPDATE reservoir_events SET status = 'expired', consumed_at = ? WHERE item_id IN (${placeholders})`,
				)
				.run(now.toISOString(), ...itemIds);
		});
	}

	consumeAndQueueAck(options: { itemIds: string[]; acknowledgements: Record<string, string[]>; now: Date }): void {
		this.withTransaction(() => {
			const { itemIds, acknowledgements, now } = options;
			const uniqueItemIds = [...new Set(itemIds.filter((itemId) => itemId.length > 0))];
			if (uniqueItemIds.length > 0) {
				const placeholders = uniqueItemIds.map(() => "?").join(",");
				this.db
					.prepare(
						`UPDATE reservoir_events SET status = 'consumed', consumed_at = ?
						 WHERE item_id IN (${placeholders}) AND status != 'pending_expiry'`,
					)
					.run(now.toISOString(), ...uniqueItemIds);
			}
			for (const [sourceId, eventIds] of Object.entries(acknowledgements)) {
				for (const eventId of [...new Set(eventIds)]) {
					const item = this.db
						.prepare(`SELECT item_id FROM reservoir_events WHERE ack_source_id = ? AND source_event_id = ?`)
						.get(sourceId, eventId) as { item_id: string } | undefined;
					if (!item) continue;
					this.queuePendingAck(sourceId, eventId, item.item_id, "consume", now);
				}
			}
		});
	}

	queueExpiration(itemIds: string[], now: Date): void {
		const unique = [...new Set(itemIds)];
		if (unique.length === 0) return;
		this.withTransaction(() => {
			const placeholders = unique.map(() => "?").join(",");
			const rows = this.db
				.prepare(
					`SELECT item_id, ack_source_id, source_event_id FROM reservoir_events
					 WHERE item_id IN (${placeholders}) AND status IN ('unread', 'consumed', 'pending_expiry')`,
				)
				.all(...unique) as Array<Record<string, unknown>>;
			for (const row of rows) {
				if (!String(row.ack_source_id ?? "")) continue;
				this.db
					.prepare(
						`UPDATE reservoir_events SET status = 'pending_expiry'
						 WHERE item_id = ? AND status IN ('unread', 'consumed', 'pending_expiry')`,
					)
					.run(String(row.item_id));
				this.queuePendingAck(
					String(row.ack_source_id),
					String(row.source_event_id),
					String(row.item_id),
					"expire",
					now,
				);
			}
		});
	}

	private queuePendingAck(sourceId: string, eventId: string, itemId: string, action: string, queuedAt: Date): void {
		const existing = this.db
			.prepare(
				`SELECT action FROM pending_acknowledgements WHERE source_id = ? AND source_event_id = ? AND item_id = ?`,
			)
			.get(sourceId, eventId, itemId) as { action: string } | undefined;
		if (existing !== undefined) {
			if (existing.action === "expire" || action === "consume") return;
			this.db
				.prepare(
					`UPDATE pending_acknowledgements SET action = 'expire', queued_at = ?
					 WHERE source_id = ? AND source_event_id = ? AND item_id = ?`,
				)
				.run(queuedAt.toISOString(), sourceId, eventId, itemId);
			return;
		}
		this.db
			.prepare(
				`INSERT INTO pending_acknowledgements(source_id, source_event_id, item_id, action, queued_at)
				 VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
			)
			.run(sourceId, eventId, itemId, action, queuedAt.toISOString());
	}

	pendingAcknowledgements(): Record<string, string[]> {
		const rows = this.db
			.prepare(
				`SELECT source_id, source_event_id FROM pending_acknowledgements ORDER BY queued_at, source_id, source_event_id`,
			)
			.all() as Array<Record<string, unknown>>;
		const grouped: Record<string, string[]> = {};
		for (const row of rows) {
			const sourceId = String(row.source_id);
			if (!grouped[sourceId]) grouped[sourceId] = [];
			grouped[sourceId]!.push(String(row.source_event_id));
		}
		return grouped;
	}

	pendingAcknowledgementBatches(): Array<{
		source_id: string;
		source_event_id: string;
		item_id: string;
		action: string;
		queued_at: string;
	}> {
		return this.db
			.prepare(
				`SELECT source_id, source_event_id, item_id, action, queued_at
				 FROM pending_acknowledgements
				 ORDER BY queued_at, source_id, source_event_id, item_id`,
			)
			.all() as Array<{
			source_id: string;
			source_event_id: string;
			item_id: string;
			action: string;
			queued_at: string;
		}>;
	}

	markAcknowledged(sourceId: string, eventIds: string[]): void {
		if (eventIds.length === 0) return;
		this.withTransaction(() => {
			const uniqueEventIds = [...new Set(eventIds)];
			const placeholders = uniqueEventIds.map(() => "?").join(",");
			const rows = this.db
				.prepare(
					`SELECT source_id, source_event_id, item_id, action FROM pending_acknowledgements
					 WHERE source_id = ? AND source_event_id IN (${placeholders})`,
				)
				.all(sourceId, ...uniqueEventIds) as Array<Record<string, unknown>>;
			for (const row of rows) {
				if (row.action !== "expire" || !String(row.item_id ?? "")) continue;
				const itemId = String(row.item_id);
				this.db
					.prepare(
						`INSERT INTO reservoir_tombstones(identity, source_id, source_event_id, acknowledged_at)
						 VALUES (?, ?, ?, ?)
						 ON CONFLICT(identity) DO UPDATE SET acknowledged_at=excluded.acknowledged_at`,
					)
					.run(
						itemId,
						String(row.source_id ?? sourceId),
						String(row.source_event_id),
						this.clock.now().toISOString(),
					);
				this.db.prepare(`DELETE FROM reservoir_events WHERE item_id = ? AND status = 'pending_expiry'`).run(itemId);
			}
			this.db
				.prepare(
					`DELETE FROM pending_acknowledgements WHERE source_id = ? AND source_event_id IN (${placeholders})`,
				)
				.run(sourceId, ...uniqueEventIds);
			const cutoff = new Date(this.clock.nowMs() - TOMBSTONE_RETENTION_MS).toISOString();
			this.db.prepare(`DELETE FROM reservoir_tombstones WHERE acknowledged_at < ?`).run(cutoff);
			this.db
				.prepare(
					`DELETE FROM reservoir_tombstones WHERE identity NOT IN (
						SELECT identity FROM reservoir_tombstones ORDER BY acknowledged_at DESC LIMIT ?
					)`,
				)
				.run(TOMBSTONE_GLOBAL_CAP);
		});
	}

	private withTransaction<T>(operation: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// Preserve the original reservoir error.
			}
			throw error;
		}
	}

	// ------------------------------------------------------------------
	// 嵌入
	// ------------------------------------------------------------------

	unembedded(limit = 64): Array<{ itemId: string; text: string }> {
		const rows = this.db
			.prepare(
				`SELECT item_id, payload_json FROM reservoir_events
				 WHERE kind = 'content' AND status = 'unread' AND embedding_json IS NULL
				 ORDER BY first_seen_at ASC LIMIT ?`,
			)
			.all(limit) as Array<Record<string, unknown>>;
		const result: Array<{ itemId: string; text: string }> = [];
		for (const row of rows) {
			const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
			const text = [String(payload.title ?? "").trim(), String(payload.content ?? payload.body ?? "").trim()]
				.filter(Boolean)
				.join("\n");
			if (text) result.push({ itemId: String(row.item_id), text });
		}
		return result;
	}

	saveEventEmbeddings(itemIds: string[], embeddings: number[][]): void {
		for (const [index, itemId] of itemIds.entries()) {
			this.db
				.prepare(`UPDATE reservoir_events SET embedding_json = ? WHERE item_id = ?`)
				.run(JSON.stringify(embeddings[index] ?? []), itemId);
		}
	}

	// ------------------------------------------------------------------
	// Hazard
	// ------------------------------------------------------------------

	loadHazard(sessionKey: string): Record<string, unknown> | undefined {
		return this.db.prepare(`SELECT * FROM hazard_state WHERE session_key = ?`).get(sessionKey) as
			| Record<string, unknown>
			| undefined;
	}

	saveHazard(options: {
		sessionKey: string;
		hazard: number;
		threshold: number;
		updatedAt: Date;
		lastWakeAt: Date | null;
	}): void {
		this.db
			.prepare(
				`INSERT INTO hazard_state(session_key, hazard, threshold, updated_at, last_wake_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(session_key) DO UPDATE SET
					hazard=excluded.hazard, threshold=excluded.threshold,
					updated_at=excluded.updated_at, last_wake_at=excluded.last_wake_at`,
			)
			.run(
				options.sessionKey,
				options.hazard,
				options.threshold,
				options.updatedAt.toISOString(),
				options.lastWakeAt ? options.lastWakeAt.toISOString() : null,
			);
	}

	saveHazardMonitor(options: {
		sessionKey: string;
		hazard: HazardResult;
		candidateCount: number;
		evaluatedAt: Date;
	}): void {
		this.db
			.prepare(
				`INSERT INTO hazard_monitor(
					session_key, hazard_before, hazard_after, preference_pressure,
					threshold, evidence, rate, driver_item_id, candidate_count, should_wake, evaluated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(session_key) DO UPDATE SET
					hazard_before=excluded.hazard_before, hazard_after=excluded.hazard_after,
					preference_pressure=excluded.preference_pressure, threshold=excluded.threshold,
					evidence=excluded.evidence, rate=excluded.rate,
					driver_item_id=excluded.driver_item_id, candidate_count=excluded.candidate_count,
					should_wake=excluded.should_wake, evaluated_at=excluded.evaluated_at`,
			)
			.run(
				options.sessionKey,
				options.hazard.hazardBefore,
				options.hazard.hazardAfter,
				options.hazard.preferencePressure,
				options.hazard.threshold,
				options.hazard.evidence,
				options.hazard.rate,
				options.hazard.driverItemId,
				options.candidateCount,
				options.hazard.shouldWake ? 1 : 0,
				options.evaluatedAt.toISOString(),
			);
	}

	loadHazardMonitor(sessionKey: string): Record<string, unknown> | undefined {
		return this.db.prepare(`SELECT * FROM hazard_monitor WHERE session_key = ?`).get(sessionKey) as
			| Record<string, unknown>
			| undefined;
	}

	// ------------------------------------------------------------------
	// Context
	// ------------------------------------------------------------------

	ingestContext(snapshots: WakeEvent[], now: Date): ContextDriveResult[] {
		const results: ContextDriveResult[] = [];
		for (const snapshot of snapshots) {
			const sourceId = String(snapshot._source ?? snapshot.sourceId ?? "").trim();
			if (!sourceId) continue;
			const previous = this.loadContext(sourceId);
			const result = evaluateContext(snapshot as unknown as Record<string, unknown>, { previous });
			const context = result.context;
			this.db
				.prepare(
					`INSERT INTO context_state(
						source_id, payload_json, presence, interruptibility,
						confidence, transition_name, observed_at, expires_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(source_id) DO UPDATE SET
						payload_json=excluded.payload_json, presence=excluded.presence,
						interruptibility=excluded.interruptibility, confidence=excluded.confidence,
						transition_name=excluded.transition_name, observed_at=excluded.observed_at,
						expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
				)
				.run(
					sourceId,
					JSON.stringify(snapshot),
					context.presence,
					context.interruptibility,
					context.confidence,
					context.transition,
					context.observedAt ? context.observedAt.toISOString() : null,
					context.expiresAt ? context.expiresAt.toISOString() : null,
					now.toISOString(),
				);
			results.push(result);
		}
		return results;
	}

	loadContext(sourceId: string): NormalizedContext | null {
		const row = this.db.prepare(`SELECT * FROM context_state WHERE source_id = ?`).get(sourceId) as
			| Record<string, unknown>
			| undefined;
		return row ? decodeContextRow(row) : null;
	}

	listContexts(): NormalizedContext[] {
		const rows = this.db.prepare(`SELECT * FROM context_state ORDER BY source_id`).all() as Array<
			Record<string, unknown>
		>;
		return rows.map(decodeContextRow);
	}

	claimContextReevaluation(now: Date, minIntervalSeconds = 3 * 3600): boolean {
		const row = this.db.prepare(`SELECT * FROM context_reevaluate_state WHERE singleton = 1`).get() as
			| Record<string, unknown>
			| undefined;
		const lastSignaledAt = row ? parseOptionalTime(row.last_signaled_at as string | null) : null;
		const elapsed = lastSignaledAt !== null ? (now.getTime() - lastSignaledAt.getTime()) / 1000 : null;
		const allowed = elapsed === null || elapsed < 0 || elapsed >= minIntervalSeconds;
		this.db
			.prepare(
				`INSERT INTO context_reevaluate_state(singleton, last_signaled_at, last_candidate_at, suppressed_count)
				 VALUES (1, ?, ?, ?)
				 ON CONFLICT(singleton) DO UPDATE SET
					last_signaled_at=coalesce(excluded.last_signaled_at, context_reevaluate_state.last_signaled_at),
					last_candidate_at=excluded.last_candidate_at,
					suppressed_count=context_reevaluate_state.suppressed_count + ?`,
			)
			.run(allowed ? now.toISOString() : null, now.toISOString(), allowed ? 0 : 1, allowed ? 0 : 1);
		return allowed;
	}

	contextReevaluationState(): Record<string, unknown> | undefined {
		return this.db.prepare(`SELECT * FROM context_reevaluate_state WHERE singleton = 1`).get() as
			| Record<string, unknown>
			| undefined;
	}

	// ------------------------------------------------------------------
	// Drift 定时器
	//
	// 注意:drift_state.timer_anchor / next_attempt_at 是 akashic
	// wake drift_state 表的对齐列。cogito 三进程架构下,drift 的一次性
	// 到期采样与 drive 调度在 drift daemon 进程执行(数学与 akashic
	// _decide_drift/_schedule_drift_attempt 等价,@cogito/gate/drive.ts
	// 的 advanceDriftDrive/sampleDriftDelayHours),wake 侧只通过
	// drift_gate 许可门控,因此这两列保留表结构但不再写入。
	// ------------------------------------------------------------------

	loadDrift(sessionKey: string): Record<string, unknown> | undefined {
		return this.db.prepare(`SELECT * FROM drift_state WHERE session_key = ?`).get(sessionKey) as
			| Record<string, unknown>
			| undefined;
	}

	saveDriftTimer(options: { sessionKey: string; timerAnchor: string; nextAttemptAt: Date; updatedAt: Date }): void {
		this.db
			.prepare(
				`INSERT INTO drift_state(session_key, hazard, threshold, updated_at, timer_anchor, next_attempt_at)
				 VALUES (?, 0, 0, ?, ?, ?)
				 ON CONFLICT(session_key) DO UPDATE SET
					hazard=0, threshold=0, updated_at=excluded.updated_at,
					timer_anchor=excluded.timer_anchor, next_attempt_at=excluded.next_attempt_at`,
			)
			.run(
				options.sessionKey,
				options.updatedAt.toISOString(),
				options.timerAnchor,
				options.nextAttemptAt.toISOString(),
			);
	}

	recordDriftObservation(options: { sessionKey: string; now: Date; threshold: number }): void {
		this.db
			.prepare(
				`INSERT INTO drift_state(session_key, hazard, threshold, updated_at, last_drift_at)
				 VALUES (?, 0, ?, ?, ?)
				 ON CONFLICT(session_key) DO UPDATE SET
					hazard=0, threshold=excluded.threshold, updated_at=excluded.updated_at,
					last_drift_at=excluded.last_drift_at, timer_anchor=NULL, next_attempt_at=NULL`,
			)
			.run(options.sessionKey, options.threshold, options.now.toISOString(), options.now.toISOString());
	}

	recordDriftSuccess(options: { sessionKey: string; now: Date; fingerprint: string }): void {
		const previous = this.loadDrift(options.sessionKey) ?? {};
		const repeatCount =
			options.fingerprint && options.fingerprint === String(previous.last_fingerprint ?? "")
				? (Number(previous.repeat_count ?? 0) || 0) + 1
				: 0;
		this.db
			.prepare(
				`INSERT INTO drift_state(session_key, hazard, threshold, updated_at, last_drift_at, last_fingerprint, repeat_count)
				 VALUES (?, 0, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_key) DO UPDATE SET
					hazard=0, threshold=excluded.threshold, updated_at=excluded.updated_at,
					last_drift_at=excluded.last_drift_at, timer_anchor=NULL, next_attempt_at=NULL,
					last_fingerprint=excluded.last_fingerprint, repeat_count=excluded.repeat_count`,
			)
			.run(
				options.sessionKey,
				Number(previous.threshold ?? 0.8) || 0.8,
				options.now.toISOString(),
				options.now.toISOString(),
				options.fingerprint,
				repeatCount,
			);
	}

	close(): void {
		this.db.close();
	}
}

function normalizeReservoirTimestamp(value: unknown, field: string, now: Date): string | number {
	let normalized: string | number;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${field} 不是有效 timestamp`);
		normalized = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
	} else if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
			throw new Error(`${field} 必须是带 timezone 的 ISO timestamp`);
		}
		normalized = trimmed;
	} else {
		throw new Error(`${field} 不是 ISO timestamp 或 number`);
	}
	const parsed = new Date(normalized).getTime();
	if (!Number.isFinite(parsed)) throw new Error(`${field} 不是有效 timestamp`);
	if (parsed > now.getTime() + MAX_FUTURE_TIMESTAMP_SKEW_MS) throw new Error(`${field} 超过 future skew`);
	return normalized;
}

function formatStateError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
