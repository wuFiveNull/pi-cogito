/**
 * Web API — 数据端点,供内置 web 页面使用。
 *
 * 零依赖(仅 node 内置模块),直接读 pi 的数据文件:
 * - 会话:  ~/.cogito/agent/sessions 下所有 .jsonl
 * - proactive: proactive.sqlite(tick_log / deliveries / items / state)
 * - 记忆:  memory/memory.sqlite(memory_items)
 * - drift:  drift/skills 下的 SKILL.md
 * - MCP:   mcp.json
 *
 * 通过 WebChannel.registerApi("GET", "/api/*", webApi.handle) 挂载。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface WebApiOptions {
	/** ~/.cogito/agent/sessions */
	sessionsDir: string;
	/** proactive.sqlite 路径 */
	proactiveDbPath: string;
	/** memory/memory.sqlite 路径 */
	memoryDbPath?: string;
	/** drift/drift.db 路径(投递确认时回写 drift run 的 message_result)。 */
	driftDbPath?: string;
	/** drift skills 目录(<project>/.cogito/extensions/drift/skills) */
	driftSkillsDir?: string;
	/** mcp.json 路径 */
	mcpConfigPath?: string;
	/** web 设置存储路径(独立于 pi 的 settings.json) */
	settingsPath?: string;
	/** 插件面板(宿主注册,如 proactive 审计面板)。 */
	plugins?: WebPlugin[];
}

/** 插件:监控页「插件」tab 中可查看的动态面板。 */
export interface WebPlugin {
	id: string;
	name: string;
	description?: string;
	/** 面板数据:返回 { columns: [{key,label}], rows: [Record<string, unknown>] }。 */
	panel(req: IncomingMessage, res: ServerResponse, url: URL): void | Promise<void>;
	/** 插件前端模块源码(ESM)。前端动态加载并调用其 mount(container, ctx)。 */
	moduleSource?: string;
}

interface SessionSummary {
	key: string;
	title: string;
	message_count: number;
	updated_at: string | null;
	first_message_content: string;
}

export interface ChatMessagePart {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
	mimeType?: string;
	data?: string;
}

export interface ChatMessageRow {
	id: string;
	role: string;
	content: string;
	timestamp: string;
	/** 原始 content 数组(thinking / toolCall / image / text),缺省时仅有 content。 */
	parts?: ChatMessagePart[];
}

function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

function dirnameOf(path: string): string {
	const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return i >= 0 ? path.slice(0, i) : ".";
}

function writeJsonFile(path: string, value: unknown): void {
	mkdirSync(dirnameOf(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

function json(res: ServerResponse, status: number, payload: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(payload));
}

function pageParams(url: URL): { page: number; page_size: number } {
	const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
	const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get("page_size")) || 50));
	return { page, page_size: pageSize };
}

// ------------------------------------------------------------------
// 会话(sessions jsonl)
// ------------------------------------------------------------------

function sessionFiles(sessionsDir: string): string[] {
	if (!existsSync(sessionsDir)) return [];
	const files: string[] = [];
	try {
		for (const entry of readdirSync(sessionsDir)) {
			const full = join(sessionsDir, entry);
			if (entry.endsWith(".jsonl")) {
				files.push(full);
			} else if (existsSync(join(full, "x")) === false && isDir(full)) {
				for (const inner of readdirSync(full)) {
					if (inner.endsWith(".jsonl")) files.push(join(full, inner));
				}
			}
		}
	} catch {
		// ignore unreadable dirs
	}
	return files;
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function keyOf(file: string): string {
	const name = file.replace(/\\/g, "/").split("/").pop() ?? file;
	return name.endsWith(".jsonl") ? name.slice(0, -6) : name;
}

function listSessions(sessionsDir: string): SessionSummary[] {
	const out: SessionSummary[] = [];
	for (const file of sessionFiles(sessionsDir)) {
		let count = 0;
		let title = "";
		let updated: string | null = null;
		let firstContent = "";
		try {
			for (const line of readFileSync(file, "utf-8").split("\n")) {
				if (!line.trim()) continue;
				let entry: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
				try {
					entry = JSON.parse(line) as typeof entry;
				} catch {
					continue;
				}
				if (entry.type === "message" && entry.message) {
					count++;
					const content = extractText(entry.message.content);
					if (!firstContent && content) firstContent = content;
					if (content && !title) title = content.slice(0, 48);
				}
				if (entry.timestamp && (!updated || entry.timestamp > updated)) updated = entry.timestamp;
			}
		} catch {
			continue;
		}
		if (count === 0) continue;
		out.push({
			key: keyOf(file),
			title: title || keyOf(file),
			message_count: count,
			updated_at: updated,
			first_message_content: firstContent,
		});
	}
	out.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
	return out;
}

function readSessionMessages(sessionsDir: string, key: string): ChatMessageRow[] {
	const files = sessionFiles(sessionsDir).filter((file) => keyOf(file) === key);
	const rows: ChatMessageRow[] = [];
	for (const file of files) {
		try {
			for (const line of readFileSync(file, "utf-8").split("\n")) {
				if (!line.trim()) continue;
				let entry: {
					type?: string;
					id?: string;
					timestamp?: string;
					message?: { role?: string; content?: unknown };
				};
				try {
					entry = JSON.parse(line) as typeof entry;
				} catch {
					continue;
				}
				if (entry.type !== "message" || !entry.message) continue;
				const role = entry.message.role;
				if (role !== "user" && role !== "assistant") continue;
				const rawContent = entry.message.content;
				const content = extractText(rawContent);
				if (!content) continue;
				const row: ChatMessageRow = {
					id: String(entry.id ?? `${key}:${rows.length}`),
					role,
					content,
					timestamp: entry.timestamp ?? "",
				};
				if (Array.isArray(rawContent)) {
					row.parts = rawContent
						.filter(
							(part): part is ChatMessagePart =>
								typeof part === "object" && part !== null && typeof part.type === "string",
						)
						.map((part) => ({ ...part }));
				}
				rows.push(row);
			}
		} catch {
			// skip unreadable file
		}
	}
	rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	return rows;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
			.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
			.join(" ")
			.trim();
	}
	return "";
}

// ------------------------------------------------------------------
// Runtime:drift skills / MCP / sources
// ------------------------------------------------------------------

interface SkillInfo {
	name: string;
	description: string;
	path: string;
}

function listSkills(skillsDir: string | undefined): SkillInfo[] {
	if (!skillsDir || !existsSync(skillsDir)) return [];
	const out: SkillInfo[] = [];
	try {
		for (const skill of readdirSync(skillsDir)) {
			const skillDir = join(skillsDir, skill);
			const md = join(skillDir, "SKILL.md");
			if (!existsSync(md)) continue;
			let name = skill;
			let description = "";
			try {
				const text = readFileSync(md, "utf-8");
				const fm = text.match(/^---\n([\s\S]*?)\n---/);
				if (fm) {
					const nameMatch = fm[1].match(/^name:\s*(.+)$/m);
					const descMatch = fm[1].match(/^description:\s*(.+)$/m);
					if (nameMatch) name = nameMatch[1].trim();
					if (descMatch) description = descMatch[1].trim();
				}
			} catch {
				// ignore
			}
			out.push({ name, description, path: md });
		}
	} catch {
		// ignore
	}
	return out;
}

// ------------------------------------------------------------------
// Runtime:jobs(运行状态:presence + state)
// ------------------------------------------------------------------

function runtimeJobs(dbPath: string): Array<Record<string, unknown>> {
	const db = openDb(dbPath);
	if (!db) return [];
	try {
		const presence = db.prepare("SELECT * FROM presence").all() as unknown as Array<{
			session_key: string;
			last_user_at: number | null;
			last_proactive_at: number | null;
		}>;
		const states = db.prepare("SELECT key, value FROM state ORDER BY key").all() as unknown as Array<{
			key: string;
			value: string;
		}>;
		const stateMap = new Map(states.map((row) => [row.key, row.value]));
		return presence.map((row) => ({
			key: row.session_key,
			name: row.session_key,
			description: `最后用户活跃 ${row.last_user_at ? new Date(row.last_user_at).toLocaleString() : "—"}`,
			last_user_at: row.last_user_at,
			last_proactive_at: row.last_proactive_at,
			state: Object.fromEntries(
				[...stateMap.entries()].filter(([key]) => key.startsWith("pusher.") || key.startsWith("lastStats.")),
			),
		}));
	} finally {
		db.close();
	}
}

// ------------------------------------------------------------------
// Proactive(tick_log / deliveries)
// ------------------------------------------------------------------

interface TickLogRow {
	id: number;
	started_at: number;
	finished_at: number | null;
	base_score: number | null;
	candidates: number;
	steps: number;
	action: string;
	skip_reason: string;
	error: string | null;
}

interface TickStepRow {
	id: number;
	tick_id: number;
	step_index: number;
	phase: string;
	detail: string;
	action_after: string;
	skip_reason_after: string;
	duration_ms: number;
}

function openDb(path: string): DatabaseSync | null {
	try {
		return new DatabaseSync(path, { readOnly: true });
	} catch {
		return null;
	}
}

function listTickLogs(dbPath: string, page: number, pageSize: number): { items: TickLogRow[]; total: number } {
	const db = openDb(dbPath);
	if (!db) return { items: [], total: 0 };
	try {
		const total = (db.prepare("SELECT COUNT(*) AS n FROM tick_log").get() as { n: number }).n;
		const rows = db
			.prepare("SELECT * FROM tick_log ORDER BY started_at DESC LIMIT ? OFFSET ?")
			.all(pageSize, (page - 1) * pageSize) as unknown as TickLogRow[];
		return { items: rows, total };
	} finally {
		db.close();
	}
}

function listTickSteps(dbPath: string, tickId: number): TickStepRow[] {
	const db = openDb(dbPath);
	if (!db) return [];
	try {
		return db
			.prepare("SELECT * FROM tick_steps WHERE tick_id = ? ORDER BY step_index ASC")
			.all(tickId) as unknown as TickStepRow[];
	} finally {
		db.close();
	}
}

function getTickLog(dbPath: string, id: number): TickLogRow | null {
	const db = openDb(dbPath);
	if (!db) return null;
	try {
		const row = db.prepare("SELECT * FROM tick_log WHERE id = ?").get(id) as unknown as TickLogRow | undefined;
		return row ?? null;
	} finally {
		db.close();
	}
}

interface DeliveryRow {
	id: number;
	message: string;
	message_hash: string;
	source_refs: string;
	evidence: string;
	action: string;
	state_summary_tag: string;
	delivered_at: number;
	acked: number;
}

interface DriftActiveRunRow {
	run_id: string;
	session_key: string;
	started_at: string;
	updated_at: string;
	stage: string;
	skill_name: string;
	message_hash: string | null;
}

function listDeliveries(dbPath: string, page: number, pageSize: number): { items: DeliveryRow[]; total: number } {
	const db = openDb(dbPath);
	if (!db) return { items: [], total: 0 };
	try {
		const total = (db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number }).n;
		const rows = db
			.prepare("SELECT * FROM deliveries ORDER BY delivered_at DESC LIMIT ? OFFSET ?")
			.all(pageSize, (page - 1) * pageSize) as unknown as DeliveryRow[];
		return { items: rows, total };
	} finally {
		db.close();
	}
}

function listDriftActiveRuns(
	dbPath: string,
	page: number,
	pageSize: number,
): {
	items: DriftActiveRunRow[];
	total: number;
} {
	const db = openDb(dbPath);
	if (!db) return { items: [], total: 0 };
	try {
		const total = (db.prepare("SELECT COUNT(*) AS n FROM drift_active_runs").get() as { n: number }).n;
		const items = db
			.prepare(
				`SELECT run_id, session_key, started_at, updated_at, stage, skill_name, message_hash
				 FROM drift_active_runs ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
			)
			.all(pageSize, (page - 1) * pageSize) as unknown as DriftActiveRunRow[];
		return { items, total };
	} catch {
		return { items: [], total: 0 };
	} finally {
		db.close();
	}
}

function getDriftDiagnostics(dbPath: string, runId: string): Record<string, unknown> | null {
	const db = openDb(dbPath);
	if (!db) return null;
	try {
		const run =
			(db.prepare("SELECT * FROM runs WHERE run_id = ? LIMIT 1").get(runId) as
				| Record<string, unknown>
				| undefined) ?? null;
		const active =
			(db
				.prepare(
					`SELECT run_id, session_key, started_at, updated_at, stage, skill_name, message_hash
					 FROM drift_active_runs WHERE run_id = ? LIMIT 1`,
				)
				.get(runId) as Record<string, unknown> | undefined) ?? null;
		if (!run && !active) return null;
		const historyId = Number(run?.id ?? 0);
		const steps = db
			.prepare(
				`SELECT id, run_id, run_key, step_index, tool_name, input_preview, output_preview, created_at
				 FROM run_steps WHERE run_key = ? OR (? > 0 AND run_id = ?) ORDER BY id ASC`,
			)
			.all(runId, historyId, historyId);
		return { run, active, steps };
	} catch {
		return null;
	} finally {
		db.close();
	}
}

/**
 * 投递确认(web outlet 展示后调用,akashic record_commit_result 对应物):
 * 标记 deliveries.acked=1,并把 state_summary_tag='drift' 的投递按 message_hash
 * 回写 drift.db 的 runs.message_result='sent'。按 hash 匹配,幂等。
 */
async function ackDeliveries(req: IncomingMessage, res: ServerResponse, o: WebApiOptions): Promise<void> {
	if (!existsSync(o.proactiveDbPath)) {
		json(res, 404, { error: "proactive 库不存在" });
		return;
	}
	let body = "";
	for await (const chunk of req) body += chunk;
	let parsed: { ids?: unknown };
	try {
		parsed = JSON.parse(body) as typeof parsed;
	} catch {
		json(res, 400, { error: "invalid JSON" });
		return;
	}
	const ids = Array.isArray(parsed.ids)
		? parsed.ids.filter((item): item is number => typeof item === "number" && Number.isInteger(item))
		: [];
	if (ids.length === 0) {
		json(res, 400, { error: "ids 必填" });
		return;
	}
	const placeholders = ids.map(() => "?").join(", ");
	try {
		const db = new DatabaseSync(o.proactiveDbPath);
		let acked = 0;
		let driftRunsSent = 0;
		try {
			acked = Number(
				db.prepare(`UPDATE deliveries SET acked = 1 WHERE id IN (${placeholders})`).run(...ids).changes,
			);
			const driftRows = db
				.prepare(
					`SELECT message_hash FROM deliveries
					 WHERE id IN (${placeholders}) AND state_summary_tag = 'drift' AND message_hash != ''`,
				)
				.all(...ids) as Array<{ message_hash: string }>;
			if (driftRows.length > 0 && o.driftDbPath && existsSync(o.driftDbPath)) {
				const driftDb = new DatabaseSync(o.driftDbPath);
				try {
					for (const row of driftRows) {
						driftRunsSent += Number(
							driftDb
								.prepare(
									"UPDATE runs SET message_result = 'sent' WHERE message_hash = ? AND message_result = 'staged'",
								)
								.run(row.message_hash).changes,
						);
					}
				} finally {
					driftDb.close();
				}
			}
		} finally {
			db.close();
		}
		json(res, 200, { ok: true, acked, drift_runs_sent: driftRunsSent });
	} catch (error) {
		json(res, 500, { error: error instanceof Error ? error.message : String(error) });
	}
}

function proactiveOverview(dbPath: string): Record<string, unknown> {
	const db = openDb(dbPath);
	if (!db) return {};
	try {
		const actionCounts: Record<string, number> = {};
		const skipCounts: Record<string, number> = {};
		for (const row of db.prepare("SELECT action, skip_reason FROM tick_log").all() as unknown as Array<{
			action: string;
			skip_reason: string;
		}>) {
			actionCounts[row.action] = (actionCounts[row.action] ?? 0) + 1;
			if (row.skip_reason) skipCounts[row.skip_reason] = (skipCounts[row.skip_reason] ?? 0) + 1;
		}
		const lastTick = db.prepare("SELECT * FROM tick_log ORDER BY started_at DESC LIMIT 1").get() as unknown as
			| TickLogRow
			| undefined;
		const deliveryCount = (db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number }).n;
		const itemCounts = { total: 0, new: 0, pushed: 0 };
		for (const row of db
			.prepare("SELECT status, COUNT(*) AS n FROM items GROUP BY status")
			.all() as unknown as Array<{ status: string; n: number }>) {
			itemCounts.total += row.n;
			if (row.status === "new") itemCounts.new = row.n;
			if (row.status === "pushed") itemCounts.pushed = row.n;
		}
		return {
			action_counts: actionCounts,
			skip_reason_counts: skipCounts,
			delivery_count: deliveryCount,
			item_counts: itemCounts,
			last_tick: lastTick ?? null,
		};
	} finally {
		db.close();
	}
}

// ------------------------------------------------------------------
// 记忆(memory_items)
// ------------------------------------------------------------------

interface MemoryRow {
	id: string;
	memory_type: string;
	summary: string;
	reinforcement: number;
	emotional_weight: number;
	status: string;
	created_at: string;
	updated_at: string;
}

function listMemories(
	memoryDbPath: string | undefined,
	page: number,
	pageSize: number,
): { items: MemoryRow[]; total: number } {
	if (!memoryDbPath || !existsSync(memoryDbPath)) return { items: [], total: 0 };
	const db = openDb(memoryDbPath);
	if (!db) return { items: [], total: 0 };
	try {
		const total = (db.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as { n: number }).n;
		const rows = db
			.prepare(
				"SELECT id, memory_type, summary, reinforcement, emotional_weight, status, created_at, updated_at FROM memory_items ORDER BY updated_at DESC LIMIT ? OFFSET ?",
			)
			.all(pageSize, (page - 1) * pageSize) as unknown as MemoryRow[];
		return { items: rows, total };
	} finally {
		db.close();
	}
}

function parseEmbedding(value: string | null): number[] | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) && parsed.every((item) => typeof item === "number") ? (parsed as number[]) : null;
	} catch {
		return null;
	}
}

function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 按 embedding 余弦相似度返回 top-N 记忆。 */
function similarMemories(memoryDbPath: string | undefined, id: string, topN: number): Record<string, unknown> {
	if (!memoryDbPath || !existsSync(memoryDbPath)) return { items: [], note: "记忆库不存在" };
	const db = openDb(memoryDbPath);
	if (!db) return { items: [], note: "记忆库不可读" };
	try {
		const target = db.prepare("SELECT id, summary, embedding FROM memory_items WHERE id = ?").get(id) as
			| { id: string; summary: string; embedding: string | null }
			| undefined;
		if (!target) return { items: [], note: "记忆不存在" };
		const targetVec = parseEmbedding(target.embedding);
		if (!targetVec) {
			return { items: [], note: "该记忆没有 embedding(未配置向量化模型)" };
		}
		const rows = db
			.prepare(
				"SELECT id, memory_type, summary, reinforcement, embedding, updated_at FROM memory_items WHERE id != ? AND embedding IS NOT NULL",
			)
			.all(id) as unknown as Array<{
			id: string;
			memory_type: string;
			summary: string;
			reinforcement: number;
			embedding: string | null;
			updated_at: string;
		}>;
		const scored = rows
			.map((row) => ({ row, score: cosineSimilarity(targetVec, parseEmbedding(row.embedding) ?? []) }))
			.filter((item) => item.score > 0.1)
			.sort((a, b) => b.score - a.score)
			.slice(0, topN)
			.map(({ row, score }) => ({
				id: row.id,
				memory_type: row.memory_type,
				summary: row.summary,
				reinforcement: row.reinforcement,
				updated_at: row.updated_at,
				score: Math.round(score * 10000) / 10000,
			}));
		return { items: scored, note: "" };
	} finally {
		db.close();
	}
}

async function deleteMemoriesBatch(req: IncomingMessage, res: ServerResponse, o: WebApiOptions): Promise<void> {
	if (!o.memoryDbPath || !existsSync(o.memoryDbPath)) {
		json(res, 404, { error: "记忆库不存在" });
		return;
	}
	let body = "";
	for await (const chunk of req) body += chunk;
	let parsed: { ids?: unknown };
	try {
		parsed = JSON.parse(body) as typeof parsed;
	} catch {
		json(res, 400, { error: "invalid JSON" });
		return;
	}
	const ids = Array.isArray(parsed.ids) ? parsed.ids.filter((item): item is string => typeof item === "string") : [];
	if (ids.length === 0) {
		json(res, 400, { error: "ids 必填" });
		return;
	}
	try {
		const db = new DatabaseSync(o.memoryDbPath);
		try {
			const placeholders = ids.map(() => "?").join(", ");
			const result = db.prepare(`DELETE FROM memory_items WHERE id IN (${placeholders})`).run(...ids);
			json(res, 200, { ok: true, deleted: result.changes });
		} finally {
			db.close();
		}
	} catch (error) {
		json(res, 500, { error: error instanceof Error ? error.message : String(error) });
	}
}

function findMemory(memoryDbPath: string | undefined, id: string): MemoryRow | null {
	if (!memoryDbPath || !existsSync(memoryDbPath)) return null;
	const db = openDb(memoryDbPath);
	if (!db) return null;
	try {
		const row = db
			.prepare(
				"SELECT id, memory_type, summary, reinforcement, emotional_weight, status, created_at, updated_at FROM memory_items WHERE id = ?",
			)
			.get(id) as unknown as MemoryRow | undefined;
		return row ?? null;
	} finally {
		db.close();
	}
}

function deleteMemory(memoryDbPath: string | undefined, id: string): boolean {
	if (!memoryDbPath || !existsSync(memoryDbPath)) return false;
	try {
		const db = new DatabaseSync(memoryDbPath);
		try {
			const result = db.prepare("DELETE FROM memory_items WHERE id = ?").run(id);
			return result.changes > 0;
		} finally {
			db.close();
		}
	} catch {
		return false;
	}
}

// ------------------------------------------------------------------
// Settings(独立 web-settings.json)
// ------------------------------------------------------------------

function defaultRuntime(): Record<string, unknown> {
	return {
		model: "deepseek-v4-flash",
		apiBaseUrl: "https://opencode.ai/zen/go/v1",
		apiKey: "",
		reasoningEffort: "",
		contextWindow: 128000,
		maxOutputTokens: 0,
	};
}

function defaultSettings(): Record<string, unknown> {
	return {
		runtimes: {
			api: defaultRuntime(),
			"opencode-go": { ...defaultRuntime(), apiBaseUrl: "https://opencode.ai/zen/go/v1", apiKey: "" },
			codex: { ...defaultRuntime(), apiBaseUrl: "https://api.openai.com/v1", apiKey: "" },
		},
		activeRuntime: "api",
		drift: { enabled: false, maxSteps: 20, minIntervalHours: 3 },
	};
}

// ------------------------------------------------------------------
// Handler
// ------------------------------------------------------------------

export interface WebApi {
	/** 处理一个请求,返回 true 表示已消费。 */
	handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
}

export function createWebApi(options: WebApiOptions): WebApi {
	return { handle: (req, res, url) => route(req, res, url, options) };
}

function listPlugins(o: WebApiOptions): Array<{ id: string; name: string; description?: string; hasModule: boolean }> {
	return (o.plugins ?? []).map(({ id, name, description, moduleSource }) => ({
		id,
		name,
		description,
		hasModule: typeof moduleSource === "string" && moduleSource.length > 0,
	}));
}

function route(req: IncomingMessage, res: ServerResponse, url: URL, o: WebApiOptions): boolean {
	const path = url.pathname;
	try {
		// Chat
		if (req.method === "GET" && path === "/api/chat/sessions") {
			json(res, 200, { items: listSessions(o.sessionsDir) });
			return true;
		}
		const messagesMatch = path.match(/^\/api\/chat\/sessions\/(.+)\/messages$/);
		if (req.method === "GET" && messagesMatch) {
			json(res, 200, { items: readSessionMessages(o.sessionsDir, decodeURIComponent(messagesMatch[1])) });
			return true;
		}

		// Runtime
		if (req.method === "GET" && path === "/api/runtime/overview") {
			const skills = listSkills(o.driftSkillsDir);
			const mcp = readMcpConfig(o.mcpConfigPath);
			json(res, 200, {
				skills: skills.length,
				mcp_servers: Object.keys(mcp).length,
				...readSourcesOverview(),
			});
			return true;
		}
		if (req.method === "GET" && path === "/api/runtime/skills") {
			json(res, 200, { items: listSkills(o.driftSkillsDir) });
			return true;
		}
		if (req.method === "GET" && path === "/api/runtime/mcp") {
			json(res, 200, { servers: readMcpConfig(o.mcpConfigPath) });
			return true;
		}
		if (req.method === "GET" && path === "/api/runtime/jobs") {
			json(res, 200, { items: runtimeJobs(o.proactiveDbPath) });
			return true;
		}
		const skillMatch = path.match(/^\/api\/runtime\/skills\/(.+)$/);
		if (req.method === "GET" && skillMatch) {
			const name = decodeURIComponent(skillMatch[1]);
			const skill = listSkills(o.driftSkillsDir).find((item) => item.name === name);
			if (!skill) {
				json(res, 404, { error: "skill not found" });
			} else {
				let content = "";
				try {
					content = readFileSync(skill.path, "utf-8");
				} catch {
					// ignore
				}
				json(res, 200, { ...skill, content });
			}
			return true;
		}
		const docMatch = path.match(/^\/api\/runtime\/documents\/(.+)$/);
		if (req.method === "GET" && docMatch) {
			const id = decodeURIComponent(docMatch[1]);
			const { page } = pageParams(url);
			const all = listMemories(o.memoryDbPath, page, 200);
			const memory = all.items.find((item) => item.id === id);
			if (!memory) {
				json(res, 404, { error: "document not found" });
			} else {
				json(res, 200, memory);
			}
			return true;
		}
		if (req.method === "GET" && path === "/api/runtime/documents") {
			const { page, page_size } = pageParams(url);
			json(res, 200, listMemories(o.memoryDbPath, page, page_size));
			return true;
		}
		// Proactive dashboard
		if (req.method === "GET" && path === "/api/dashboard/proactive/overview") {
			json(res, 200, proactiveOverview(o.proactiveDbPath));
			return true;
		}
		if (req.method === "GET" && path === "/api/dashboard/proactive/tick_logs") {
			const { page, page_size } = pageParams(url);
			json(res, 200, listTickLogs(o.proactiveDbPath, page, page_size));
			return true;
		}
		const tickStepsMatch = path.match(/^\/api\/dashboard\/proactive\/tick_logs\/(\d+)\/steps$/);
		if (req.method === "GET" && tickStepsMatch) {
			json(res, 200, { items: listTickSteps(o.proactiveDbPath, Number(tickStepsMatch[1])) });
			return true;
		}
		const tickMatch = path.match(/^\/api\/dashboard\/proactive\/tick_logs\/(\d+)$/);
		if (req.method === "GET" && tickMatch) {
			const row = getTickLog(o.proactiveDbPath, Number(tickMatch[1]));
			if (!row) {
				json(res, 404, { error: "tick not found" });
			} else {
				json(res, 200, row);
			}
			return true;
		}
		if (req.method === "GET" && path === "/api/dashboard/proactive/deliveries") {
			const { page, page_size } = pageParams(url);
			json(res, 200, listDeliveries(o.proactiveDbPath, page, page_size));
			return true;
		}
		if (req.method === "GET" && path === "/api/dashboard/proactive/drift/active") {
			const { page, page_size } = pageParams(url);
			json(res, 200, listDriftActiveRuns(o.driftDbPath ?? "", page, page_size));
			return true;
		}
		const driftDiagnosticsMatch = path.match(/^\/api\/dashboard\/proactive\/drift\/diagnostics\/(.+)$/);
		if (req.method === "GET" && driftDiagnosticsMatch) {
			const runId = decodeURIComponent(driftDiagnosticsMatch[1] ?? "");
			const diagnostics = getDriftDiagnostics(o.driftDbPath ?? "", runId);
			if (!diagnostics) json(res, 404, { error: "drift run not found" });
			else json(res, 200, diagnostics);
			return true;
		}
		if (req.method === "POST" && path === "/api/dashboard/proactive/deliveries/ack") {
			void ackDeliveries(req, res, o);
			return true;
		}

		// 记忆
		if (req.method === "GET" && path === "/api/dashboard/memories") {
			const { page, page_size } = pageParams(url);
			json(res, 200, listMemories(o.memoryDbPath, page, page_size));
			return true;
		}
		const similarMatch = path.match(/^\/api\/dashboard\/memories\/(.+)\/similar$/);
		if (req.method === "GET" && similarMatch) {
			const id = decodeURIComponent(similarMatch[1]);
			json(res, 200, similarMemories(o.memoryDbPath, id, 5));
			return true;
		}
		if (req.method === "POST" && path === "/api/dashboard/memories/batch-delete") {
			void deleteMemoriesBatch(req, res, o);
			return true;
		}
		const memoryMatch = path.match(/^\/api\/dashboard\/memories\/(.+)$/);
		if (req.method === "GET" && memoryMatch) {
			const id = decodeURIComponent(memoryMatch[1]);
			const memory = findMemory(o.memoryDbPath, id);
			if (!memory) {
				json(res, 404, { error: "memory not found" });
			} else {
				json(res, 200, memory);
			}
			return true;
		}
		if (req.method === "DELETE" && memoryMatch) {
			const id = decodeURIComponent(memoryMatch[1]);
			const deleted = deleteMemory(o.memoryDbPath, id);
			json(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: "memory not found" });
			return true;
		}

		// 插件
		if (req.method === "GET" && path === "/api/plugins") {
			json(res, 200, { items: listPlugins(o) });
			return true;
		}
		const pluginModuleMatch = path.match(/^\/api\/plugins\/(.+)\/module$/);
		if (req.method === "GET" && pluginModuleMatch) {
			const id = decodeURIComponent(pluginModuleMatch[1]);
			const plugin = (o.plugins ?? []).find((item) => item.id === id);
			if (!plugin?.moduleSource) {
				json(res, 404, { error: "plugin module not found" });
			} else {
				res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
				res.end(plugin.moduleSource);
			}
			return true;
		}
		const pluginMatch = path.match(/^\/api\/plugins\/(.+)$/);
		if (pluginMatch) {
			const id = decodeURIComponent(pluginMatch[1]);
			const plugin = (o.plugins ?? []).find((item) => item.id === id);
			if (!plugin) {
				json(res, 404, { error: "plugin not found" });
			} else {
				void Promise.resolve(plugin.panel(req, res, url)).catch((error) => {
					json(res, 500, { error: error instanceof Error ? error.message : String(error) });
				});
			}
			return true;
		}

		// Settings
		if (req.method === "GET" && path === "/api/settings/models") {
			void probeModels(url, res);
			return true;
		}
		if (req.method === "GET" && path === "/api/settings/state") {
			const saved = {
				...defaultSettings(),
				...(readJsonFile(o.settingsPath ?? "") as Record<string, unknown> | null | undefined),
			};
			const runtimes = (saved.runtimes ?? {}) as Record<string, Record<string, unknown>>;
			const activeRuntime = typeof saved.activeRuntime === "string" ? saved.activeRuntime : "api";
			json(res, 200, {
				...saved,
				// 兼容:agentTick = 当前生效 runtime 的映射
				agentTick: runtimes[activeRuntime] ?? runtimes.api ?? defaultRuntime(),
			});
			return true;
		}
		if (req.method === "POST" && path === "/api/settings/save") {
			void saveSettings(req, res, o);
			return true;
		}
	} catch (error) {
		json(res, 500, { error: error instanceof Error ? error.message : String(error) });
		return true;
	}
	return false;
}

/** 探测 OpenAI 兼容端点 /models,返回模型列表。 */
async function probeModels(url: URL, res: ServerResponse): Promise<void> {
	const baseUrl = url.searchParams.get("baseUrl") ?? "";
	const apiKey = url.searchParams.get("apiKey") ?? "";
	if (!baseUrl) {
		json(res, 400, { error: "baseUrl 必填" });
		return;
	}
	const endpoint = `${baseUrl.replace(/\/$/, "")}/models`;
	try {
		const response = await fetch(endpoint, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
			signal: AbortSignal.timeout(8000),
		});
		if (!response.ok) {
			json(res, 502, { error: `模型接口返回 ${response.status}` });
			return;
		}
		const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
		const models = Array.isArray(payload.data)
			? payload.data.filter((item) => typeof item.id === "string").map((item) => String(item.id))
			: [];
		json(res, 200, { models });
	} catch (error) {
		json(res, 502, { error: error instanceof Error ? error.message : String(error) });
	}
}

async function saveSettings(req: IncomingMessage, res: ServerResponse, o: WebApiOptions): Promise<void> {
	let body = "";
	for await (const chunk of req) body += chunk;
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		// 兼容旧格式:只有 agentTick 时迁移为 runtimes
		if (!parsed.runtimes && parsed.agentTick && typeof parsed.agentTick === "object") {
			parsed.runtimes = { api: parsed.agentTick };
			parsed.activeRuntime = "api";
		}
		writeJsonFile(o.settingsPath ?? join(dirnameOf(o.proactiveDbPath), "web-settings.json"), parsed);
		json(res, 200, { ok: true });
	} catch (error) {
		json(res, 400, { error: error instanceof Error ? error.message : String(error) });
	}
}

function readMcpConfig(path: string | undefined): Record<string, unknown> {
	if (!path || !existsSync(path)) return {};
	const parsed = readJsonFile(path) as { mcpServers?: Record<string, unknown> } | null;
	return parsed?.mcpServers ?? {};
}

function readSourcesOverview(): Record<string, unknown> {
	// 数据源是代码模块,这里只提供内置目录的存在性概览。
	return { sources: 0 };
}
