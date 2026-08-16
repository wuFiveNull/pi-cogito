/**
 * Drift tools — LLM-callable tool registry (akashic plugins/drift_flow/tools.py port).
 *
 * Tools: select_skill / idle_drift / finish_drift / read_file / list_dir /
 * write_file / edit_file / shell / fetch_messages / search_messages /
 * recall_memory / read_journal / message_push / mount_server(host 提供
 * DriftMcpConnections 时注册)。web_fetch、web_search、write_stdin、task_stop
 * 等宿主工具可通过 sharedTools 注入。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
	DriftDeliverySink,
	DriftOutboundAttachment,
	DriftWebDnsLookupFn,
	DriftWebFetchFn,
	DriftWebPolicy,
	DriftWebSearchFn,
} from "@cogito/gate";
import {
	boundedNumber,
	DEFAULT_WEB_MAX_CHARS as DEFAULT_WEB_MAX_CHARS_GATE,
	DEFAULT_WEB_MAX_RESULTS as DEFAULT_WEB_MAX_RESULTS_GATE,
	DEFAULT_WEB_TIMEOUT_MS as DEFAULT_WEB_TIMEOUT_MS_GATE,
	fetchWebPage,
	hashOutboundMessage,
	isHttpUrl,
	type RecallEmbeddingFn,
	type RecalledPreference,
	recallPreferences,
	recallPreferencesRanked,
	searchWebPage,
	validateResolvedWebUrl,
	validateWebUrl,
} from "@cogito/gate";

export type {
	DriftDeliveryReceipt,
	DriftDeliveryRecord,
	DriftDeliverySink,
	DriftDeliveryStatus,
	DriftWebDnsLookupFn,
	DriftWebFetchFn,
	DriftWebFetchResult,
	DriftWebPolicy,
	DriftWebResolvedAddress,
	DriftWebSearchFn,
	DriftWebSearchItem,
} from "@cogito/gate";

import type { DriftRunContext } from "./runtime.ts";
import type { DriftStateStore } from "./state.ts";

const DRIFT_DECISIONS = new Set(["continue", "defer", "switch", "explore"]);

function clipText(text: unknown, limit: number): string {
	return String(text ?? "")
		.trim()
		.slice(0, limit);
}

export type DriftToolRisk = "read-only" | "write" | "external-side-effect";

export interface DriftToolMeta {
	/** Where the implementation came from: built-in, a host extension, or MCP. */
	source: string;
	risk: DriftToolRisk;
	/** Host policy may require explicit approval for this call. */
	requiresApproval?: boolean;
	/** Optional host-enforced execution budget for this tool. */
	timeoutMs?: number;
}

export interface DriftToolAuthorizationRequest {
	tool: DriftTool;
	meta: DriftToolMeta;
	args: Readonly<Record<string, unknown>>;
	ctx: DriftRunContext;
}

export type DriftToolAuthorizationResult = boolean | string | undefined;

export interface DriftToolCallEvent {
	toolName: string;
	meta: DriftToolMeta;
	argsPreview: string;
	durationMs: number;
	result: "success" | "error" | "denied";
	error?: string;
}

export interface DriftToolPolicy {
	authorize?(
		request: DriftToolAuthorizationRequest,
	): DriftToolAuthorizationResult | Promise<DriftToolAuthorizationResult>;
	onCall?(event: DriftToolCallEvent, ctx: DriftRunContext): void | Promise<void>;
}

/** JSON schema + execute contract for one drift tool. */
export interface DriftTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	meta?: Partial<DriftToolMeta>;
	execute(args: Record<string, unknown>, ctx: DriftRunContext): Promise<string>;
}

const READ_ONLY_TOOL_NAMES = new Set([
	"read_file",
	"list_dir",
	"fetch_messages",
	"search_messages",
	"recall_memory",
	"read_journal",
	"web_fetch",
	"web_search",
]);
const WRITE_TOOL_NAMES = new Set(["select_skill", "idle_drift", "finish_drift", "write_file", "edit_file"]);
const EXTERNAL_TOOL_NAMES = new Set(["message_push", "shell", "write_stdin", "task_stop", "mount_server"]);

export function inferDriftToolMeta(name: string): DriftToolMeta {
	const normalized = name.trim();
	if (READ_ONLY_TOOL_NAMES.has(normalized)) return { source: "builtin", risk: "read-only" };
	if (WRITE_TOOL_NAMES.has(normalized)) return { source: "builtin", risk: "write" };
	if (EXTERNAL_TOOL_NAMES.has(normalized)) {
		return { source: "builtin", risk: "external-side-effect", requiresApproval: true };
	}
	return { source: "shared", risk: "external-side-effect", requiresApproval: true };
}

export function getDriftToolMeta(tool: DriftTool): DriftToolMeta {
	const inferred = inferDriftToolMeta(tool.name);
	const declared = tool.meta ?? {};
	const timeoutMs =
		typeof declared.timeoutMs === "number" && Number.isFinite(declared.timeoutMs) && declared.timeoutMs > 0
			? Math.trunc(declared.timeoutMs)
			: inferred.timeoutMs;
	return {
		...inferred,
		...declared,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	};
}

/**
 * 可扩展的 Drift 工具注册表。
 * 内置工具优先；同名工具不会覆盖已有注册。list() 返回 live view，
 * 使 mount_server 在一次 run 中注册 MCP 工具后，执行循环可以立即看到它。
 */
export class DriftToolRegistry {
	private readonly byName = new Map<string, DriftTool>();
	private readonly tools: DriftTool[] = [];

	constructor(initial: readonly DriftTool[] = []) {
		this.registerMany(initial);
	}

	register(tool: DriftTool, options: { source?: string } = {}): boolean {
		const name = tool.name.trim();
		if (!name || this.byName.has(name)) return false;
		const source = options.source?.trim();
		const registered = source && !tool.meta?.source ? { ...tool, meta: { ...tool.meta, source } } : tool;
		this.byName.set(name, registered);
		this.tools.push(registered);
		return true;
	}

	registerMany(tools: readonly DriftTool[]): void {
		for (const tool of tools) this.register(tool);
	}

	get(name: string): DriftTool | undefined {
		return this.byName.get(name);
	}

	metadata(name: string): DriftToolMeta | undefined {
		const tool = this.get(name);
		return tool ? getDriftToolMeta(tool) : undefined;
	}

	has(name: string): boolean {
		return this.byName.has(name);
	}

	names(): string[] {
		return this.tools.map((tool) => tool.name);
	}

	list(): DriftTool[] {
		return this.tools;
	}

	/** 按名称或描述搜索工具，供宿主在工具较多时做延迟选择。 */
	search(query: string, limit = 20): DriftTool[] {
		const terms = query
			.trim()
			.toLowerCase()
			.split(/\s+/)
			.filter((term) => term.length > 0);
		if (terms.length === 0) return this.tools.slice(0, Math.max(0, limit));
		return this.tools
			.map((tool, index) => {
				const name = tool.name.toLowerCase();
				const description = tool.description.toLowerCase();
				const score = terms.reduce(
					(total, term) => total + (name.includes(term) ? 2 : 0) + (description.includes(term) ? 1 : 0),
					0,
				);
				return { tool, index, score };
			})
			.filter((entry) => entry.score > 0)
			.sort((left, right) => right.score - left.score || left.index - right.index)
			.slice(0, Math.max(0, limit))
			.map((entry) => entry.tool);
	}
}

/** 宿主提供的已连接 MCP server 的单个工具(宿主用 packages/mcp client 维护连接)。 */
export interface DriftMcpTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	call(args: Record<string, unknown>): Promise<string>;
}

/** 已连接的 MCP server 工具面。 */
export interface DriftMcpServer {
	name: string;
	tools: DriftMcpTool[];
}

/** Drift 可挂载的 MCP 连接(requires_mcp 过滤 + mount_server)。 */
export interface DriftMcpConnections {
	servers: DriftMcpServer[];
}

export interface DriftSessionMessage {
	role: "user" | "assistant" | "system";
	content: string;
	timestamp?: number | string;
}

export interface DriftSessionAccess {
	fetchMessages?(input: {
		sessionKey: string;
		sourceRef?: string;
		limit: number;
		now: Date;
	}): Promise<readonly DriftSessionMessage[] | undefined> | readonly DriftSessionMessage[] | undefined;
	searchMessages?(input: {
		sessionKey: string;
		query: string;
		limit: number;
		now: Date;
	}): Promise<readonly DriftSessionMessage[] | undefined> | readonly DriftSessionMessage[] | undefined;
}

export interface DriftPathPolicy {
	/** Allow absolute read/list paths outside the Drift and workspace roots. */
	allowAbsolutePaths?: boolean;
	/** Additional roots readable by Drift tools. */
	allowedReadDirs?: readonly string[];
	/** Additional roots writable by Drift tools. */
	allowedWriteDirs?: readonly string[];
	/** Additional directories accepted as shell working directories. */
	allowedShellDirs?: readonly string[];
}

export interface DriftToolDeps {
	driftDir: string;
	store: DriftStateStore;
	workspaceDir: string;
	/** Path of the memory engine database (recall_memory). */
	memoryDbPath?: string;
	/** Sessions directory (fetch_messages / search_messages). */
	sessionsDir?: string;
	/** Host-owned session access; file scanning is used when absent. */
	sessionAccess?: DriftSessionAccess;
	/** Delivery sink; the pipeline commits a staged message here after finish_drift. */
	storeDb?: DriftDeliverySink;
	/** 批量嵌入(recall_memory 向量召回;缺省回退 LIKE)。 */
	memoryEmbeddingFn?: RecallEmbeddingFn;
	/** 宿主长期记忆检索；提供后优先于直接打开 memory.sqlite。 */
	memoryRecallFn?: (query: string, limit: number) => RecalledPreference[] | Promise<RecalledPreference[]>;
	/** 已连接的 MCP server(requires_mcp 过滤 + mount_server 挂载)。 */
	mcp?: DriftMcpConnections;
	/** 宿主共享工具；同名内置工具优先，其他工具加入 Drift registry。 */
	sharedTools?: readonly DriftTool[];
	/** 宿主授权和工具审计策略。 */
	toolPolicy?: DriftToolPolicy;
	/** 文件与 shell 工作目录边界。 */
	pathPolicy?: DriftPathPolicy;
	/** 可选宿主 web_fetch 实现；未提供时使用内置 HTTP 实现。 */
	webFetchFn?: DriftWebFetchFn;
	/** 可选宿主 web_search 实现；未提供时使用 webSearchUrl。 */
	webSearchFn?: DriftWebSearchFn;
	/** OpenAI/Brave 风格的 HTTP 搜索 endpoint，查询参数为 q。 */
	webSearchUrl?: string;
	/** 可选搜索 API key；同时发送 Bearer 与 X-Subscription-Token。 */
	webSearchApiKey?: string;
	webMaxChars?: number;
	webMaxResults?: number;
	webRequestTimeoutMs?: number;
	/** web_fetch 内置 HTTP 实现的 SSRF/域名边界。 */
	webPolicy?: DriftWebPolicy;
	/** Optional resolver override; native requests connect to the validated address. */
	webDnsLookupFn?: DriftWebDnsLookupFn;
}

/** Resolve virtual Drift paths and enforce read/write roots. */
class DriftPathResolver {
	private readonly driftDir: string;
	private readonly workspaceDir: string;
	private readonly store: DriftStateStore;
	private readonly readDirs: readonly string[];
	private readonly writeDirs: readonly string[];
	private readonly allowAbsolutePaths: boolean;

	constructor(driftDir: string, workspaceDir: string, store: DriftStateStore, policy: DriftPathPolicy = {}) {
		this.driftDir = resolve(driftDir);
		this.workspaceDir = resolve(workspaceDir);
		this.store = store;
		this.allowAbsolutePaths = policy.allowAbsolutePaths ?? false;
		const skillDirs = [...store.validSkillNames()].flatMap((name) => {
			const skillDir = store.skillDirFor(name);
			return skillDir ? [skillDir] : [];
		});
		this.readDirs = uniquePaths([this.driftDir, this.workspaceDir, ...skillDirs, ...(policy.allowedReadDirs ?? [])]);
		this.writeDirs = uniquePaths([this.driftDir, this.workspaceDir, ...(policy.allowedWriteDirs ?? [])]);
	}

	resolve(path: string, access: "read" | "write" = "read"): string | null {
		const raw = String(path ?? "").trim();
		if (!raw) return null;
		const expanded = raw.startsWith("~") ? join(process.env.HOME ?? "/tmp", raw.slice(1)) : raw;
		const absoluteInput = isAbsolute(expanded);
		let target: string;
		if (absoluteInput) {
			target = resolve(expanded);
		} else {
			const parts = raw.split("/");
			if (parts.length >= 2 && parts[0] === "skills") {
				const skillDir = this.store.skillDirFor(parts[1]!);
				if (skillDir) target = join(skillDir, ...parts.slice(2));
				else target = join(this.driftDir, raw);
			} else if (parts.length >= 2 && parts[0] === "workspace") {
				target = join(this.workspaceDir, ...parts.slice(1));
			} else if (parts.length >= 2 && parts[0] === "drift") {
				target = join(this.driftDir, ...parts.slice(1));
			} else {
				target = join(this.driftDir, raw);
			}
			target = resolve(target);
		}
		const roots = access === "write" ? this.writeDirs : this.readDirs;
		const mustStayInRoots = access === "write" || !absoluteInput || !this.allowAbsolutePaths;
		if (mustStayInRoots && !isInsideAnyAllowed(roots, target)) return null;
		return target;
	}
}

// ------------------------------------------------------------------
// message_push (akashic SendMessageTool)
// ------------------------------------------------------------------

class SendMessageTool implements DriftTool {
	name = "message_push";
	description =
		"向用户发送一条消息，可附带图片、媒体或文件。单次 Drift run 最多只能调用一次。\n" +
		"target_channel 和 target_chat_id 可选；省略时由宿主投递口使用默认目标。\n" +
		"这是 fire-and-forget：消息先暂存，并在 finish_drift 后提交给宿主，不创建等待回复的状态。" +
		"未来若出现用户回答，它会作为新的会话上下文和记忆自然进入；" +
		"不得记录‘等用户回复’，也不得把‘没有回复’当成可观测事实。";

	parameters = {
		type: "object",
		properties: {
			message: { type: "string", description: "要发送的消息内容" },
			image: { type: "string", description: "要发送的一张图片路径或 URL" },
			file: { type: "string", description: "要发送的一个文件路径或 URL" },
			media: {
				type: "array",
				items: { type: "string" },
				description: "要随消息发送的图片或媒体路径、URL 列表",
			},
			target_channel: { type: "string", description: "目标渠道；省略时使用宿主默认渠道" },
			target_chat_id: { type: "string", description: "目标会话 ID；省略时使用宿主默认会话" },
		},
		required: [],
	};

	private readonly deps: DriftToolDeps;
	private readonly ctx: DriftRunContext;

	constructor(deps: DriftToolDeps, ctx: DriftRunContext) {
		this.deps = deps;
		this.ctx = ctx;
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const text = String(args.message ?? "").trim();
		const media = normalizeMedia(args.image, args.media);
		const attachments = normalizeAttachments(args.file);
		const targetChannel = String(args.target_channel ?? "").trim();
		const targetChatId = String(args.target_chat_id ?? "").trim();
		if (this.ctx.driftMessageStaged) {
			return JSON.stringify({ error: "message_push already used in this drift run" });
		}
		if (!text && media.length === 0 && attachments.length === 0) {
			return JSON.stringify({ error: "message, media, or file is required" });
		}
		// 投递前查重(宿主 sink 实现,如 24h hash 窗口):重复则拒绝,LLM 改走静默闭环。
		if (this.deps.storeDb?.dedupeCheck) {
			const check = this.deps.storeDb.dedupeCheck(text, media, targetChannel, targetChatId, attachments);
			if (check.duplicate) {
				return JSON.stringify({
					error: `message_push rejected: ${check.reason ?? "duplicate"}`,
				});
			}
		}
		this.ctx.draftMessage = text;
		this.ctx.draftMedia = media;
		this.ctx.draftAttachments = attachments;
		this.ctx.draftTargetChannel = targetChannel;
		this.ctx.draftTargetChatId = targetChatId;
		this.ctx.driftMessageStaged = true;
		const messageHash = hashOutboundMessage(text, media, attachments, targetChannel, targetChatId);
		this.ctx.driftMessageHash = messageHash;
		this.deps.store.updateRunProgress({
			runId: this.ctx.runId,
			stage: "message_staged",
			nowUtc: this.ctx.nowUtc,
			messageHash,
			message: text,
			media,
			attachments,
			targetChannel,
			targetChatId,
		});
		return JSON.stringify({
			ok: true,
			delivery_semantics: "staged_fire_and_forget",
			reply_state: "not_tracked",
			next: "finish_drift_without_waiting_for_user",
		});
	}
}

function normalizeMedia(image: unknown, media: unknown): string[] {
	const values: unknown[] = [];
	if (typeof image === "string") values.push(image);
	if (typeof media === "string") values.push(media);
	else if (Array.isArray(media)) values.push(...media);
	return values.map((value) => String(value ?? "").trim()).filter((value) => value.length > 0);
}

function normalizeAttachments(file: unknown): DriftOutboundAttachment[] {
	const values = typeof file === "string" ? [file] : Array.isArray(file) ? file : [];
	return values.flatMap((value) => {
		const source = typeof value === "string" ? value.trim() : "";
		if (!source) return [];
		const filename = source.startsWith("data:") ? undefined : basename(source.split("?")[0] ?? "") || undefined;
		return [{ kind: "file" as const, source, ...(filename ? { filename } : {}) }];
	});
}

// ------------------------------------------------------------------
// finish_drift (akashic FinishDriftTool)
// ------------------------------------------------------------------

class FinishDriftTool implements DriftTool {
	name = "finish_drift";
	description = "【终止工具】结束本次 Drift，保存本轮摘要和连续性前情。调用后 loop 立即结束。";

	parameters = {
		type: "object",
		properties: {
			skill_used: { type: "string" },
			status: {
				type: "string",
				enum: ["completed", "paused"],
				description:
					"completed 表示本轮主动行为已闭环，包含已行动、检查后无事可做、或判断当前不合时宜后静默结束；" +
					"paused 表示本轮因工具、外部服务、步数上限或中间处理未完成而中断，scratchpad_update 必须写清已经做到哪里、下次从哪里继续。",
			},
			briefing: { type: "string", description: "本轮做了什么的一句话摘要" },
			scratchpad_update: {
				type: "string",
				description:
					"下次进入本 skill 时需要注入的自然语言前情，只记录系统自己的进度。" +
					"<example>已生成 plan.json，下次从执行计划继续。</example>" +
					"<example>不要：已向用户提问，等待用户回复。</example>",
			},
			cursor_update: { type: "object", description: "结构化游标，供下轮脚本或流程直接决定下一步" },
			journal_append: {
				type: "array",
				description: "追加本轮已完成事实，例如已问过、已生成、已审计",
				items: {
					type: "object",
					properties: {
						entry_type: { type: "string" },
						key: { type: "string" },
						payload: { type: "object" },
					},
					required: ["entry_type"],
				},
			},
			global_note_update: { type: "string" },
			self_update: {
				type: "object",
				description: "收尾后的自我连续性更新，不保存执行断点或长期人格事实。",
				properties: {
					current_intention: { type: "string", description: "如果本轮改变了原意图，写更新后的意图" },
					reflection: {
						type: "string",
						description:
							"用一句话对照本轮与 recent_drift_runs：是在自由延续、主动变化，还是可能只走了最省事的路径。",
					},
					pattern: {
						type: "string",
						enum: ["ordinary", "repeat", "change", "contradiction"],
						description:
							"本轮与近期行为的关系。ordinary=没有形成模式；repeat=重复出现；change=主动换了做法；contradiction=出现反例。" +
							"选择 repeat/change/contradiction 时必须同时写 observation。",
					},
					next_tendency: {
						type: "string",
						description:
							"下次空闲时可能想继续、搁置或探索的宽松倾向，不是下一轮必须执行的题目或步骤。" +
							"不能写等待用户回答、如果用户没回答就怎样。",
					},
					observation: {
						type: "object",
						description:
							"仅当本轮与近期多轮的实际选择形成了重复、反例或变化时，留下可被后续 Drift 质疑或修正的暂定观察；没有则省略。",
						properties: {
							statement: { type: "string" },
							basis: { type: "string" },
							effect: { type: "string", enum: ["question", "reinforce", "revise"] },
						},
						required: ["statement", "basis", "effect"],
					},
				},
				required: ["next_tendency", "reflection", "pattern"],
			},
		},
		required: ["skill_used", "status", "briefing", "self_update"],
	};

	private readonly store: DriftStateStore;
	private readonly ctx: DriftRunContext;

	constructor(store: DriftStateStore, ctx: DriftRunContext) {
		this.store = store;
		this.ctx = ctx;
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const skillName = String(args.skill_used ?? "").trim();
		if (!this.store.validSkillNames().has(skillName)) {
			return JSON.stringify({ error: `unknown skill: ${skillName}` });
		}
		const selected = this.ctx.driftSelectedSkill.trim();
		if (selected && skillName !== selected) {
			return JSON.stringify({ error: `skill_used must match selected skill: ${selected}` });
		}
		const statusValue = String(args.status ?? "").trim();
		if (statusValue !== "completed" && statusValue !== "paused") {
			return JSON.stringify({ error: "status must be one of: completed, paused" });
		}
		const summary = String(args.briefing ?? "").trim();
		if (!summary) {
			return JSON.stringify({ error: "briefing is required" });
		}
		const scratchpadText = String(args.scratchpad_update ?? "").trim();
		if (statusValue === "paused" && !scratchpadText) {
			return JSON.stringify({ error: "scratchpad_update is required when status is paused" });
		}
		const messageResultValue = this.ctx.driftMessageStaged ? "staged" : "silent";
		const cursorUpdate = args.cursor_update;
		if (
			cursorUpdate !== undefined &&
			cursorUpdate !== null &&
			(typeof cursorUpdate !== "object" || Array.isArray(cursorUpdate))
		) {
			return JSON.stringify({ error: "cursor_update must be an object" });
		}
		const { entries: journalEntries, error: journalError } = normalizeJournalAppend(args.journal_append);
		if (journalError) {
			return JSON.stringify({ error: journalError });
		}
		const selfUpdate = args.self_update;
		if (
			selfUpdate === undefined ||
			selfUpdate === null ||
			typeof selfUpdate !== "object" ||
			Array.isArray(selfUpdate)
		) {
			return JSON.stringify({ error: "self_update must be an object" });
		}
		const nextTendency = String((selfUpdate as Record<string, unknown>).next_tendency ?? "").trim();
		if (!nextTendency) {
			return JSON.stringify({ error: "self_update.next_tendency is required" });
		}
		const reflection = String((selfUpdate as Record<string, unknown>).reflection ?? "").trim();
		if (!reflection) {
			return JSON.stringify({ error: "self_update.reflection is required" });
		}
		const pattern = String((selfUpdate as Record<string, unknown>).pattern ?? "").trim();
		if (!new Set(["ordinary", "repeat", "change", "contradiction"]).has(pattern)) {
			return JSON.stringify({
				error: "self_update.pattern must be one of: ordinary, repeat, change, contradiction",
			});
		}
		const normalizedSelfUpdate: Record<string, string> = {
			current_intention: String((selfUpdate as Record<string, unknown>).current_intention ?? "").trim(),
			next_tendency: nextTendency,
		};
		const { observation, error: observationError } = normalizeSelfObservation(
			(selfUpdate as Record<string, unknown>).observation,
		);
		if (observationError) {
			return JSON.stringify({ error: observationError });
		}
		if (pattern !== "ordinary" && observation === null) {
			return JSON.stringify({ error: `self_update.observation is required when pattern is ${pattern}` });
		}
		if (observation) {
			journalEntries.push({
				entry_type: "self_observation",
				key: observation.effect,
				payload: observation,
			});
		}
		const noteText =
			args.global_note_update !== undefined && args.global_note_update !== null
				? String(args.global_note_update).trim()
				: null;
		if (!selected) {
			this.ctx.driftSelectedSkill = skillName;
		}
		this.store.updateRunProgress({
			runId: this.ctx.runId,
			stage: "finishing",
			nowUtc: this.ctx.nowUtc,
			skillName,
			messageHash: messageResultValue === "staged" ? this.ctx.driftMessageHash : undefined,
			message: this.ctx.draftMessage,
			media: this.ctx.draftMedia,
			attachments: this.ctx.draftAttachments,
			targetChannel: this.ctx.draftTargetChannel,
			targetChatId: this.ctx.draftTargetChatId,
		});
		this.store.saveFinish({
			runId: this.ctx.runId,
			sessionKey: this.ctx.sessionKey,
			startedAt: this.ctx.nowUtc,
			skillUsed: skillName,
			status: statusValue,
			briefing: summary,
			messageResult: messageResultValue,
			scratchpadUpdate: scratchpadText || null,
			globalNoteUpdate: noteText,
			nowUtc: this.ctx.nowUtc,
			cursorUpdate: (cursorUpdate as Record<string, unknown>) ?? null,
			journalAppend: journalEntries,
			selfUpdate: normalizedSelfUpdate,
			messageHash: messageResultValue === "staged" ? this.ctx.driftMessageHash : null,
			message: this.ctx.draftMessage,
			media: this.ctx.draftMedia,
			attachments: this.ctx.draftAttachments,
			targetChannel: this.ctx.draftTargetChannel,
			targetChatId: this.ctx.draftTargetChatId,
		});
		this.ctx.driftFinished = true;
		this.ctx.driftFinishStatus = statusValue;
		this.ctx.driftFinishBriefing = summary;
		return JSON.stringify({ ok: true });
	}
}

function normalizeSelfObservation(raw: unknown): { observation: Record<string, string> | null; error: string } {
	if (raw === undefined || raw === null) return { observation: null, error: "" };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		return { observation: null, error: "self_update.observation must be an object" };
	}
	const record = raw as Record<string, unknown>;
	const effect = String(record.effect ?? "").trim();
	if (!new Set(["question", "reinforce", "revise"]).has(effect)) {
		return { observation: null, error: "self_update.observation.effect must be one of: question, reinforce, revise" };
	}
	const statement = String(record.statement ?? "").trim();
	const basis = String(record.basis ?? "").trim();
	if (!statement) return { observation: null, error: "self_update.observation.statement is required" };
	if (!basis) return { observation: null, error: "self_update.observation.basis is required" };
	return {
		observation: { statement: clipText(statement, 500), basis: clipText(basis, 500), effect },
		error: "",
	};
}

function normalizeJournalAppend(raw: unknown): {
	entries: Array<Record<string, unknown>>;
	error: string;
} {
	if (raw === undefined || raw === null) return { entries: [], error: "" };
	const items = Array.isArray(raw) ? raw : [raw];
	const result: Array<Record<string, unknown>> = [];
	for (const item of items) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			return { entries: [], error: "journal_append items must be objects" };
		}
		const data = item as Record<string, unknown>;
		const entryType = String(data.entry_type ?? "").trim();
		if (!entryType) return { entries: [], error: "journal_append.entry_type is required" };
		const payload = data.payload;
		if (payload !== undefined && payload !== null && (typeof payload !== "object" || Array.isArray(payload))) {
			return { entries: [], error: "journal_append.payload must be an object" };
		}
		result.push({
			entry_type: entryType,
			key: String(data.key ?? "").trim(),
			payload: payload !== null && typeof payload === "object" ? payload : {},
		});
	}
	return { entries: result, error: "" };
}

// ------------------------------------------------------------------
// select_skill / idle_drift
// ------------------------------------------------------------------

class SelectSkillTool implements DriftTool {
	name = "select_skill";
	description = "声明本轮 Drift 的意图与选择，并返回所选 skill 的说明和 local_context。";

	parameters = {
		type: "object",
		properties: {
			skill_name: { type: "string", description: "本轮要执行的 drift skill 名称" },
			decision: {
				type: "string",
				enum: [...DRIFT_DECISIONS].sort(),
				description: "本轮与既有意图的关系：继续、延后、切换或自由探索",
			},
			intention: { type: "string", description: "这轮此刻真正想做的一件小事，不照抄上轮 next_tendency。" },
			reason: {
				type: "string",
				description: "结合当前状态、近期 runs 和已有 skill 覆盖范围，说明为什么此刻这样选择。",
			},
		},
		required: ["skill_name", "decision", "intention", "reason"],
	};

	private readonly store: DriftStateStore;
	private readonly ctx: DriftRunContext;

	constructor(store: DriftStateStore, ctx: DriftRunContext) {
		this.store = store;
		this.ctx = ctx;
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const name = String(args.skill_name ?? "").trim();
		const decisionValue = String(args.decision ?? "").trim();
		const intentionText = String(args.intention ?? "").trim();
		const reasonText = String(args.reason ?? "").trim();
		if (!this.store.validSkillNames().has(name)) {
			return JSON.stringify({ error: `unknown skill: ${name}` });
		}
		if (!DRIFT_DECISIONS.has(decisionValue)) {
			return JSON.stringify({ error: "decision must be one of: continue, defer, switch, explore" });
		}
		if (!intentionText) return JSON.stringify({ error: "intention is required" });
		if (!reasonText) return JSON.stringify({ error: "reason is required" });
		const selected = this.ctx.driftSelectedSkill.trim();
		if (selected && selected !== name) {
			return JSON.stringify({ error: `selected skill already fixed: ${selected}` });
		}
		const skillDir = this.store.skillDirFor(name);
		if (!skillDir) return JSON.stringify({ error: `skill not mounted: ${name}` });
		let content: string;
		try {
			content = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
		} catch (error) {
			return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
		}
		this.ctx.driftSelectedSkill = name;
		this.store.updateRunProgress({
			runId: this.ctx.runId,
			stage: "selected",
			nowUtc: this.ctx.nowUtc,
			skillName: name,
		});
		this.store.saveSelfChoice({
			skillName: name,
			intention: intentionText,
			decision: decisionValue,
			reason: reasonText,
			nowUtc: this.ctx.nowUtc,
		});
		const continuum = this.store.loadSkillContinuum(name);
		const journalRecent = this.store.loadSkillJournal(name, { limit: 8 });
		return JSON.stringify({
			ok: true,
			skill: name,
			content,
			local_context: {
				run_count: Number(continuum.runCount ?? 0),
				last_status: clipText(continuum.lastStatus, 40),
				last_run_at: clipText(continuum.lastRunAt, 80),
				updated_at: clipText(continuum.updatedAt, 80),
				last_briefing: clipText(continuum.lastBriefing, 500),
				scratchpad: clipText(continuum.scratchpad, 2000),
				cursor: continuum.cursor ?? {},
				journal_recent: journalRecent,
			},
			runtime_guidance:
				continuum.lastStatus === "paused"
					? "这是 paused skill 的可续接停点。SKILL.md 是完整能力说明书，不是本轮从头执行清单。" +
						"先用 local_context 区分已完成与未完成步骤；如果继续，只执行停点后的最小下一步。" +
						"不要仅为遵循完整流程而重复读取、查重、规划或重建已有产物。"
					: "本 skill 上轮已闭环；根据当前目标选择本轮实际需要的说明书部分。",
		});
	}
}

class IdleDriftTool implements DriftTool {
	name = "idle_drift";
	description = "【例外终止工具】仅在近期气氛、频率或风险明确不合适时，不选择 skill 并静默结束；reason 必填。";

	parameters = {
		type: "object",
		properties: {
			reason: {
				type: "string",
				description: "具体时机或风险原因，例如刚主动发过消息、丧亲/疾病/强压力语境、当前行动会明显低价值重复。",
			},
		},
		required: ["reason"],
	};

	private readonly store: DriftStateStore;
	private readonly ctx: DriftRunContext;

	constructor(store: DriftStateStore, ctx: DriftRunContext) {
		this.store = store;
		this.ctx = ctx;
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const reasonText = String(args.reason ?? "").trim();
		if (!reasonText) return JSON.stringify({ error: "reason is required" });
		const selected = this.ctx.driftSelectedSkill.trim();
		if (selected) {
			return JSON.stringify({ error: "idle_drift must be called before select_skill" });
		}
		this.ctx.driftSelectedSkill = "idle";
		this.store.saveSelfChoice({
			skillName: "idle",
			intention: "本轮暂时不行动",
			decision: "rest",
			reason: reasonText,
			nowUtc: this.ctx.nowUtc,
		});
		this.store.saveFinish({
			runId: this.ctx.runId,
			sessionKey: this.ctx.sessionKey,
			startedAt: this.ctx.nowUtc,
			skillUsed: "idle",
			status: "completed",
			briefing: clipText(`空闲不行动：${reasonText}`, 500),
			messageResult: "silent",
			scratchpadUpdate: null,
			globalNoteUpdate: null,
			nowUtc: this.ctx.nowUtc,
			selfUpdate: { next_tendency: "等待更合适的时机再自由选择" },
		});
		this.ctx.driftFinished = true;
		return JSON.stringify({ ok: true });
	}
}

// ------------------------------------------------------------------
// Filesystem tools (DriftPathResolver + allowed-dir writes)
// ------------------------------------------------------------------

class ReadFileTool implements DriftTool {
	name = "read_file";
	description = "读取文件内容。相对路径解析到 drift 工作区；也支持 skills/<name>/... 和 workspace/<path>。";
	parameters = {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	};

	private readonly resolver: DriftPathResolver;
	constructor(resolver: DriftPathResolver) {
		this.resolver = resolver;
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const resolved = this.resolver.resolve(String(args.path ?? ""), "read");
		if (!resolved || !existsSync(resolved) || !statSync(resolved).isFile()) {
			return JSON.stringify({ error: `file not found: ${String(args.path ?? "")}` });
		}
		try {
			return readFileSync(resolved, "utf-8");
		} catch (error) {
			return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
		}
	}
}

class ListDirTool implements DriftTool {
	name = "list_dir";
	description = "列出目录内容。相对路径解析到 drift 工作区；也支持 workspace/<path>。";
	parameters = {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	};

	private readonly resolver: DriftPathResolver;
	constructor(resolver: DriftPathResolver) {
		this.resolver = resolver;
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const resolved = this.resolver.resolve(String(args.path ?? "."), "read");
		if (!resolved || !existsSync(resolved)) {
			return JSON.stringify({ error: `directory not found: ${String(args.path ?? "")}` });
		}
		try {
			const entries = readdirSync(resolved).map((name) => {
				const full = join(resolved, name);
				return `${statSync(full).isDirectory() ? "[d]" : "[f]"} ${name}`;
			});
			return entries.join("\n") || "(empty)";
		} catch (error) {
			return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
		}
	}
}

class WriteFileTool implements DriftTool {
	name = "write_file";
	description = "写入文件（覆盖）。只能写 drift 或 workspace 工作区内的路径。";
	parameters = {
		type: "object",
		properties: { path: { type: "string" }, content: { type: "string" } },
		required: ["path", "content"],
	};

	private readonly resolver: DriftPathResolver;
	private readonly allowedDirs: readonly string[];

	constructor(resolver: DriftPathResolver, allowedDirs: readonly string[]) {
		this.resolver = resolver;
		this.allowedDirs = allowedDirs;
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const resolved = this.resolver.resolve(String(args.path ?? ""), "write");
		if (!resolved || !isInsideAnyAllowed(this.allowedDirs, resolved)) {
			return JSON.stringify({ error: `path outside allowed Drift workspace: ${String(args.path ?? "")}` });
		}
		try {
			mkdirSync(dirname(resolved), { recursive: true });
			writeFileSync(resolved, String(args.content ?? ""), "utf-8");
			return JSON.stringify({ ok: true, path: relative(firstAllowedDir(this.allowedDirs, resolved), resolved) });
		} catch (error) {
			return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
		}
	}
}

class EditFileTool implements DriftTool {
	name = "edit_file";
	description = "编辑文件：将 old_text 首次出现处替换为 new_text。只能编辑 drift 或 workspace 工作区内的路径。";
	parameters = {
		type: "object",
		properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
		required: ["path", "old_text", "new_text"],
	};

	private readonly resolver: DriftPathResolver;
	private readonly allowedDirs: readonly string[];

	constructor(resolver: DriftPathResolver, allowedDirs: readonly string[]) {
		this.resolver = resolver;
		this.allowedDirs = allowedDirs;
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const resolved = this.resolver.resolve(String(args.path ?? ""), "write");
		if (!resolved || !isInsideAnyAllowed(this.allowedDirs, resolved)) {
			return JSON.stringify({ error: `path outside allowed Drift workspace: ${String(args.path ?? "")}` });
		}
		const oldText = String(args.old_text ?? "");
		const newText = String(args.new_text ?? "");
		if (!oldText) return JSON.stringify({ error: "old_text is required" });
		try {
			const content = readFileSync(resolved, "utf-8");
			const index = content.indexOf(oldText);
			if (index === -1) return JSON.stringify({ error: "old_text not found" });
			writeFileSync(resolved, content.slice(0, index) + newText + content.slice(index + oldText.length), "utf-8");
			return JSON.stringify({ ok: true });
		} catch (error) {
			return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
		}
	}
}

function isInsideAllowed(allowedDir: string, target: string): boolean {
	const allowed = canonicalPath(allowedDir);
	const resolved = canonicalPath(target);
	const remainder = relative(allowed, resolved);
	return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

function isInsideAnyAllowed(allowedDirs: readonly string[], target: string): boolean {
	return allowedDirs.some((allowedDir) => isInsideAllowed(allowedDir, target));
}

function firstAllowedDir(allowedDirs: readonly string[], target: string): string {
	return allowedDirs.find((allowedDir) => isInsideAllowed(allowedDir, target)) ?? allowedDirs[0] ?? target;
}

function uniquePaths(paths: readonly string[]): string[] {
	return [
		...new Set(
			paths
				.map((path) => path.trim())
				.filter((path) => path.length > 0)
				.map((path) => resolve(path)),
		),
	];
}

function canonicalPath(path: string): string {
	const normalized = resolve(path);
	let current = normalized;
	const missing: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return normalized;
		missing.push(basename(current));
		current = parent;
	}
	let canonicalBase: string;
	try {
		canonicalBase = realpathSync(current);
	} catch {
		canonicalBase = current;
	}
	return resolve(canonicalBase, ...missing.reverse());
}

// ------------------------------------------------------------------
// web_fetch / web_search
// ------------------------------------------------------------------

const DEFAULT_WEB_MAX_CHARS = DEFAULT_WEB_MAX_CHARS_GATE;
const DEFAULT_WEB_MAX_RESULTS = DEFAULT_WEB_MAX_RESULTS_GATE;
const DEFAULT_WEB_TIMEOUT_MS = DEFAULT_WEB_TIMEOUT_MS_GATE;

class WebFetchTool implements DriftTool {
	name = "web_fetch";
	description = "抓取一个 HTTP(S) 网页并返回去掉 HTML 标签的正文片段。";
	parameters = {
		type: "object",
		properties: {
			url: { type: "string", description: "要抓取的 HTTP(S) URL" },
			max_chars: { type: "number", description: "最多返回的字符数，默认 8000" },
		},
		required: ["url"],
	};

	private readonly deps: DriftToolDeps;

	constructor(deps: DriftToolDeps) {
		this.deps = deps;
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const url = String(args.url ?? "").trim();
		if (!isHttpUrl(url)) return JSON.stringify({ error: "url must be an http(s) URL" });
		const urlError = validateWebUrl(url, this.deps.webPolicy);
		if (urlError) return JSON.stringify({ error: urlError, url });
		const maxChars = boundedNumber(args.max_chars, this.deps.webMaxChars ?? DEFAULT_WEB_MAX_CHARS, 200, 50_000);
		const timeoutMs = this.deps.webRequestTimeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;
		try {
			if (this.deps.webFetchFn && this.deps.webDnsLookupFn) {
				const resolvedError = await validateResolvedWebUrl(url, this.deps.webPolicy, this.deps.webDnsLookupFn);
				if (resolvedError) return JSON.stringify({ error: resolvedError, url });
			}
			const result = this.deps.webFetchFn
				? await this.deps.webFetchFn(url, maxChars, timeoutMs)
				: await fetchWebPage(url, maxChars, timeoutMs, this.deps.webPolicy, this.deps.webDnsLookupFn);
			return JSON.stringify({ url, ...result, text: result.text?.slice(0, maxChars) });
		} catch (error) {
			return JSON.stringify({ error: error instanceof Error ? error.message : String(error), url });
		}
	}
}

class WebSearchTool implements DriftTool {
	name = "web_search";
	description = "搜索网页。需要宿主提供 webSearchFn 或配置 drift.webSearchUrl。";
	parameters = {
		type: "object",
		properties: {
			query: { type: "string", description: "搜索关键词或问题" },
			limit: { type: "number", description: "最多返回结果数，默认 5" },
		},
		required: ["query"],
	};

	private readonly deps: DriftToolDeps;

	constructor(deps: DriftToolDeps) {
		this.deps = deps;
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const query = String(args.query ?? "").trim();
		if (!query) return JSON.stringify({ error: "query is required" });
		const maxResults = boundedNumber(args.limit, this.deps.webMaxResults ?? DEFAULT_WEB_MAX_RESULTS, 1, 20);
		const timeoutMs = this.deps.webRequestTimeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;
		try {
			if (this.deps.webSearchFn && this.deps.webDnsLookupFn && this.deps.webSearchUrl) {
				const resolvedError = await validateResolvedWebUrl(
					this.deps.webSearchUrl,
					this.deps.webPolicy,
					this.deps.webDnsLookupFn,
				);
				if (resolvedError) return JSON.stringify({ error: resolvedError, query });
			}
			const results = this.deps.webSearchFn
				? await this.deps.webSearchFn(query, maxResults, timeoutMs)
				: await searchWebPage(
						this.deps.webSearchUrl,
						this.deps.webSearchApiKey,
						query,
						maxResults,
						timeoutMs,
						this.deps.webPolicy,
						this.deps.webDnsLookupFn,
					);
			return JSON.stringify({ query, results: results.slice(0, maxResults) });
		} catch (error) {
			return JSON.stringify({ error: error instanceof Error ? error.message : String(error), query });
		}
	}
}

/** web 抓取/搜索实现已上移到 @cogito/gate/web.ts(validateWebUrl/fetchWebPage/searchWebPage 等)。 */

/** 一个前台/后台 shell 任务的状态。 */
interface ShellTask {
	id: string;
	child: ChildProcess;
	stdout: string;
	stderr: string;
	exited: boolean;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	error: string | null;
	timer?: ReturnType<typeof setTimeout>;
}

export class ShellTool implements DriftTool {
	name = "shell";
	description =
		"在 drift 工作区执行 shell 命令。默认工作目录是 drift 工作区；设置 background=true 可返回 task_id，" +
		"再用 write_stdin/task_stop 与后台任务交互。";
	parameters = {
		type: "object",
		properties: {
			command: { type: "string", description: "要执行的命令" },
			cwd: { type: "string", description: "可选工作目录（相对 drift 工作区）" },
			timeout: { type: "number", description: "超时毫秒，默认 60000" },
			background: { type: "boolean", description: "后台运行并返回 task_id，默认 false" },
		},
		required: ["command"],
	};

	private readonly driftDir: string;
	private readonly allowedDirs: readonly string[];
	/** 本 run 的前台与后台子进程(run 结束时由 pipeline terminate)。 */
	private readonly tasks = new Map<string, ShellTask>();
	private nextTaskId = 1;

	constructor(driftDir: string, allowedDirs: readonly string[] = [driftDir]) {
		this.driftDir = resolve(driftDir);
		this.allowedDirs = uniquePaths(allowedDirs);
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const command = String(args.command ?? "").trim();
		if (!command) return JSON.stringify({ error: "command is required" });
		const rawCwd = String(args.cwd ?? "").trim();
		const candidateCwd = rawCwd ? (isAbsolute(rawCwd) ? rawCwd : join(this.driftDir, rawCwd)) : this.driftDir;
		const cwd = resolve(candidateCwd);
		if (!isInsideAnyAllowed(this.allowedDirs, cwd)) {
			return JSON.stringify({ error: `cwd outside allowed Drift workspace: ${rawCwd || this.driftDir}` });
		}
		try {
			if (!statSync(cwd).isDirectory()) return JSON.stringify({ error: `cwd is not a directory: ${rawCwd}` });
		} catch (error) {
			return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
		}
		const background = args.background === true;
		const timeoutValue = Number(args.timeout);
		const timeout =
			Number.isFinite(timeoutValue) && timeoutValue > 0 ? Math.max(1000, timeoutValue) : background ? 0 : 60_000;
		const task = this.spawnTask(command, cwd, background, timeout);
		if (background) return JSON.stringify({ ok: true, task_id: task.id, running: !task.exited });
		await this.waitForTask(task);
		this.tasks.delete(task.id);
		return this.formatTaskResult(task);
	}

	async writeStdin(taskId: string, chars: string, yieldTimeMs: number): Promise<string> {
		const task = this.tasks.get(taskId);
		if (!task) return JSON.stringify({ error: `task not found: ${taskId}` });
		if (chars && task.child.stdin && !task.exited) task.child.stdin.write(chars);
		if (!task.exited) await this.waitForTask(task, Math.min(Math.max(yieldTimeMs, 0), 30_000));
		return this.formatTaskResult(task);
	}

	async stopTask(taskId: string): Promise<string> {
		const task = this.tasks.get(taskId);
		if (!task) return JSON.stringify({ error: `task not found: ${taskId}` });
		if (!task.exited) {
			try {
				this.killTask(task, "SIGTERM");
			} catch {
				// 已退出
			}
			await this.waitForTask(task, 1_000);
			if (!task.exited) {
				try {
					this.killTask(task, "SIGKILL");
				} catch {
					// 已退出
				}
				await this.waitForTask(task, 1_000);
			}
		}
		this.tasks.delete(task.id);
		return this.formatTaskResult(task);
	}

	/** 终止本 run 仍在运行的子进程(akashic DriftShellTool.terminate_owner)。 */
	async terminate(): Promise<void> {
		const tasks = [...this.tasks.values()];
		for (const task of tasks) {
			try {
				if (!task.exited) {
					task.error ??= "command terminated";
					this.killTask(task, "SIGKILL");
				}
			} catch {
				// 已退出
			}
		}
		await Promise.all(tasks.map((task) => this.waitForTask(task, 1_000)));
		this.tasks.clear();
	}

	private spawnTask(command: string, cwd: string, background: boolean, timeout: number): ShellTask {
		const child = spawn("/bin/sh", ["-c", command], {
			cwd,
			stdio: [background ? "pipe" : "ignore", "pipe", "pipe"],
			detached: true,
		});
		const task: ShellTask = {
			id: `shell-${this.nextTaskId++}`,
			child,
			stdout: "",
			stderr: "",
			exited: false,
			exitCode: null,
			signal: null,
			timedOut: false,
			error: null,
		};
		const append = (field: "stdout" | "stderr", chunk: unknown): void => {
			task[field] = `${task[field]}${String(chunk)}`.slice(-512_000);
		};
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: unknown) => append("stdout", chunk));
		child.stderr?.on("data", (chunk: unknown) => append("stderr", chunk));
		child.once("error", (error) => {
			task.error = error instanceof Error ? error.message : String(error);
		});
		child.once("exit", (code, signal) => {
			task.exited = true;
			task.exitCode = code;
			task.signal = signal;
			if (task.timer) clearTimeout(task.timer);
		});
		if (timeout > 0) {
			task.timer = setTimeout(() => {
				if (task.exited) return;
				task.timedOut = true;
				try {
					this.killTask(task, "SIGKILL");
				} catch {
					// 已退出
				}
			}, timeout);
		}
		this.tasks.set(task.id, task);
		return task;
	}

	private async waitForTask(task: ShellTask, timeoutMs?: number): Promise<boolean> {
		if (task.exited) return true;
		return new Promise((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				resolve(task.exited);
			};
			task.child.once("exit", finish);
			if (timeoutMs !== undefined) timer = setTimeout(finish, timeoutMs);
			if (task.exited) finish();
		});
	}

	private killTask(task: ShellTask, signal: "SIGTERM" | "SIGKILL"): void {
		if (task.child.pid && process.platform !== "win32") {
			try {
				process.kill(-task.child.pid, signal);
				return;
			} catch {
				// Fall back to the direct child when the process group has exited.
			}
		}
		task.child.kill(signal);
	}

	private formatTaskResult(task: ShellTask): string {
		return JSON.stringify({
			task_id: task.id,
			running: !task.exited,
			stdout: task.stdout,
			stderr: task.stderr,
			exit_code: task.exitCode,
			signal: task.signal,
			...(task.timedOut ? { error: "command timed out" } : task.error ? { error: task.error } : {}),
		});
	}
}

class WriteStdinTool implements DriftTool {
	name = "write_stdin";
	description = "向后台 shell task 写入 stdin，并等待一小段时间返回最新输出。";
	parameters = {
		type: "object",
		properties: {
			task_id: { type: "string", description: "shell(background=true) 返回的 task_id" },
			chars: { type: "string", description: "写入 stdin 的字符，可为空" },
			yield_time_ms: { type: "number", description: "等待输出的毫秒数，最多 30000" },
		},
		required: ["task_id"],
	};

	private readonly shell: ShellTool;

	constructor(shell: ShellTool) {
		this.shell = shell;
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const taskId = String(args.task_id ?? "").trim();
		if (!taskId) return JSON.stringify({ error: "task_id is required" });
		const chars = String(args.chars ?? "");
		const yieldValue = Number(args.yield_time_ms ?? 250);
		const yieldTimeMs = Number.isFinite(yieldValue) ? Math.max(0, Math.trunc(yieldValue)) : 250;
		return this.shell.writeStdin(taskId, chars, yieldTimeMs);
	}
}

class TaskStopTool implements DriftTool {
	name = "task_stop";
	description = "终止一个后台 shell task，并返回其最终输出。";
	parameters = {
		type: "object",
		properties: { task_id: { type: "string", description: "要终止的后台 task_id" } },
		required: ["task_id"],
	};

	private readonly shell: ShellTool;

	constructor(shell: ShellTool) {
		this.shell = shell;
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const taskId = String(args.task_id ?? "").trim();
		if (!taskId) return JSON.stringify({ error: "task_id is required" });
		return this.shell.stopTask(taskId);
	}
}

// ------------------------------------------------------------------
// mount_server (akashic MountServerTool)
// ------------------------------------------------------------------

class MountServerTool implements DriftTool {
	name = "mount_server";
	description = "挂载一个已连接的 MCP server，使其工具在本次 drift 中可用。挂载后即可直接调用该 server 的工具。";
	parameters = {
		type: "object",
		properties: {
			server: { type: "string", description: "要挂载的 MCP server 名称" },
		},
		required: ["server"],
	};

	private readonly mcp: DriftMcpConnections;
	/** 注册表(挂载时注册，后续 schema 过滤/执行都从同一 live view 取)。 */
	private readonly registry: DriftToolRegistry;

	constructor(mcp: DriftMcpConnections, registry: DriftToolRegistry) {
		this.mcp = mcp;
		this.registry = registry;
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const server = String(args.server ?? "").trim();
		if (!server) return JSON.stringify({ error: "server is required" });
		const entry = this.mcp.servers.find((s) => s.name === server);
		if (!entry) {
			return JSON.stringify({ error: `MCP server '${server}' 不存在或未连接` });
		}
		const newTools: string[] = [];
		for (const tool of entry.tools) {
			if (this.registry.register(toDriftTool(server, tool))) newTools.push(tool.name);
		}
		return JSON.stringify({
			ok: true,
			tools: entry.tools.map((t) => t.name),
			new: newTools,
		});
	}
}

function toDriftTool(server: string, tool: DriftMcpTool): DriftTool {
	return {
		name: tool.name,
		description: `${tool.description}\n(来自 MCP server: ${server})`,
		parameters: tool.parameters,
		meta: { source: `mcp:${server}`, risk: "external-side-effect", requiresApproval: true },
		execute: (args) => tool.call(args),
	};
}

// ------------------------------------------------------------------
// Messages + memory (pi-native implementations)
// ------------------------------------------------------------------

function readSessionMessages(
	sessionsDir: string,
	limit: number,
	keyword?: string,
): Array<{ role: string; content: string; timestamp: string }> {
	if (!sessionsDir || !existsSync(sessionsDir)) return [];
	const messages: Array<{ role: string; content: string; timestamp: string }> = [];
	try {
		for (const name of readdirSync(sessionsDir)) {
			const full = join(sessionsDir, name);
			if (name.endsWith(".jsonl")) {
				collectFromFile(full, messages, keyword);
			} else if (statSync(full).isDirectory()) {
				for (const inner of readdirSync(full)) {
					if (inner.endsWith(".jsonl")) collectFromFile(join(full, inner), messages, keyword);
				}
			}
		}
	} catch {
		return [];
	}
	messages.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
	return messages.slice(-limit);
}

function collectFromFile(
	file: string,
	out: Array<{ role: string; content: string; timestamp: string }>,
	keyword?: string,
): void {
	let lines: string[];
	try {
		lines = readFileSync(file, "utf-8").split("\n");
	} catch {
		return;
	}
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: { type?: string; message?: { role?: string; content?: unknown; timestamp?: string } };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const content = extractText(entry.message.content);
		if (!content) continue;
		if (keyword && !content.includes(keyword)) continue;
		out.push({ role, content, timestamp: String(entry.message.timestamp ?? "") });
	}
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

class FetchMessagesTool implements DriftTool {
	name = "fetch_messages";
	description = "读取最近会话消息（用户与助手），用于回溯上下文。优先使用宿主会话存储。";
	parameters = {
		type: "object",
		properties: {
			source_ref: { type: "string", description: "可选来源引用，由宿主会话存储解释" },
			context: { type: "number", description: "返回最近 N 条消息" },
		},
		required: [],
	};

	private readonly sessionsDir?: string;
	private readonly sessionAccess?: DriftSessionAccess;

	constructor(sessionsDir?: string, sessionAccess?: DriftSessionAccess) {
		this.sessionsDir = sessionsDir;
		this.sessionAccess = sessionAccess;
	}

	async execute(args: Record<string, unknown>, ctx: DriftRunContext): Promise<string> {
		const limit = Math.max(1, Math.min(200, Number(args.context ?? 10) || 10));
		const hostMessages = await this.sessionAccess?.fetchMessages?.({
			sessionKey: ctx.sessionKey,
			sourceRef: String(args.source_ref ?? "").trim() || undefined,
			limit,
			now: ctx.nowUtc,
		});
		const messages = (hostMessages ?? readSessionMessages(this.sessionsDir ?? "", limit)).filter(
			(message) => message.role === "user" || message.role === "assistant",
		);
		if (messages.length === 0) return JSON.stringify({ messages: [] });
		return JSON.stringify({
			messages: messages.map((m) => ({ role: m.role, content: m.content.slice(0, 500), timestamp: m.timestamp })),
		});
	}
}

class SearchMessagesTool implements DriftTool {
	name = "search_messages";
	description = "按关键词搜索历史会话消息。";
	parameters = {
		type: "object",
		properties: { query: { type: "string" }, limit: { type: "number" } },
		required: ["query"],
	};

	private readonly sessionsDir?: string;
	private readonly sessionAccess?: DriftSessionAccess;

	constructor(sessionsDir?: string, sessionAccess?: DriftSessionAccess) {
		this.sessionsDir = sessionsDir;
		this.sessionAccess = sessionAccess;
	}

	async execute(args: Record<string, unknown>, ctx: DriftRunContext): Promise<string> {
		const query = String(args.query ?? "").trim();
		if (!query) return JSON.stringify({ error: "query is required" });
		const limit = Math.max(1, Math.min(100, Number(args.limit ?? 10) || 10));
		const hostMessages = await this.sessionAccess?.searchMessages?.({
			sessionKey: ctx.sessionKey,
			query,
			limit,
			now: ctx.nowUtc,
		});
		const messages = (hostMessages ?? readSessionMessages(this.sessionsDir ?? "", limit, query)).filter(
			(message) => message.role === "user" || message.role === "assistant",
		);
		if (messages.length === 0) return JSON.stringify({ messages: [] });
		return JSON.stringify({
			messages: messages.map((m) => ({ role: m.role, content: m.content.slice(0, 500), timestamp: m.timestamp })),
		});
	}
}

class RecallMemoryTool implements DriftTool {
	name = "recall_memory";
	description = "检索长期记忆中的用户偏好与规则(读记忆引擎数据库,只读)。";
	parameters = {
		type: "object",
		properties: { query: { type: "string", description: "检索主题" }, limit: { type: "number" } },
		required: ["query"],
	};

	private readonly memoryDbPath?: string;
	private readonly embeddingFn?: RecallEmbeddingFn;
	private readonly recallFn?: DriftToolDeps["memoryRecallFn"];

	constructor(memoryDbPath?: string, embeddingFn?: RecallEmbeddingFn, recallFn?: DriftToolDeps["memoryRecallFn"]) {
		this.memoryDbPath = memoryDbPath;
		this.embeddingFn = embeddingFn;
		this.recallFn = recallFn;
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const query = String(args.query ?? "").trim();
		const limit = Math.max(1, Math.min(20, Number(args.limit ?? 8) || 8));
		if (!this.memoryDbPath && !this.recallFn) return JSON.stringify({ messages: [] });
		const items = this.recallFn
			? await this.recallFn(query, limit)
			: this.embeddingFn && query
				? await recallPreferencesRanked(this.memoryDbPath!, query, limit, this.embeddingFn)
				: recallPreferences(this.memoryDbPath!, query, limit);
		return JSON.stringify({ count: items.length, items });
	}
}

// ------------------------------------------------------------------
// read_journal (9b:skill 运行中只读查询自己的 journal/cursor)
// ------------------------------------------------------------------

class ReadJournalTool implements DriftTool {
	name = "read_journal";
	description = "读取当前 skill 的 journal(append-only 事实)与 cursor(结构化游标),只读。";
	parameters = {
		type: "object",
		properties: {
			skill_name: { type: "string", description: "skill 名称,默认当前选中的 skill" },
			entry_type: { type: "string", description: "可选过滤 entry_type" },
			key: { type: "string", description: "可选过滤 key" },
			limit: { type: "number", description: "返回条数,默认 20" },
		},
		required: [],
	};

	private readonly store: DriftStateStore;
	private readonly ctx: DriftRunContext;

	constructor(store: DriftStateStore, ctx: DriftRunContext) {
		this.store = store;
		this.ctx = ctx;
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const skillName = String(args.skill_name ?? "").trim() || this.ctx.driftSelectedSkill.trim();
		if (!skillName) {
			return JSON.stringify({ error: "skill_name is required (或先 select_skill)" });
		}
		if (!this.store.validSkillNames().has(skillName)) {
			return JSON.stringify({ error: `unknown skill: ${skillName}` });
		}
		const limit = Math.max(1, Math.min(50, Number(args.limit ?? 20) || 20));
		const entries = this.store.loadSkillJournal(skillName, {
			entryType: String(args.entry_type ?? "").trim(),
			key: String(args.key ?? "").trim(),
			limit,
		});
		const continuum = this.store.loadSkillContinuum(skillName);
		return JSON.stringify({
			ok: true,
			skill: skillName,
			cursor: continuum.cursor ?? {},
			entries,
		});
	}
}

// ------------------------------------------------------------------
// Registry builder (akashic build_drift_tool_registry)
// ------------------------------------------------------------------

export function buildDriftToolRegistry(ctx: DriftRunContext, deps: DriftToolDeps): DriftTool[] {
	const workspaceDir = deps.workspaceDir || deps.driftDir;
	const resolver = new DriftPathResolver(deps.driftDir, workspaceDir, deps.store, deps.pathPolicy);
	const writeAllowedDirs = [deps.driftDir, workspaceDir, ...(deps.pathPolicy?.allowedWriteDirs ?? [])];
	const shellAllowedDirs = [deps.driftDir, workspaceDir, ...(deps.pathPolicy?.allowedShellDirs ?? [])];
	const shell = new ShellTool(deps.driftDir, shellAllowedDirs);
	const registry = new DriftToolRegistry([
		new SelectSkillTool(deps.store, ctx),
		new IdleDriftTool(deps.store, ctx),
		new ReadFileTool(resolver),
		new ListDirTool(resolver),
		new WriteFileTool(resolver, writeAllowedDirs),
		new EditFileTool(resolver, writeAllowedDirs),
		new WebFetchTool(deps),
		new WebSearchTool(deps),
		shell,
		new WriteStdinTool(shell),
		new TaskStopTool(shell),
		new FetchMessagesTool(deps.sessionsDir, deps.sessionAccess),
		new SearchMessagesTool(deps.sessionsDir, deps.sessionAccess),
		new RecallMemoryTool(deps.memoryDbPath, deps.memoryEmbeddingFn, deps.memoryRecallFn),
		new ReadJournalTool(deps.store, ctx),
		new SendMessageTool(deps, ctx),
		new FinishDriftTool(deps.store, ctx),
	]);
	const tools = registry.list();
	// mount_server:只有已连接 MCP server 时才注册(akashic 同条件)。
	if (deps.mcp && deps.mcp.servers.length > 0) {
		registry.register(new MountServerTool(deps.mcp, registry));
	}
	for (const sharedTool of deps.sharedTools ?? []) {
		registry.register(sharedTool, { source: `shared:${sharedTool.name}` });
	}
	return tools;
}
