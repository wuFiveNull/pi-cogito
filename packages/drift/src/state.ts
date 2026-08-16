/**
 * Drift state store — drift/drift.db (akashic plugins/drift_flow/state.py port).
 *
 * Persists runs, skill continuum (run_count / last_status / last_briefing /
 * scratchpad / cursor), skill journal (append-only completed facts),
 * self_state (previous intention + loose next_tendency), self_observation
 * journal, global note and step logs.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type DriftOutboundAttachment, type DriftStagedDelivery, DriftStagedDeliveryStore } from "@cogito/gate";
import { parse as parseYaml } from "yaml";

export interface SkillMeta {
	name: string;
	description: string;
	lastRunAt: string | null;
	runCount: number;
	status: string;
	next: string;
	requiresMcp: string[];
	builtin: boolean;
	/** frontmatter cooldown_hours:两次运行最小间隔;0/缺省不限。 */
	cooldownHours: number;
	/** frontmatter max_runs_per_day:当日运行上限;0/缺省不限。 */
	maxRunsPerDay: number;
	/** frontmatter time_window:"HH:MM-HH:MM" 可选时段;空不限。 */
	timeWindow: string;
	/** SKILL.md 内容自上次 finish 后是否变化(供 [skill-updated] 标注)。 */
	skillUpdated: boolean;
}

export interface DriftStateStoreOptions {
	driftDir: string;
	builtinSkillsDir?: string;
	includeBuiltinSkills?: boolean;
	builtinSkillNames?: string[];
	pluginSkillRoots?: string[];
}

export type DriftRunStage =
	| "started"
	| "selected"
	| "executing"
	| "message_staged"
	| "finishing"
	| "finished"
	| "delivery_pending"
	| "delivery_committed"
	| "failed";

const DRIFT_RUN_STAGES = new Set<DriftRunStage>([
	"started",
	"selected",
	"executing",
	"message_staged",
	"finishing",
	"finished",
	"delivery_pending",
	"delivery_committed",
	"failed",
]);

export interface DriftRunLease {
	runId: string;
	sessionKey: string;
	startedAt: string;
}

export interface DriftActiveRunRecord {
	runId: string;
	sessionKey: string;
	startedAt: string;
	updatedAt: string;
	stage: DriftRunStage;
	skillName: string;
	messageHash: string | null;
}

export interface DriftRunStepRecord {
	id: number;
	runId: number | null;
	runKey: string | null;
	stepIndex: number;
	toolName: string;
	inputPreview: string;
	outputPreview: string;
	createdAt: string;
}

export interface DriftRunDiagnostics {
	run: Record<string, unknown> | null;
	active: DriftActiveRunRecord | null;
	steps: DriftRunStepRecord[];
}

export interface DriftRetentionOptions {
	/** Delete terminal runs older than this many days. */
	maxAgeDays?: number;
	/** Keep at most this many newest terminal runs. Staged runs are protected. */
	maxRuns?: number;
	nowUtc?: Date;
}

export interface DriftRetentionResult {
	runsDeleted: number;
	runStepsDeleted: number;
	journalEntriesDeleted: number;
}

export class DriftRunAlreadyActiveError extends Error {
	readonly sessionKey: string;
	readonly activeRunId: string;

	constructor(sessionKey: string, activeRunId: string) {
		super(`drift run already active for session ${sessionKey}: ${activeRunId}`);
		this.name = "DriftRunAlreadyActiveError";
		this.sessionKey = sessionKey;
		this.activeRunId = activeRunId;
	}
}

function clip(text: string, limit: number): string {
	return (text ?? "").trim().slice(0, limit);
}

function parseIso(raw: string | null | undefined): Date | null {
	if (!raw) return null;
	const parsed = Date.parse(String(raw));
	return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function _timestampMs(raw: unknown): number {
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	const parsed = Date.parse(String(raw ?? ""));
	return Number.isFinite(parsed) ? parsed : 0;
}

/** paused 超过该天数视为 stale-paused(selection context 标注)。 */
export const STALE_PAUSED_DAYS = 3;
/** run_steps 中 error 输出占比超过该值视为 flaky。 */
export const FLAKY_ERROR_RATIO = 0.3;

/** 步骤输出是否为错误(工具返回 {"error":...} 或阶段约束拒绝文案)。 */
function isErrorStep(output: string): boolean {
	const text = String(output ?? "").trim();
	return text.startsWith('{"error":') || text.startsWith("错误：");
}

function normalizeStatus(raw: unknown): string {
	const status = String(raw ?? "").trim();
	return status === "completed" || status === "paused" || status === "idle" ? status : "idle";
}

function normalizeRetentionNumber(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeRetentionCount(value: number | undefined): number | undefined {
	const normalized = normalizeRetentionNumber(value);
	return normalized === undefined ? undefined : Math.floor(normalized);
}

function normalizeRunStage(raw: unknown): DriftRunStage {
	const stage = String(raw ?? "");
	return DRIFT_RUN_STAGES.has(stage as DriftRunStage) ? (stage as DriftRunStage) : "started";
}

/** Parse the YAML frontmatter block of a SKILL.md (name/description/requires_mcp). */
function parseSkillFrontmatter(content: string): Record<string, unknown> {
	const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(content);
	if (!match) return {};
	try {
		const parsed = parseYaml(match[1] ?? "") as unknown;
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function decodeJsonObject(raw: unknown): Record<string, unknown> {
	if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	try {
		const data = JSON.parse(String(raw ?? "{}")) as unknown;
		return data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function mergeCursor(
	oldCursor: Record<string, unknown>,
	cursorUpdate: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
	const merged = { ...oldCursor };
	if (!cursorUpdate) return merged;
	for (const [key, value] of Object.entries(cursorUpdate)) {
		if (value === null) {
			delete merged[key];
		} else {
			merged[key] = value;
		}
	}
	return merged;
}

const SCHEMA = `
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

CREATE TABLE IF NOT EXISTS skill_continuum (
	skill_name TEXT PRIMARY KEY,
	run_count INTEGER NOT NULL DEFAULT 0,
	last_run_at TEXT,
	last_status TEXT NOT NULL DEFAULT 'idle',
	last_briefing TEXT NOT NULL DEFAULT '',
	scratchpad TEXT NOT NULL DEFAULT '',
	cursor_json TEXT NOT NULL DEFAULT '{}',
	skill_hash TEXT,
	updated_at TEXT
);

CREATE TABLE IF NOT EXISTS skill_journal (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	skill_name TEXT NOT NULL,
	entry_type TEXT NOT NULL,
	key TEXT NOT NULL DEFAULT '',
	payload_json TEXT NOT NULL DEFAULT '{}',
	run_id INTEGER,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_journal_skill_type_key
	ON skill_journal(skill_name, entry_type, key);
CREATE INDEX IF NOT EXISTS idx_skill_journal_run_id
	ON skill_journal(run_id);

CREATE TABLE IF NOT EXISTS global_note (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	content TEXT NOT NULL DEFAULT '',
	updated_at TEXT
);

CREATE TABLE IF NOT EXISTS self_state (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	current_skill TEXT NOT NULL DEFAULT '',
	current_intention TEXT NOT NULL DEFAULT '',
	last_decision TEXT NOT NULL DEFAULT '',
	decision_reason TEXT NOT NULL DEFAULT '',
	next_tendency TEXT NOT NULL DEFAULT '',
	updated_at TEXT
);

CREATE TABLE IF NOT EXISTS run_steps (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id INTEGER,
	run_key TEXT,
	step_index INTEGER NOT NULL,
	tool_name TEXT NOT NULL,
	input_preview TEXT NOT NULL DEFAULT '',
	output_preview TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drift_active_runs (
	run_id TEXT PRIMARY KEY,
	session_key TEXT NOT NULL UNIQUE,
	started_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	stage TEXT NOT NULL,
	skill_name TEXT NOT NULL DEFAULT '',
	message_hash TEXT,
	message TEXT NOT NULL DEFAULT '',
	media_json TEXT NOT NULL DEFAULT '[]',
	attachments_json TEXT NOT NULL DEFAULT '[]',
	target_channel TEXT NOT NULL DEFAULT '',
	target_chat_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_drift_active_runs_updated ON drift_active_runs(updated_at);

CREATE TABLE IF NOT EXISTS drift_observations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_key TEXT NOT NULL,
	kind TEXT NOT NULL,
	now_utc TEXT NOT NULL,
	payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_drift_observations_session_kind
	ON drift_observations(session_key, kind, id);

CREATE TABLE IF NOT EXISTS drift_repeat (
	session_key TEXT PRIMARY KEY,
	last_fingerprint TEXT NOT NULL DEFAULT '',
	repeat_count INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drift_timer (
	session_key TEXT PRIMARY KEY,
	timer_anchor TEXT NOT NULL,
	next_attempt_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
`;

export class DriftStateStore {
	readonly driftDir: string;
	readonly skillsDir: string;
	readonly dbFile: string;
	private readonly builtinSkillsDir: string | null;
	private readonly includeBuiltinSkills: boolean;
	private readonly builtinSkillNames: Set<string>;
	private readonly pluginSkillRoots: string[];
	private db: DatabaseSync | null = null;
	private lastSavedRunId: number | null = null;
	private stagedStore: DriftStagedDeliveryStore | null = null;

	constructor(options: DriftStateStoreOptions) {
		this.driftDir = options.driftDir;
		this.skillsDir = join(this.driftDir, "skills");
		this.dbFile = join(this.driftDir, "drift.db");
		this.builtinSkillsDir = options.builtinSkillsDir ?? null;
		this.includeBuiltinSkills = options.includeBuiltinSkills ?? false;
		this.builtinSkillNames = new Set(options.builtinSkillNames ?? []);
		this.pluginSkillRoots = options.pluginSkillRoots ?? [];
		mkdirSync(this.skillsDir, { recursive: true });
		this.ensureDb();
	}

	close(): void {
		this.db?.close();
		this.db = null;
		this.stagedStore?.close();
		this.stagedStore = null;
	}

	private conn(): DatabaseSync {
		this.db ??= new DatabaseSync(this.dbFile);
		return this.db;
	}

	/** Staged-delivery 读写委托(与 pi-gate 共享同一 drift.db)。 */
	private staged(): DriftStagedDeliveryStore {
		this.stagedStore ??= new DriftStagedDeliveryStore({ dbFile: this.dbFile });
		return this.stagedStore;
	}

	/** Staged messages that survived a crash before the host delivery commit. */
	listStagedDeliveries(limit = 20): DriftStagedDelivery[] {
		return this.staged().listStagedDeliveries(limit);
	}

	/** 投递后回写 runs 行(run_id 匹配时)。 */
	markRunDelivery(runId: string, deliveryId: number, status: string, error?: string): void {
		this.staged().markRunDelivery(runId, deliveryId, status, error);
	}

	/** 投递确认回写:按 message_hash 把 staged 更新为 sent,幂等。 */
	markRunMessageSent(messageHash: string): void {
		this.staged().markRunMessageSent(messageHash);
	}

	private ensureDb(): void {
		mkdirSync(dirname(this.dbFile), { recursive: true });
		this.conn().exec("PRAGMA busy_timeout = 5000");
		this.conn().exec("PRAGMA journal_mode = WAL");
		this.conn().exec(SCHEMA);
		const runCols = new Set(
			(this.conn().prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name),
		);
		for (const column of [
			["run_id", "TEXT"],
			["session_key", "TEXT NOT NULL DEFAULT 'local'"],
			["started_at", "TEXT"],
			["finished_at", "TEXT"],
			["message", "TEXT NOT NULL DEFAULT ''"],
			["media_json", "TEXT NOT NULL DEFAULT '[]'"],
			["attachments_json", "TEXT NOT NULL DEFAULT '[]'"],
			["target_channel", "TEXT NOT NULL DEFAULT ''"],
			["target_chat_id", "TEXT NOT NULL DEFAULT ''"],
			["delivery_id", "INTEGER"],
			["delivery_status", "TEXT"],
			["delivery_error", "TEXT"],
		] as const) {
			if (!runCols.has(column[0])) this.conn().exec(`ALTER TABLE runs ADD COLUMN ${column[0]} ${column[1]}`);
		}
		const stepCols = new Set(
			(this.conn().prepare("PRAGMA table_info(run_steps)").all() as Array<{ name: string }>).map((c) => c.name),
		);
		if (!stepCols.has("run_key")) this.conn().exec("ALTER TABLE run_steps ADD COLUMN run_key TEXT");
		const cols = new Set(
			(this.conn().prepare("PRAGMA table_info(skill_continuum)").all() as Array<{ name: string }>).map(
				(c) => c.name,
			),
		);
		if (!cols.has("cursor_json")) {
			this.conn().exec("ALTER TABLE skill_continuum ADD COLUMN cursor_json TEXT NOT NULL DEFAULT '{}'");
		}
		const migratedRunCols = new Set(
			(this.conn().prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name),
		);
		if (!migratedRunCols.has("message_hash")) {
			this.conn().exec("ALTER TABLE runs ADD COLUMN message_hash TEXT");
		}
		if (!cols.has("skill_hash")) {
			this.conn().exec("ALTER TABLE skill_continuum ADD COLUMN skill_hash TEXT");
		}
		if (!cols.has("updated_at")) {
			this.conn().exec("ALTER TABLE skill_continuum ADD COLUMN updated_at TEXT");
		}
		this.conn().exec("CREATE INDEX IF NOT EXISTS idx_runs_message_hash ON runs(message_hash)");
		this.conn().exec("CREATE INDEX IF NOT EXISTS idx_runs_run_id ON runs(run_id)");
		this.conn().exec("CREATE INDEX IF NOT EXISTS idx_run_steps_run_key ON run_steps(run_key)");
	}

	/** Claim one session for a Drift run. A second process receives a typed conflict. */
	startRun(options: { runId: string; sessionKey: string; nowUtc: Date; staleAfterMs?: number }): DriftRunLease {
		const runId = String(options.runId ?? "").trim();
		const sessionKey = String(options.sessionKey ?? "").trim();
		if (!runId || !sessionKey) throw new Error("drift run_id and session_key are required");
		this.recoverAbandonedRuns({
			nowUtc: options.nowUtc,
			staleAfterMs: Math.max(60_000, options.staleAfterMs ?? 30 * 60_000),
		});
		const now = options.nowUtc.toISOString();
		const db = this.conn();
		db.exec("BEGIN IMMEDIATE");
		try {
			const active = db.prepare("SELECT run_id FROM drift_active_runs WHERE session_key = ?").get(sessionKey) as
				| { run_id: string }
				| undefined;
			if (active) throw new DriftRunAlreadyActiveError(sessionKey, String(active.run_id));
			db.prepare(
				`INSERT INTO drift_active_runs (
					run_id, session_key, started_at, updated_at, stage
				) VALUES (?, ?, ?, ?, 'started')`,
			).run(runId, sessionKey, now, now);
			db.exec("COMMIT");
			return { runId, sessionKey, startedAt: now };
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// Preserve the original claim error.
			}
			throw error;
		}
	}

	/** Update the durable run snapshot used for crash recovery and diagnostics. */
	updateRunProgress(options: {
		runId: string;
		stage: DriftRunStage;
		nowUtc: Date;
		skillName?: string;
		messageHash?: string;
		message?: string;
		media?: readonly string[];
		attachments?: readonly DriftOutboundAttachment[];
		targetChannel?: string;
		targetChatId?: string;
	}): void {
		const current = this.conn().prepare("SELECT * FROM drift_active_runs WHERE run_id = ?").get(options.runId) as
			| Record<string, unknown>
			| undefined;
		if (!current) return;
		const value = (key: string, fallback: string): string => String(current[key] ?? fallback);
		const media = options.media ?? decodeStringArray(current.media_json);
		const attachments = options.attachments ?? decodeAttachments(current.attachments_json);
		this.conn()
			.prepare(
				`UPDATE drift_active_runs SET
					updated_at = ?, stage = ?, skill_name = ?, message_hash = ?, message = ?,
					media_json = ?, attachments_json = ?, target_channel = ?, target_chat_id = ?
				 WHERE run_id = ?`,
			)
			.run(
				options.nowUtc.toISOString(),
				options.stage,
				clip(options.skillName ?? value("skill_name", ""), 120),
				clip(options.messageHash ?? value("message_hash", ""), 128) || null,
				clip(options.message ?? value("message", ""), 20_000),
				JSON.stringify(media),
				JSON.stringify(attachments),
				clip(options.targetChannel ?? value("target_channel", ""), 120),
				clip(options.targetChatId ?? value("target_chat_id", ""), 240),
				options.runId,
			);
	}

	/** Release a lease after an unrecoverable runtime failure. */
	releaseActiveRun(runId: string): void {
		const key = String(runId ?? "").trim();
		if (!key) return;
		this.conn().prepare("DELETE FROM drift_active_runs WHERE run_id = ?").run(key);
	}

	/** Convert a process interruption into a resumable paused run. */
	recoverAbandonedRuns(options: { nowUtc: Date; staleAfterMs: number }): number {
		const cutoff = new Date(options.nowUtc.getTime() - Math.max(0, options.staleAfterMs)).toISOString();
		const db = this.conn();
		db.exec("BEGIN IMMEDIATE");
		try {
			const rows = db
				.prepare("SELECT * FROM drift_active_runs WHERE updated_at < ? ORDER BY updated_at ASC")
				.all(cutoff) as Array<Record<string, unknown>>;
			for (const row of rows) {
				const runId = String(row.run_id ?? "");
				const skillName = String(row.skill_name ?? "").trim() || "unknown";
				const message = String(row.message ?? "");
				const messageHash = String(row.message_hash ?? "").trim() || null;
				db.prepare(
					`INSERT INTO runs (
						run_id, session_key, run_at, started_at, finished_at, skill_name, status,
						briefing, message_result, message_hash, message, media_json, attachments_json,
						target_channel, target_chat_id, delivery_status
					) VALUES (?, ?, ?, ?, ?, ?, 'paused', ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
				).run(
					runId,
					String(row.session_key ?? "local"),
					String(row.started_at ?? options.nowUtc.toISOString()),
					String(row.started_at ?? options.nowUtc.toISOString()),
					options.nowUtc.toISOString(),
					skillName,
					"进程中断，已将本轮恢复为 paused；下次从持久化停点继续。",
					messageHash ? "staged" : "silent",
					messageHash,
					message,
					String(row.media_json ?? "[]"),
					String(row.attachments_json ?? "[]"),
					String(row.target_channel ?? ""),
					String(row.target_chat_id ?? ""),
				);
				const continuum = db
					.prepare("SELECT run_count, cursor_json, skill_hash FROM skill_continuum WHERE skill_name = ?")
					.get(skillName) as { run_count: number; cursor_json: string; skill_hash: string | null } | undefined;
				db.prepare(
					`INSERT INTO skill_continuum (
						skill_name, run_count, last_run_at, last_status, last_briefing,
						scratchpad, cursor_json, skill_hash, updated_at
					) VALUES (?, ?, ?, 'paused', ?, ?, ?, ?, ?)
					 ON CONFLICT(skill_name) DO UPDATE SET
						run_count = excluded.run_count,
						last_run_at = excluded.last_run_at,
						last_status = excluded.last_status,
						last_briefing = excluded.last_briefing,
						scratchpad = excluded.scratchpad,
						cursor_json = excluded.cursor_json,
						updated_at = excluded.updated_at`,
				).run(
					skillName,
					Number(continuum?.run_count ?? 0) + 1,
					String(row.started_at ?? options.nowUtc.toISOString()),
					"进程中断，已恢复为 paused。",
					"下次从进程中断前的持久化停点继续。",
					continuum?.cursor_json ?? "{}",
					continuum?.skill_hash ?? null,
					options.nowUtc.toISOString(),
				);
				db.prepare("DELETE FROM drift_active_runs WHERE run_id = ?").run(runId);
			}
			db.exec("COMMIT");
			return rows.length;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// Preserve the original recovery error.
			}
			throw error;
		}
	}

	/** Active leases and durable progress snapshots for diagnostics/monitoring. */
	listActiveRuns(limit = 20): DriftActiveRunRecord[] {
		const rows = this.conn()
			.prepare(
				`SELECT run_id, session_key, started_at, updated_at, stage, skill_name, message_hash
				 FROM drift_active_runs ORDER BY updated_at DESC LIMIT ?`,
			)
			.all(Math.max(1, Math.trunc(limit))) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			runId: String(row.run_id ?? ""),
			sessionKey: String(row.session_key ?? "local"),
			startedAt: String(row.started_at ?? ""),
			updatedAt: String(row.updated_at ?? ""),
			stage: normalizeRunStage(row.stage),
			skillName: String(row.skill_name ?? ""),
			messageHash: row.message_hash ? String(row.message_hash) : null,
		}));
	}

	/** Historical run plus active snapshot and step audit for one durable run. */
	getRunDiagnostics(runId: string): DriftRunDiagnostics | null {
		const key = String(runId ?? "").trim();
		if (!key) return null;
		const db = this.conn();
		const run =
			(db.prepare("SELECT * FROM runs WHERE run_id = ? LIMIT 1").get(key) as Record<string, unknown> | undefined) ??
			null;
		const activeRow = db
			.prepare(
				`SELECT run_id, session_key, started_at, updated_at, stage, skill_name, message_hash
				 FROM drift_active_runs WHERE run_id = ? LIMIT 1`,
			)
			.get(key) as Record<string, unknown> | undefined;
		const active = activeRow
			? {
					runId: String(activeRow.run_id ?? ""),
					sessionKey: String(activeRow.session_key ?? "local"),
					startedAt: String(activeRow.started_at ?? ""),
					updatedAt: String(activeRow.updated_at ?? ""),
					stage: normalizeRunStage(activeRow.stage),
					skillName: String(activeRow.skill_name ?? ""),
					messageHash: activeRow.message_hash ? String(activeRow.message_hash) : null,
				}
			: null;
		if (!run && !active) return null;
		const historyId = Number(run?.id ?? 0);
		const rows = db
			.prepare(
				`SELECT id, run_id, run_key, step_index, tool_name, input_preview, output_preview, created_at
				 FROM run_steps WHERE run_key = ? OR (? > 0 AND run_id = ?) ORDER BY id ASC`,
			)
			.all(key, historyId, historyId) as Array<Record<string, unknown>>;
		const steps = rows.map((row) => ({
			id: Number(row.id ?? 0),
			runId: row.run_id === null || row.run_id === undefined ? null : Number(row.run_id),
			runKey: row.run_key === null || row.run_key === undefined ? null : String(row.run_key),
			stepIndex: Number(row.step_index ?? 0),
			toolName: String(row.tool_name ?? ""),
			inputPreview: String(row.input_preview ?? ""),
			outputPreview: String(row.output_preview ?? ""),
			createdAt: String(row.created_at ?? ""),
		}));
		return { run, active, steps };
	}

	/** Remove terminal Drift history while retaining staged deliveries and continuity state. */
	pruneHistory(options: DriftRetentionOptions = {}): DriftRetentionResult {
		const maxAgeDays = normalizeRetentionNumber(options.maxAgeDays);
		const maxRuns = normalizeRetentionCount(options.maxRuns);
		const result: DriftRetentionResult = {
			runsDeleted: 0,
			runStepsDeleted: 0,
			journalEntriesDeleted: 0,
		};
		if (maxAgeDays === undefined && maxRuns === undefined) return result;

		const nowMs = (options.nowUtc ?? new Date()).getTime();
		const cutoffMs = maxAgeDays === undefined ? undefined : nowMs - maxAgeDays * 24 * 3600_000;
		const rows = this.conn()
			.prepare(
				`SELECT id, run_id, run_at, finished_at
				 FROM runs WHERE message_result <> 'staged'
				 ORDER BY COALESCE(finished_at, run_at) DESC, id DESC`,
			)
			.all() as Array<{ id: number; run_id: string | null; run_at: string; finished_at: string | null }>;
		const keep = new Set(maxRuns === undefined ? [] : rows.slice(0, maxRuns).map((row) => row.id));
		const deleteRows = rows.filter((row) => {
			const timestamp = Date.parse(row.finished_at ?? row.run_at);
			const ageExpired = cutoffMs !== undefined && Number.isFinite(timestamp) && timestamp < cutoffMs;
			const countExpired = maxRuns !== undefined && !keep.has(row.id);
			return ageExpired || countExpired;
		});
		if (deleteRows.length === 0) return result;

		const db = this.conn();
		db.exec("BEGIN IMMEDIATE");
		try {
			for (const row of deleteRows) {
				const runKey = String(row.run_id ?? "").trim();
				if (runKey) {
					result.runStepsDeleted += Number(
						db.prepare("DELETE FROM run_steps WHERE run_key = ?").run(runKey).changes,
					);
				}
				result.runStepsDeleted += Number(db.prepare("DELETE FROM run_steps WHERE run_id = ?").run(row.id).changes);
				result.journalEntriesDeleted += Number(
					db.prepare("DELETE FROM skill_journal WHERE run_id = ?").run(row.id).changes,
				);
				result.runsDeleted += Number(
					db.prepare("DELETE FROM runs WHERE id = ? AND message_result <> 'staged'").run(row.id).changes,
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
	// Skills
	// ------------------------------------------------------------------

	private skillRoots(): Array<{ root: string; builtin: boolean }> {
		const roots: Array<{ root: string; builtin: boolean }> = [{ root: this.skillsDir, builtin: false }];
		if (this.includeBuiltinSkills && this.builtinSkillsDir) {
			roots.push({ root: this.builtinSkillsDir, builtin: true });
		}
		for (const root of this.pluginSkillRoots) roots.push({ root, builtin: false });
		return roots;
	}

	private loadSkillMeta(skillDir: string, builtin: boolean): SkillMeta | null {
		const skillFile = join(skillDir, "SKILL.md");
		if (!existsSync(skillFile)) return null;
		let content: string;
		try {
			content = readFileSync(skillFile, "utf-8");
		} catch {
			return null;
		}
		const metadata = parseSkillFrontmatter(content);
		const name = String(metadata.name ?? "").trim();
		const description = String(metadata.description ?? "").trim();
		if (!name || !description || name !== skillDir.split(/[\\/]/).pop()) {
			return null;
		}
		const rawRequires = metadata.requires_mcp;
		let requiresMcp: string[] = [];
		if (Array.isArray(rawRequires)) {
			requiresMcp = rawRequires.map((item) => String(item).trim()).filter(Boolean);
		} else {
			const raw = String(rawRequires ?? "").trim();
			requiresMcp = raw
				? raw
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: [];
		}
		const continuum = this.loadContinuum(name);
		const lastRunAt = parseIso(continuum.lastRunAt);
		const runCount = continuum.runCount;
		const status = normalizeStatus(continuum.lastStatus);
		const contentHash = hashSkillContent(content);
		return {
			name,
			description,
			lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
			runCount: Math.max(0, Math.trunc(Number(runCount ?? 0))),
			status,
			next: "",
			requiresMcp,
			builtin,
			cooldownHours: Math.max(0, Math.trunc(Number(metadata.cooldown_hours ?? 0))),
			maxRunsPerDay: Math.max(0, Math.trunc(Number(metadata.max_runs_per_day ?? 0))),
			timeWindow: String(metadata.time_window ?? "").trim(),
			skillUpdated: Boolean(continuum.skillHash) && continuum.skillHash !== contentHash,
		};
	}

	/** Scan skills dirs, skip duplicates; sorted by last_run_at desc (akashic scan_skills). */
	scanSkills(): SkillMeta[] {
		const skills: SkillMeta[] = [];
		const seen = new Set<string>();
		for (const { root, builtin } of this.skillRoots()) {
			if (!existsSync(root)) continue;
			for (const skillDir of readDirSorted(root)) {
				if (builtin && this.builtinSkillNames.size > 0 && !this.builtinSkillNames.has(skillDir)) continue;
				const skill = this.loadSkillMeta(join(root, skillDir), builtin);
				if (!skill) continue;
				if (seen.has(skill.name)) continue;
				seen.add(skill.name);
				skills.push(skill);
			}
		}
		skills.sort((a, b) => {
			const at = a.lastRunAt ? Date.parse(a.lastRunAt) : 0;
			const bt = b.lastRunAt ? Date.parse(b.lastRunAt) : 0;
			return bt - at;
		});
		return skills;
	}

	validSkillNames(): Set<string> {
		return new Set(this.scanSkills().map((skill) => skill.name));
	}

	/** Resolve a skill directory by name (workspace, then builtin, then plugin roots). */
	skillDirFor(skillName: string): string | null {
		const name = String(skillName ?? "").trim();
		if (!name) return null;
		const workspaceDir = join(this.skillsDir, name);
		if (existsSync(join(workspaceDir, "SKILL.md"))) return workspaceDir;
		if (this.includeBuiltinSkills && this.builtinSkillsDir) {
			const builtinDir = join(this.builtinSkillsDir, name);
			if (existsSync(join(builtinDir, "SKILL.md"))) return builtinDir;
		}
		for (const root of this.pluginSkillRoots) {
			const pluginDir = join(root, name);
			if (existsSync(join(pluginDir, "SKILL.md"))) return pluginDir;
		}
		return null;
	}

	// ------------------------------------------------------------------
	// Loaders
	// ------------------------------------------------------------------

	// ------------------------------------------------------------------
	// Drift observations(三进程模式下由 drift daemon 记录)
	// ------------------------------------------------------------------

	/** 记录一条 drift 观测(kind 例如 "tick" / "run")。 */
	recordDriftObservation(options: {
		sessionKey: string;
		kind: string;
		now: Date;
		payload: Record<string, unknown>;
	}): void {
		this.conn()
			.prepare(
				`INSERT INTO drift_observations(session_key, kind, now_utc, payload_json)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(options.sessionKey, options.kind, options.now.toISOString(), JSON.stringify(options.payload));
	}

	/** 最近 N 条 drift 观测(升序)。 */
	recentDriftObservations(sessionKey: string, kind: string | null, limit = 20): Array<Record<string, unknown>> {
		const rows = kind
			? (this.conn()
					.prepare(
						`SELECT id, session_key, kind, now_utc, payload_json FROM drift_observations
						 WHERE session_key = ? AND kind = ? ORDER BY id DESC LIMIT ?`,
					)
					.all(sessionKey, kind, limit) as unknown[])
			: (this.conn()
					.prepare(
						`SELECT id, session_key, kind, now_utc, payload_json FROM drift_observations
						 WHERE session_key = ? ORDER BY id DESC LIMIT ?`,
					)
					.all(sessionKey, limit) as unknown[]);
		return rows.reverse().map((row) => {
			const r = row as Record<string, unknown>;
			return {
				id: r.id,
				sessionKey: String(r.session_key),
				kind: String(r.kind),
				nowUtc: new Date(String(r.now_utc)),
				payload: decodeJsonObject(r.payload_json),
			};
		});
	}

	// ------------------------------------------------------------------
	// Drift 重复指纹(跨轮重复抑制;与 proactive wake 的 recordDriftSuccess 语义一致)
	// ------------------------------------------------------------------

	/** 记录一次成功的 drift 输出指纹;与上次相同则 repeat_count+1,否则重置为 0。 */
	recordDriftSuccess(options: { sessionKey: string; now: Date; fingerprint: string }): void {
		const previous = this.loadDriftRepeat(options.sessionKey);
		const repeatCount =
			options.fingerprint && options.fingerprint === previous.lastFingerprint ? previous.repeatCount + 1 : 0;
		this.conn()
			.prepare(
				`INSERT INTO drift_repeat(session_key, last_fingerprint, repeat_count, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(session_key) DO UPDATE SET
					last_fingerprint = excluded.last_fingerprint,
					repeat_count = excluded.repeat_count,
					updated_at = excluded.updated_at`,
			)
			.run(options.sessionKey, options.fingerprint, repeatCount, options.now.toISOString());
	}

	/** 当前重复指纹状态。 */
	loadDriftRepeat(sessionKey: string): { lastFingerprint: string; repeatCount: number } {
		const row = this.conn()
			.prepare(`SELECT last_fingerprint, repeat_count FROM drift_repeat WHERE session_key = ?`)
			.get(sessionKey) as Record<string, unknown> | undefined;
		if (!row) return { lastFingerprint: "", repeatCount: 0 };
		return {
			lastFingerprint: String(row.last_fingerprint ?? ""),
			repeatCount: Number(row.repeat_count ?? 0) || 0,
		};
	}

	// ------------------------------------------------------------------
	// 一次性到期 timer(akashic wake _drift_timer_anchor / save_drift_timer)
	// ------------------------------------------------------------------

	/** 持久化的 drift 到期事件;anchor 变化时重新采样,普通 tick 不重采样。 */
	loadDriftTimer(sessionKey: string): { timerAnchor: string; nextAttemptAt: string; updatedAt: string } | undefined {
		const row = this.conn()
			.prepare(`SELECT timer_anchor, next_attempt_at, updated_at FROM drift_timer WHERE session_key = ?`)
			.get(sessionKey) as Record<string, unknown> | undefined;
		if (!row) return undefined;
		return {
			timerAnchor: String(row.timer_anchor ?? ""),
			nextAttemptAt: String(row.next_attempt_at ?? ""),
			updatedAt: String(row.updated_at ?? ""),
		};
	}

	/** 持久化下一次 drift 尝试的到期时刻(akashic save_drift_timer)。 */
	saveDriftTimer(options: { sessionKey: string; timerAnchor: string; nextAttemptAt: Date; updatedAt: Date }): void {
		this.conn()
			.prepare(
				`INSERT INTO drift_timer(session_key, timer_anchor, next_attempt_at, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(session_key) DO UPDATE SET
					timer_anchor = excluded.timer_anchor,
					next_attempt_at = excluded.next_attempt_at,
					updated_at = excluded.updated_at`,
			)
			.run(
				options.sessionKey,
				options.timerAnchor,
				options.nextAttemptAt.toISOString(),
				options.updatedAt.toISOString(),
			);
	}

	loadDrift(): { version: number; recentRuns: Array<Record<string, string>>; note: string } {
		return {
			version: 2,
			recentRuns: this.loadRecentRunsFromDb(10),
			note: clip(this.loadGlobalNote(), 150),
		};
	}

	loadSkillContinuum(skillName: string): Record<string, unknown> {
		return this.loadContinuum(skillName);
	}

	loadSelfState(): Record<string, string> {
		const row = this.conn()
			.prepare(
				`SELECT current_skill, current_intention, last_decision,
				        decision_reason, next_tendency, updated_at
				 FROM self_state WHERE id = 1`,
			)
			.get() as Record<string, unknown> | undefined;
		if (!row) return {};
		return {
			current_skill: String(row.current_skill ?? ""),
			current_intention: String(row.current_intention ?? ""),
			last_decision: String(row.last_decision ?? ""),
			decision_reason: String(row.decision_reason ?? ""),
			next_tendency: String(row.next_tendency ?? ""),
			updated_at: String(row.updated_at ?? ""),
		};
	}

	saveSelfChoice(options: {
		skillName: string;
		intention: string;
		decision: string;
		reason: string;
		nowUtc: Date;
	}): void {
		this.upsertSelfState({
			currentSkill: options.skillName,
			currentIntention: options.intention,
			lastDecision: options.decision,
			decisionReason: options.reason,
			nextTendency: "",
			updatedAt: options.nowUtc.toISOString(),
		});
	}

	loadSkillJournal(
		skillName: string,
		options: { entryType?: string; key?: string; limit?: number } = {},
	): Array<Record<string, unknown>> {
		const cleanSkill = String(skillName ?? "").trim();
		if (!cleanSkill) return [];
		const clauses = ["skill_name = ?"];
		const params: Array<string | number> = [cleanSkill];
		if (options.entryType?.trim()) {
			clauses.push("entry_type = ?");
			params.push(options.entryType.trim());
		}
		if (options.key?.trim()) {
			clauses.push("key = ?");
			params.push(options.key.trim());
		}
		params.push(Math.max(1, Math.trunc(options.limit ?? 20)));
		const rows = this.conn()
			.prepare(
				`SELECT id, entry_type, key, payload_json, run_id, created_at
				 FROM skill_journal WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`,
			)
			.all(...params) as Array<Record<string, unknown>>;
		const result: Array<Record<string, unknown>> = [];
		for (const row of [...rows].reverse()) {
			result.push({
				id: Number(row.id ?? 0),
				entry_type: String(row.entry_type ?? ""),
				key: String(row.key ?? ""),
				payload: decodeJsonObject(row.payload_json),
				run_id: row.run_id !== null && row.run_id !== undefined ? Number(row.run_id) : null,
				created_at: String(row.created_at ?? ""),
			});
		}
		return result;
	}

	/**
	 * 依据 frontmatter 扩展字段判断 skill 当前是否被限制(cooldown_hours /
	 * max_runs_per_day / time_window)。blocked 的 skill 不进候选列表。
	 */
	skillRestriction(skill: SkillMeta, now = new Date()): { blocked: boolean; reason?: string } {
		if (skill.cooldownHours > 0 && skill.lastRunAt) {
			const lastRun = Date.parse(skill.lastRunAt);
			if (Number.isFinite(lastRun)) {
				const elapsed = now.getTime() - lastRun;
				if (elapsed < skill.cooldownHours * 3600_000) {
					const remainingHours = Math.max(1, Math.ceil((skill.cooldownHours * 3600_000 - elapsed) / 3600_000));
					return { blocked: true, reason: `冷却中，剩余约 ${remainingHours} 小时` };
				}
			}
		}
		if (skill.maxRunsPerDay > 0 && this.runCountToday(skill.name, now) >= skill.maxRunsPerDay) {
			return { blocked: true, reason: `今日已达 ${skill.maxRunsPerDay} 次上限` };
		}
		if (skill.timeWindow) {
			const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(skill.timeWindow);
			if (match) {
				const start = Number(match[1]) * 60 + Number(match[2]);
				const end = Number(match[3]) * 60 + Number(match[4]);
				const minutes = now.getHours() * 60 + now.getMinutes();
				const inside = start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end;
				if (!inside) return { blocked: true, reason: `时段 ${skill.timeWindow} 外` };
			}
		}
		return { blocked: false };
	}

	/** 当日(本地时区)已运行次数。 */
	runCountToday(skillName: string, now = new Date()): number {
		const dayStart = new Date(now);
		dayStart.setHours(0, 0, 0, 0);
		const row = this.conn()
			.prepare("SELECT COUNT(*) AS n FROM runs WHERE skill_name = ? AND run_at >= ?")
			.get(skillName, dayStart.toISOString()) as { n: number };
		return row.n;
	}

	loadRecentSelfObservations(limit = 12): Array<Record<string, unknown>> {
		const rows = this.conn()
			.prepare(
				`SELECT skill_name, payload_json, run_id, created_at
				 FROM skill_journal WHERE entry_type = 'self_observation' ORDER BY id DESC LIMIT ?`,
			)
			.all(Math.max(1, Math.trunc(limit))) as Array<Record<string, unknown>>;
		return [...rows].reverse().map((row) => ({
			skill_name: String(row.skill_name ?? ""),
			payload: decodeJsonObject(row.payload_json),
			run_id: row.run_id !== null && row.run_id !== undefined ? Number(row.run_id) : null,
			created_at: String(row.created_at ?? ""),
		}));
	}

	/** 最近 N 步中错误占比(诊断 flaky skill;从 run_steps 关联已保存 run 统计)。 */
	skillStepErrorRatio(skillName: string, recentSteps = 10): number {
		const cleanSkill = String(skillName ?? "").trim();
		if (!cleanSkill) return 0;
		const rows = this.conn()
			.prepare(
				`SELECT s.output_preview FROM run_steps s
				 LEFT JOIN runs r ON s.run_id = r.id
				 WHERE r.skill_name = ?
				 ORDER BY s.id DESC LIMIT ?`,
			)
			.all(cleanSkill, Math.max(1, Math.trunc(recentSteps))) as Array<{ output_preview: string }>;
		if (rows.length === 0) return 0;
		const errors = rows.filter((row) => isErrorStep(row.output_preview)).length;
		return errors / rows.length;
	}

	// ------------------------------------------------------------------
	// Briefing (akashic load_briefing)
	// ------------------------------------------------------------------

	loadBriefing(skills: SkillMeta[], nowUtc = new Date()): string {
		const recentRows = this.loadRecentRunsFromDb(5);
		const note = this.loadGlobalNote();
		const lines: string[] = [];

		lines.push("【Drift Briefing】", "");
		lines.push("全局前情：");
		lines.push(note ? `- ${note}` : "- （空）");
		lines.push("", "当前可用 skill：");

		if (skills.length === 0) lines.push("- （无）");
		for (const skill of skills.slice(0, 8)) {
			const continuum = this.loadContinuum(skill.name);
			const status = String(continuum.lastStatus || skill.status || "idle");
			const finishedAt = String(continuum.updatedAt || continuum.lastRunAt || "").trim();
			const briefing = String(continuum.lastBriefing || "").trim();
			const scratchpad = String(continuum.scratchpad || "").trim();
			const cursor = continuum.cursor;
			lines.push(`- ${skill.name}`);
			lines.push(`  运行：${skill.runCount} 次`);
			if (skill.builtin) lines.push("  来源：builtin");
			if (skill.requiresMcp.length > 0) lines.push(`  需要：${skill.requiresMcp.join(", ")}`);
			lines.push(`  上次状态：${status}`);
			lines.push(`  上次 finish：${finishedAt || "never"}`);
			lines.push(`  上次摘要：${clip(briefing, 160) || "（空）"}`);
			if (skill.skillUpdated) {
				lines.push("  健康度：SKILL.md 已更新 [skill-updated]");
			}
			if (status === "paused") {
				const pausedAt = parseIso(String(continuum.updatedAt || ""));
				if (pausedAt !== null && nowUtc.getTime() - pausedAt.getTime() > STALE_PAUSED_DAYS * 86_400_000) {
					lines.push(
						`  健康度：${Math.round((nowUtc.getTime() - pausedAt.getTime()) / 86_400_000)} 天未闭环 [stale-paused]`,
					);
				}
			}
			const errorRatio = this.skillStepErrorRatio(skill.name);
			if (errorRatio > FLAKY_ERROR_RATIO) {
				lines.push(`  健康度：最近步骤错误率 ${Math.round(errorRatio * 100)}% [flaky]`);
			}
			if (status === "completed") {
				lines.push("  前情：已闭环；内部续航便签只在选中该 skill 后参考，不作为待办。");
			} else {
				lines.push(`  前情：${clip(scratchpad, 240) || "（空）"}`);
			}
			if (cursor && typeof cursor === "object" && Object.keys(cursor).length > 0) {
				lines.push(`  cursor：${clip(JSON.stringify(cursor, null, 0), 240)}`);
			}
		}

		lines.push("", "最近 Drift runs：");
		if (recentRows.length === 0) lines.push("- （空）");
		for (const row of recentRows.slice(-5).reverse()) {
			const status = String(row.status ?? "");
			const messageResult = String(row.message_result ?? "silent");
			lines.push(
				`- ${String(row.run_at ?? "").slice(0, 16)}  ${String(row.skill ?? "")} [${status}/${messageResult}] ${clip(String(row.briefing ?? ""), 150)}`,
			);
		}
		return lines.join("\n");
	}

	// ------------------------------------------------------------------
	// save_finish (akashic save_finish)
	// ------------------------------------------------------------------

	saveFinish(options: {
		skillUsed: string;
		status: string;
		briefing: string;
		messageResult: string;
		scratchpadUpdate?: string | null;
		globalNoteUpdate?: string | null;
		nowUtc: Date;
		cursorUpdate?: Record<string, unknown> | null;
		journalAppend?: Array<Record<string, unknown>> | null;
		selfUpdate?: Record<string, string> | null;
		/** message_push 的消息 hash;投递确认后由 markRunMessageSent 回写 sent。 */
		messageHash?: string | null;
		/** Durable run identity; when present, finish is idempotent for this run. */
		runId?: string | null;
		sessionKey?: string;
		startedAt?: Date | null;
		message?: string;
		media?: readonly string[];
		attachments?: readonly DriftOutboundAttachment[];
		targetChannel?: string;
		targetChatId?: string;
		deliveryId?: number | null;
		deliveryStatus?: string | null;
		deliveryError?: string | null;
	}): void {
		const skillName = String(options.skillUsed ?? "").trim();
		const statusValue = String(options.status ?? "").trim();
		if (statusValue !== "completed" && statusValue !== "paused") {
			throw new Error("drift status must be completed or paused");
		}

		const db = this.conn();
		const messageHash = String(options.messageHash ?? "").trim() || null;
		const runKey = String(options.runId ?? "").trim() || null;
		const nowIso = options.nowUtc.toISOString();
		const startedAt = options.startedAt?.toISOString() ?? nowIso;
		const sessionKey = clip(options.sessionKey ?? "local", 240) || "local";
		const message = clip(options.message ?? "", 20_000);
		const media = (options.media ?? []).map((item) => String(item).trim()).filter(Boolean);
		const attachments = (options.attachments ?? []).map((attachment) => ({ ...attachment }));
		const targetChannel = clip(options.targetChannel ?? "", 120);
		const targetChatId = clip(options.targetChatId ?? "", 240);
		const deliveryStatus = clip(options.deliveryStatus ?? (messageHash ? "pending" : ""), 40) || null;

		db.exec("BEGIN IMMEDIATE");
		try {
			const existing = runKey
				? (db.prepare("SELECT id FROM runs WHERE run_id = ? LIMIT 1").get(runKey) as { id: number } | undefined)
				: undefined;
			if (existing) {
				// A retried finish for the same durable run must not increment continuity twice.
				db.prepare("DELETE FROM drift_active_runs WHERE run_id = ?").run(runKey);
				db.exec("COMMIT");
				this.lastSavedRunId = Number(existing.id);
				return;
			}

			const result = db
				.prepare(
					`INSERT INTO runs (
						run_id, session_key, run_at, started_at, finished_at, skill_name, status,
						briefing, message_result, message_hash, message, media_json, attachments_json,
						target_channel, target_chat_id, delivery_id, delivery_status, delivery_error
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					runKey,
					sessionKey,
					nowIso,
					startedAt,
					nowIso,
					skillName,
					statusValue,
					clip(options.briefing, 500),
					options.messageResult,
					messageHash,
					message,
					JSON.stringify(media),
					JSON.stringify(attachments),
					targetChannel,
					targetChatId,
					options.deliveryId ?? null,
					deliveryStatus,
					options.deliveryError ? clip(options.deliveryError, 2000) : null,
				);
			const historyId = Number(result.lastInsertRowid ?? 0);
			if (historyId > 0) {
				this.lastSavedRunId = historyId;
				if (runKey) {
					db.prepare("UPDATE run_steps SET run_id = ? WHERE run_key = ?").run(historyId, runKey);
				} else {
					db.prepare("UPDATE run_steps SET run_id = ? WHERE run_id IS NULL AND created_at = ?").run(
						historyId,
						nowIso,
					);
				}
			}
			const row = db
				.prepare("SELECT run_count, scratchpad, cursor_json FROM skill_continuum WHERE skill_name = ?")
				.get(skillName) as { run_count: number; scratchpad: string; cursor_json: string } | undefined;
			const oldCount = row ? Number(row.run_count ?? 0) : 0;
			const oldScratchpad = row ? String(row.scratchpad ?? "") : "";
			const oldCursor = row ? decodeJsonObject(row.cursor_json) : {};
			const mergedCursor = mergeCursor(oldCursor, options.cursorUpdate);
			const scratchpad =
				options.scratchpadUpdate !== null &&
				options.scratchpadUpdate !== undefined &&
				String(options.scratchpadUpdate).trim()
					? clip(String(options.scratchpadUpdate), 2000)
					: oldScratchpad;
			// 记录本次 finish 时的 SKILL.md 内容 hash(供 [skill-updated] 检测)。
			const skillFile = this.skillDirFor(skillName);
			const skillHash = skillFile ? hashSkillFile(join(skillFile, "SKILL.md")) : null;
			db.prepare(
				`INSERT INTO skill_continuum (
					skill_name, run_count, last_run_at, last_status,
					last_briefing, scratchpad, cursor_json, skill_hash, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(skill_name) DO UPDATE SET
					run_count = excluded.run_count,
					last_run_at = excluded.last_run_at,
					last_status = excluded.last_status,
					last_briefing = excluded.last_briefing,
					scratchpad = excluded.scratchpad,
					cursor_json = excluded.cursor_json,
					skill_hash = excluded.skill_hash,
					updated_at = excluded.updated_at`,
			).run(
				skillName,
				oldCount + 1,
				nowIso,
				statusValue,
				clip(options.briefing, 500),
				scratchpad,
				JSON.stringify(mergedCursor),
				skillHash,
				nowIso,
			);
			this.appendJournalEntries({
				skillName,
				runId: historyId || null,
				entries: options.journalAppend ?? [],
				createdAt: nowIso,
			});
			if (options.selfUpdate) {
				const selfState = this.loadSelfStateFromConnection();
				this.upsertSelfState({
					currentSkill: skillName,
					currentIntention:
						String(options.selfUpdate.current_intention ?? "") || selfState.current_intention || "",
					lastDecision: selfState.last_decision || "",
					decisionReason: selfState.decision_reason || "",
					nextTendency: String(options.selfUpdate.next_tendency ?? ""),
					updatedAt: nowIso,
				});
			}
			if (
				options.globalNoteUpdate !== null &&
				options.globalNoteUpdate !== undefined &&
				String(options.globalNoteUpdate).trim()
			) {
				db.prepare(
					`INSERT INTO global_note (id, content, updated_at) VALUES (1, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
				).run(clip(String(options.globalNoteUpdate), 1000), nowIso);
			}
			if (runKey) db.prepare("DELETE FROM drift_active_runs WHERE run_id = ?").run(runKey);
			db.exec("COMMIT");
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// Preserve the original finish error.
			}
			throw error;
		}
	}

	updateLastMessageResult(messageResult: string, runId?: string): void {
		const runKey = String(runId ?? "").trim();
		if (runKey) {
			this.conn().prepare("UPDATE runs SET message_result = ? WHERE run_id = ?").run(messageResult, runKey);
			return;
		}
		if (!this.lastSavedRunId) return;
		this.conn().prepare("UPDATE runs SET message_result = ? WHERE id = ?").run(messageResult, this.lastSavedRunId);
	}

	appendStep(options: {
		stepIndex: number;
		toolName: string;
		inputPreview: string;
		outputPreview: string;
		nowUtc: Date;
		runId?: string;
	}): void {
		const createdAt = options.nowUtc.toISOString();
		this.conn()
			.prepare(
				`INSERT INTO run_steps (run_id, run_key, step_index, tool_name, input_preview, output_preview, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				null,
				options.runId ?? null,
				Math.max(0, Math.trunc(options.stepIndex)),
				clip(options.toolName, 120),
				clip(options.inputPreview, 500),
				clip(options.outputPreview, 500),
				createdAt,
			);
	}

	// ------------------------------------------------------------------
	// Internals
	// ------------------------------------------------------------------

	private loadRecentRunsFromDb(limit: number): Array<Record<string, string>> {
		const rows = this.conn()
			.prepare(
				`SELECT run_at, skill_name, status, briefing, message_result
				 FROM runs ORDER BY id DESC LIMIT ?`,
			)
			.all(Math.max(1, Math.trunc(limit))) as Array<Record<string, unknown>>;
		const result: Array<Record<string, string>> = [];
		for (const row of [...rows].reverse()) {
			result.push({
				skill: clip(String(row.skill_name ?? ""), 80),
				run_at: clip(String(row.run_at ?? ""), 80),
				status: clip(normalizeStatus(row.status), 20),
				briefing: clip(String(row.briefing ?? ""), 150),
				message_result: clip(String(row.message_result ?? ""), 20),
			});
		}
		return result;
	}

	private loadGlobalNote(): string {
		const row = this.conn().prepare("SELECT content FROM global_note WHERE id = 1").get() as
			| { content: string }
			| undefined;
		return row ? String(row.content ?? "") : "";
	}

	private loadContinuum(skillName: string): {
		runCount: number;
		lastRunAt: string;
		lastStatus: string;
		lastBriefing: string;
		scratchpad: string;
		cursor: Record<string, unknown>;
		skillHash: string;
		updatedAt: string;
	} {
		const row = this.conn()
			.prepare(
				`SELECT run_count, last_run_at, last_status, last_briefing,
				        scratchpad, cursor_json, skill_hash, updated_at
				 FROM skill_continuum WHERE skill_name = ?`,
			)
			.get(skillName) as Record<string, unknown> | undefined;
		if (!row) {
			return {
				runCount: 0,
				lastRunAt: "",
				lastStatus: "idle",
				lastBriefing: "",
				scratchpad: "",
				cursor: {},
				skillHash: "",
				updatedAt: "",
			};
		}
		return {
			runCount: Number(row.run_count ?? 0),
			lastRunAt: String(row.last_run_at ?? ""),
			lastStatus: normalizeStatus(row.last_status),
			lastBriefing: String(row.last_briefing ?? ""),
			scratchpad: String(row.scratchpad ?? ""),
			cursor: decodeJsonObject(row.cursor_json),
			skillHash: String(row.skill_hash ?? ""),
			updatedAt: String(row.updated_at ?? ""),
		};
	}

	private loadSelfStateFromConnection(): Record<string, string> {
		const row = this.conn()
			.prepare("SELECT current_intention, last_decision, decision_reason FROM self_state WHERE id = 1")
			.get() as Record<string, unknown> | undefined;
		if (!row) return {};
		return {
			current_intention: String(row.current_intention ?? ""),
			last_decision: String(row.last_decision ?? ""),
			decision_reason: String(row.decision_reason ?? ""),
		};
	}

	private upsertSelfState(options: {
		currentSkill: string;
		currentIntention: string;
		lastDecision: string;
		decisionReason: string;
		nextTendency: string;
		updatedAt: string;
	}): void {
		this.conn()
			.prepare(
				`INSERT INTO self_state (
					id, current_skill, current_intention, last_decision,
					decision_reason, next_tendency, updated_at
				) VALUES (1, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					current_skill = excluded.current_skill,
					current_intention = excluded.current_intention,
					last_decision = excluded.last_decision,
					decision_reason = excluded.decision_reason,
					next_tendency = excluded.next_tendency,
					updated_at = excluded.updated_at`,
			)
			.run(
				clip(options.currentSkill, 80),
				clip(options.currentIntention, 500),
				clip(options.lastDecision, 40),
				clip(options.decisionReason, 500),
				clip(options.nextTendency, 500),
				options.updatedAt,
			);
	}

	private appendJournalEntries(options: {
		skillName: string;
		runId: number | null;
		entries: Array<Record<string, unknown>>;
		createdAt: string;
	}): void {
		for (const entry of options.entries) {
			const entryType = String(entry.entry_type ?? "").trim();
			if (!entryType) continue;
			const key = String(entry.key ?? "").trim();
			const payload = entry.payload;
			const payloadJson = JSON.stringify(
				payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {},
			);
			this.conn()
				.prepare(
					`INSERT INTO skill_journal (skill_name, entry_type, key, payload_json, run_id, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(options.skillName, entryType, key, payloadJson, options.runId, options.createdAt);
		}
	}
}

function readDirSorted(dir: string): string[] {
	try {
		return readdirSync(dir).sort();
	} catch {
		return [];
	}
}

/** SKILL.md 内容 sha256(供 skillUpdated 检测)。 */
function hashSkillContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function hashSkillFile(file: string): string | null {
	try {
		return hashSkillContent(readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
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
