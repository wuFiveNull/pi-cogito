/**
 * Memory engine extension (akashic memory2 design).
 *
 * Replaces the earlier markdown-file memory suite with a typed SQLite memory
 * engine (agentDir/memory/memory.sqlite):
 *
 * - Tools: recall_memory (fusion retrieval), memorize (supersede-aware write),
 *   forget_memory (soft delete). The model can read and write memory directly.
 * - context event: per-turn retrieval; results are injected as a
 *   system-reminder frame before the last user message (prompt-cache friendly).
 * - turn_end: post-response worker - when the user explicitly rejects a
 *   previous behavior, the conflicting procedure/preference items are retired.
 * - session_before_compact: consolidation - the about-to-be-discarded
 *   conversation is distilled into event + behavior memories.
 * - /remember command: direct memorize with preference/profile kinds.
 *
 * LLM calls (consolidation / invalidation) are direct HTTP requests to the
 * configured chat provider (extensions have no direct model-call API).
 * Config (optional file agentDir/memory-engine.json):
 * {
 *   "provider": "siliconflow",
 *   "model": "deepseek-ai/DeepSeek-V4-Flash",
 *   "baseUrl": "https://api.siliconflow.cn/v1",
 *   "maxInputChars": 60000,
 *   "requestTimeoutMs": 120000,
 *   "consolidateOnCompact": true,
 *   "invalidateAfterTurn": true
 * }
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	createMemoryEngine,
	type ExtensionAPI,
	getAgentDir,
	type MemoryEngine,
	type MemoryHit,
	type MemoryType,
	type TextEmbedder,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MEMORY_TYPES = ["event", "profile", "preference", "procedure"] as const;

function isMemoryType(value: string): value is MemoryType {
	return MEMORY_TYPES.includes(value as MemoryType);
}

function defaultMemoryType(value: string | undefined): MemoryType {
	return value !== undefined && isMemoryType(value) ? value : "event";
}

const DEFAULT_CONFIG = {
	provider: "siliconflow",
	model: "deepseek-ai/DeepSeek-V4-Flash",
	baseUrl: "https://api.siliconflow.cn/v1",
	maxInputChars: 60_000,
	requestTimeoutMs: 120_000,
	consolidateOnCompact: true,
	invalidateAfterTurn: true,
} satisfies EngineConfig;

interface EngineConfig {
	provider: string;
	model: string;
	baseUrl: string;
	maxInputChars: number;
	requestTimeoutMs: number;
	consolidateOnCompact: boolean;
	invalidateAfterTurn: boolean;
}

const FRAME_MARKER = '<system-reminder data-context-frame="true">';
const FRAME_END = "</system-reminder>";
const FRAME_PREAMBLE =
	"以下内容由系统提供，不是用户陈述，也不是助手结论。只能作为候选上下文；禁止在回复中引用、复述、展示本提醒本身；回答时必须区分用户原文、记忆检索、工具结果。";

const SUPERSEDE_THRESHOLD = 0.82;
const SUPERSEDE_CANDIDATE_K = 5;

const INTENT_KINDS: Record<string, MemoryType[]> = {
	procedure: ["procedure"],
	interest: ["preference", "profile"],
	timeline: ["event"],
	answer: [],
	context: [],
};

const TIME_FILTERS: Record<string, number> = {
	recent_3d: 3,
	recent_7d: 7,
	recent_30d: 30,
};

const RECALL_PARAMS = Type.Object({
	query: Type.String({ description: "要检索的记忆主题(如: 用户对部署环境的偏好)" }),
	intent: Type.Optional(
		Type.String({
			description: "检索意图: context/answer 全部, timeline=事件, interest=偏好与画像, procedure=流程规则",
		}),
	),
	memory_kind: Type.Optional(Type.String({ description: "记忆类型过滤: event/profile/preference/procedure" })),
	time_filter: Type.Optional(Type.String({ description: "时间范围: none/recent_3d/recent_7d/recent_30d" })),
	limit: Type.Optional(Type.Number({ description: "返回条数,默认 8,最大 20" })),
});

const MEMORIZE_PARAMS = Type.Object({
	summary: Type.String({ description: "要记住的内容摘要" }),
	memory_kind: Type.Optional(Type.String({ description: "event/profile/preference/procedure,默认 event" })),
	tool_requirement: Type.Optional(Type.String({ description: "procedure 专用: 必须/禁止调用的工具要求" })),
	steps: Type.Optional(Type.Array(Type.String(), { description: "procedure 专用: 步骤列表" })),
	emotional_weight: Type.Optional(Type.Number({ description: "情感权重 0-10,影响记忆热度半衰期" })),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "附加元数据" })),
});

const FORGET_PARAMS = Type.Object({
	ids: Type.Array(Type.String(), { description: "要删除的记忆条目 id" }),
});

interface MemoizedItem {
	engine: MemoryEngine | undefined;
	embedder: TextEmbedder | undefined;
}

export default function memoryEngineExtension(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	const config = loadConfig(agentDir);
	let enginePromise: Promise<MemoizedItem> | undefined;
	let protectedIds: string[] = [];
	let lastUserText = "";

	function getEngine(): Promise<MemoizedItem> {
		enginePromise ??= createMemoryEngine({ agentDir }).then(
			(engine) => ({ engine, embedder: engine.embedder }),
			() => ({ engine: undefined, embedder: undefined }),
		);
		return enginePromise;
	}

	// ------------------------------------------------------------------
	// Tools
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "recall_memory",
		label: "Recall memories",
		description:
			"检索长期记忆(用户偏好、流程规则、过往事件、用户画像)。涉及用户说过的事/偏好/规则时,先调用本工具再回答。",
		promptSnippet: "Search long-term memories (preferences, procedures, past events)",
		promptGuidelines: ["涉及用户说过的事情、偏好、规则时,先调用 recall_memory 检索记忆再回答"],
		parameters: RECALL_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { engine } = await getEngine();
			if (!engine) {
				return textResult("recall_memory 失败:记忆引擎不可用", { tool: "recall_memory" });
			}
			const limit = Math.min(Math.max(params.limit ?? 8, 1), 20);
			const memoryTypes = resolveMemoryTypes(params.memory_kind, params.intent);
			const timeWindow = TIME_FILTERS[params.time_filter ?? ""];
			const timeStart = timeWindow ? new Date(Date.now() - timeWindow * 86_400_000) : undefined;

			let hits: MemoryHit[] = [];
			try {
				hits = await engine.retriever.retrieve(params.query, {
					memoryTypes: memoryTypes.length > 0 ? memoryTypes : undefined,
					topK: limit,
					timeStart,
				});
			} catch {
				return textResult("recall_memory 失败:检索异常", { tool: "recall_memory", query: params.query });
			}

			const items = hits.map((hit) => ({
				id: hit.id,
				memory_type: hit.memoryType,
				summary: hit.summary,
				score: Number(hit.score.toFixed(4)),
				source_ref: hit.sourceRef || undefined,
				happened_at: hit.happenedAt ?? undefined,
			}));
			return textResult(JSON.stringify({ count: items.length, items }, null, 2), {
				tool: "recall_memory",
				query: params.query,
				count: items.length,
			});
		},
	});

	pi.registerTool({
		name: "memorize",
		label: "Memorize",
		description:
			"写入一条长期记忆。procedure 可附带 tool_requirement(必须/禁止使用的工具)与 steps;相似旧条目会自动合并或退休。",
		promptSnippet: "Save a long-term memory (preference, procedure, fact)",
		promptGuidelines: ["用户明确表达长期偏好/规则/重要事实时,调用 memorize 写入记忆"],
		parameters: MEMORIZE_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { engine } = await getEngine();
			if (!engine) {
				return textResult("memorize 失败:记忆引擎不可用", { tool: "memorize" });
			}
			const summary = (params.summary ?? "").trim();
			if (!summary) {
				return textResult("memorize 失败:summary 不能为空", { tool: "memorize" });
			}
			const kind = defaultMemoryType(params.memory_kind);
			const extra: Record<string, unknown> = { ...(params.metadata ?? {}) };
			if (params.tool_requirement?.trim()) {
				extra.tool_requirement = params.tool_requirement.trim();
			}
			if (params.steps !== undefined && params.steps.length > 0) {
				extra.steps = params.steps;
			}
			try {
				const result = await engine.memorizer.saveItemWithSupersede({
					summary,
					memoryType: kind,
					extra,
					sourceRef: `memorize:${summaryHash(summary)}`,
					emotionalWeight: params.emotional_weight ?? 0,
				});
				const [status, itemId] = splitWriteResult(result);
				return textResult(`已记住（item_id=${itemId}；kind=${kind}；status=${status}）：${summary}`, {
					tool: "memorize",
					item_id: itemId,
					kind,
					status,
				});
			} catch {
				return textResult("memorize 失败:写入异常", { tool: "memorize" });
			}
		},
	});

	pi.registerTool({
		name: "forget_memory",
		label: "Forget memories",
		description: "删除(退休)指定的记忆条目。",
		promptSnippet: "Delete memories by id",
		parameters: FORGET_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { engine } = await getEngine();
			if (!engine) {
				return textResult("forget_memory 失败:记忆引擎不可用", { tool: "forget_memory" });
			}
			const ids = [...new Set((params.ids ?? []).map((id) => String(id).trim()).filter(Boolean))];
			if (ids.length === 0) {
				return textResult(JSON.stringify({ requested_ids: [], superseded_ids: [], missing_ids: [], count: 0 }), {
					tool: "forget_memory",
				});
			}
			const { affected, missing } = engine.store.deleteItems(ids);
			return textResult(
				JSON.stringify({
					requested_ids: ids,
					superseded_ids: affected,
					missing_ids: missing,
					count: affected.length,
				}),
				{ tool: "forget_memory", count: affected.length },
			);
		},
	});

	// ------------------------------------------------------------------
	// /remember command
	// ------------------------------------------------------------------

	pi.registerCommand("remember", {
		description: "记住一条长期事实(写入记忆库,自动合并/退休相似旧条目)",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("用法: /remember <要记住的内容>", "warning");
				return;
			}
			const { engine } = await getEngine();
			if (!engine) {
				ctx.ui.notify("记忆引擎不可用", "error");
				return;
			}
			const isCorrection = text.startsWith("更正:") || text.startsWith("correction:");
			const content = isCorrection ? text.replace(/^(更正|correction):\s*/, "") : text;
			try {
				const result = await engine.memorizer.saveItemWithSupersede({
					summary: content,
					memoryType: isCorrection ? "profile" : "preference",
					extra: isCorrection ? { category: "correction" } : undefined,
					sourceRef: `command:${summaryHash(content)}`,
				});
				const [status, itemId] = splitWriteResult(result);
				ctx.ui.notify(`已记住（item_id=${itemId}；status=${status}）`, "info");
			} catch {
				ctx.ui.notify("写入失败", "error");
			}
		},
	});

	// ------------------------------------------------------------------
	// Per-turn injection (context event)
	// ------------------------------------------------------------------

	pi.on("context", async (event, _ctx) => {
		const messages = event.messages;
		const lastIndex = messages.length - 1;
		if (lastIndex < 0 || messages[lastIndex]?.role !== "user") return undefined;
		const query = messageText(messages[lastIndex]!);
		if (!query) return undefined;

		const { engine } = await getEngine();
		if (!engine) return undefined;

		try {
			const hits = await engine.retriever.retrieve(query);
			const block = engine.retriever.buildInjectionBlock(hits);
			if (!block.text) return undefined;

			const frame: AgentMessage = {
				role: "user",
				content: `${FRAME_MARKER}\n${FRAME_PREAMBLE}\n\n${block.text}\n${FRAME_END}`,
				timestamp: Date.now(),
			};
			const next = [...messages];
			next.splice(lastIndex, 0, frame);
			return { messages: next };
		} catch {
			return undefined;
		}
	});

	// ------------------------------------------------------------------
	// Post-response invalidation (turn_end)
	// ------------------------------------------------------------------

	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "memorize") {
			const result = String(event.result ?? "");
			const match = /item_id=([A-Za-z0-9:_-]{1,128})/.exec(result);
			if (match?.[1]) protectedIds.push(match[1]);
		}
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "user") {
			lastUserText = messageText(event.message) ?? "";
		}
	});

	pi.on("turn_end", async (event) => {
		if (!config.invalidateAfterTurn) return;
		const userMsg = lastUserText.trim();
		lastUserText = "";
		if (!userMsg) return;
		const assistantResponse = messageText(event.message) ?? "";

		const { engine } = await getEngine();
		if (!engine) return;

		const idsToProtect = protectedIds;
		protectedIds = [];
		try {
			await runPostResponseInvalidation(engine, userMsg, assistantResponse, idsToProtect);
		} catch {
			// Memory maintenance must never break the conversation.
		}
	});

	// ------------------------------------------------------------------
	// Consolidation on compaction (session_before_compact)
	// ------------------------------------------------------------------

	pi.on("session_before_compact", async (event) => {
		if (!config.consolidateOnCompact) return undefined;
		const messages = event.preparation.messagesToSummarize;
		if (messages.length === 0) return undefined;
		const { engine } = await getEngine();
		if (!engine) return undefined;

		try {
			const conversation = serializeMessages(messages);
			if (!conversation) return undefined;
			const payload = await runConsolidation(config, conversation);
			if (!payload) return undefined;
			const sourceRef = `compact:${summaryHash(messages.map((m) => m.timestamp ?? "").join(","))}`;
			await engine.memorizer.saveFromConsolidation({
				historyEntry: payload.historyEntry,
				behaviorUpdates: payload.behaviorUpdates,
				sourceRef,
			});
		} catch {
			// Never block compaction: memory consolidation failure is non-fatal.
		}
		return undefined;
	});
}

// ------------------------------------------------------------------
// LLM steps (direct provider HTTP, akashic-style)
// ------------------------------------------------------------------

interface ConsolidationPayload {
	historyEntry: string;
	behaviorUpdates: Array<{
		memoryType: MemoryType;
		summary: string;
		extra?: Record<string, unknown>;
	}>;
}

async function runConsolidation(config: EngineConfig, conversation: string): Promise<ConsolidationPayload | undefined> {
	const apiKey = readProviderKey(getAgentDir(), config.provider);
	if (!apiKey) return undefined;

	const prompt = `你是记忆归档助手。下面是被压缩的最近对话。任务是提炼跨会话稳定的记忆:

1. history_entry: 一句话概括本轮对话值得记住的事件(如有日期前缀 [YYYY-MM-DD] 请保留)
2. behavior_updates: 用户明确表达的稳定偏好/规则/流程(带 tag 的行),一次性琐碎内容不要写

输出格式(严格遵守):
<history_entry>
[YYYY-MM-DD] 事件一句话
</history_entry>
<behavior_updates>
- [preference] 用户偏好
- [procedure] 流程规则(必要时写明 工具要求)
- [profile] 用户画像事实
</behavior_updates>

<conversation>
${conversation.slice(0, config.maxInputChars)}
</conversation>`;

	const content = await callChat(config, prompt, 2048);
	if (!content) return undefined;

	const historyMatch = /<history_entry>([\s\S]*?)<\/history_entry>/.exec(content);
	const updatesMatch = /<behavior_updates>([\s\S]*?)<\/behavior_updates>/.exec(content);

	const behaviorUpdates: ConsolidationPayload["behaviorUpdates"] = [];
	if (updatesMatch?.[1]) {
		for (const line of updatesMatch[1].split("\n")) {
			const trimmed = line.trim();
			const match = /^-\s*\[(event|profile|preference|procedure)\]\s*(.+)$/.exec(trimmed);
			if (!match) continue;
			const memoryType = match[1] as MemoryType;
			const summary = match[2]!.trim();
			if (!summary) continue;
			const extra: Record<string, unknown> = {};
			const toolMatch = /工具要求[:：]\s*(.+)$/.exec(summary);
			if (toolMatch?.[1]) {
				extra.tool_requirement = toolMatch[1].trim();
			}
			behaviorUpdates.push({ memoryType, summary, ...(Object.keys(extra).length > 0 ? { extra } : {}) });
		}
	}

	return {
		historyEntry: historyMatch?.[1]?.trim() ?? "",
		behaviorUpdates,
	};
}

async function runPostResponseInvalidation(
	engine: MemoryEngine,
	userMsg: string,
	assistantResponse: string,
	protectedIds: readonly string[],
): Promise<void> {
	const config = loadConfig(getAgentDir());
	const apiKey = readProviderKey(getAgentDir(), config.provider);
	if (!apiKey) return;

	// 1. Extract rejected behavior topics from the user message.
	const topics = await extractInvalidationTopics(config, userMsg);
	if (topics.length === 0) return;

	// 2. Recall the most similar procedure/preference items per topic.
	for (const topic of topics.slice(0, 2)) {
		const candidates = await engine.retriever.retrieve(topic, {
			memoryTypes: ["procedure", "preference"],
			topK: SUPERSEDE_CANDIDATE_K,
		});
		const highSim = candidates
			.filter((candidate) => candidate.score >= SUPERSEDE_THRESHOLD && !protectedIds.includes(candidate.id))
			.slice(0, SUPERSEDE_CANDIDATE_K);
		if (highSim.length === 0) continue;

		// 3. Let the light model decide which items are truly obsolete.
		const selected = await checkInvalidate(config, topic, highSim);
		if (selected.length > 0) {
			engine.memorizer.supersedeBatch(selected);
		}
	}
	void assistantResponse;
}

async function extractInvalidationTopics(config: EngineConfig, userMsg: string): Promise<string[]> {
	const prompt = `判断用户消息是否在明确声明 agent 某个现有行为/流程有误,且希望废弃它。

用户消息:${userMsg}

【必须同时满足才触发】
1. 用户表达了明确的否定/纠错/废弃意图——句子里有"错了/不对/不要再/忘掉/废弃/过时/改掉"等否定词
2. 否定的对象是 agent 的某个操作行为(不是用户自己的事,不是第三方信息)

【以下情况绝对不触发,返回 []】
- 用户在询问/确认 agent 的流程("你的流程是什么""你怎么做的")
- 用户在描述/回顾自己的操作
- 用户提问句、疑问句(即使涉及 agent 行为)
- 含"也许/可能/猜测"等不确定措辞且无明确废弃指令

若触发,提取受影响的行为主题(简短描述,如"steam查询流程")。
只返回 JSON 数组,大多数消息应返回 []。`;
	const content = await callChat(config, prompt, 96);
	return parseJsonStringArray(content);
}

async function checkInvalidate(config: EngineConfig, topic: string, candidates: MemoryHit[]): Promise<string[]> {
	const oldBlock = candidates.map((candidate) => `- id=${candidate.id} | ${candidate.summary}`).join("\n");
	const prompt = `用户明确表示 agent 关于"${topic}"的现有行为/流程有误,需要废弃。
以下是数据库中与该主题相关的现有规则,判断哪些应被标记为废弃:

${oldBlock}

规则:
- 若条目确实描述了"${topic}"相关的 agent 操作流程/行为,输出其 id
- 若条目与该主题无关,不输出
- 若无关联条目,返回 []

只返回 JSON 数组,如 ["abc123"] 或 []`;
	const content = await callChat(config, prompt, 96);
	const selected = parseJsonStringArray(content);
	const validIds = new Set(candidates.map((candidate) => candidate.id));
	return selected.filter((id) => validIds.has(id));
}

function parseJsonStringArray(text: string | undefined): string[] {
	if (!text) return [];
	const cleaned = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```$/, "");
	try {
		const parsed = JSON.parse(cleaned) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	} catch {
		return [];
	}
}

// ------------------------------------------------------------------
// Provider HTTP + config helpers
// ------------------------------------------------------------------

async function callChat(config: EngineConfig, prompt: string, maxTokens: number): Promise<string | undefined> {
	const apiKey = readProviderKey(getAgentDir(), config.provider);
	if (!apiKey) return undefined;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
	try {
		const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: config.model,
				messages: [{ role: "user", content: prompt }],
				max_tokens: maxTokens,
			}),
		});
		if (!response.ok) return undefined;
		const data = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
		return data.choices?.[0]?.message?.content?.trim() || undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

function readProviderKey(agentDir: string, provider: string): string | undefined {
	try {
		const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8")) as Record<
			string,
			{ type?: string; key?: string }
		>;
		return auth[provider]?.key;
	} catch {
		return undefined;
	}
}

function loadConfig(agentDir: string): EngineConfig {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "memory-engine.json"), "utf-8")) as Partial<EngineConfig>;
		return { ...DEFAULT_CONFIG, ...raw };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

function textResult(
	text: string,
	details: Record<string, unknown>,
): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
} {
	return { content: [{ type: "text", text }], details };
}

function messageText(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	const content = message.content;
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join(" ")
			.trim();
	}
	return (content ?? "").trim();
}

function serializeMessages(messages: AgentMessage[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (!("content" in message)) continue;
		const text = messageText(message);
		if (!text) continue;
		lines.push(`[${message.role}] ${text}`);
	}
	return lines.join("\n");
}

function resolveMemoryTypes(memoryKind: string | undefined, intent: string | undefined): MemoryType[] {
	if (memoryKind?.trim()) {
		const kind = memoryKind.trim();
		return isMemoryType(kind) ? [kind] : [];
	}
	const kinds = intent ? INTENT_KINDS[intent] : undefined;
	return kinds ?? [];
}

function splitWriteResult(result: string): [string, string] {
	const separator = result.indexOf(":");
	const status = separator === -1 ? result : result.slice(0, separator);
	const itemId = separator === -1 ? "" : result.slice(separator + 1);
	return [status, itemId];
}

function summaryHash(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}
