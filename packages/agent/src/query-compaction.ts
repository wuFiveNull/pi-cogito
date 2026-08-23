/**
 * 查询内压缩(akashic agent/model_runtime/query_compaction.py QueryCompactor 移植)。
 *
 * 单次用户请求的长工具循环(ReAct)中,每批工具结果落地后估算上下文占用;
 * 超过触发阈值时把较早的已完成批次压缩成结构化摘要,并以一条标记明确的
 * user 消息投影回上下文(替代被压缩的原始消息),让后续轮次仍能继续执行,
 * 而不是等 provider 报 context overflow。
 *
 * 与 akashic 的差异:akashic 以 context_compact 工具调用/结果对投影并持久化
 * 到 session(跨轮重放);cogito 在 agent-loop 内以摘要 user 消息投影,不落盘
 * (跨轮压缩由 host 的 turn 级自动压缩负责)。
 */

import type { AgentMessage } from "./types.ts";

/** 跨轮持久化的压缩 marker 的 customType(host 经 appendCustomMessageEntry 落 session)。 */
export const QUERY_COMPACTION_CUSTOM_TYPE = "query_compaction";

export interface QueryCompactionOptions {
	/** 模型上下文窗口(token)。 */
	contextWindow: number;
	/** 触发阈值 = contextWindow * triggerPercent。默认 0.74。 */
	triggerPercent?: number;
	/** 保留尾部(活跃批次)的消息对数。默认 1(assistant+toolResult 一对)。 */
	keepRecentBatches?: number;
	/** 摘要生成器:输入被压缩段,输出摘要文本。 */
	summarize: (segment: AgentMessage[], signal?: AbortSignal) => Promise<string>;
	/** 当前上下文 token 估算(缺省按字符粗估;注入精确估算可提高触发准确性)。 */
	estimate?: (messages: AgentMessage[]) => number;
}

export interface CompactionPlan {
	/** 压缩段起始(不含此索引;即上一个压缩点之后的第一个消息)。 */
	startIndex: number;
	/** 压缩段结束(不含;保留尾部活跃批次)。 */
	endIndex: number;
	summary: string;
	/** 压缩时的上下文窗口(token),供持久化 marker 记录。 */
	contextWindow?: number;
}

const DEFAULT_TRIGGER_PERCENT = 0.74;
const DEFAULT_KEEP_RECENT_BATCHES = 1;

/** 摘要投影消息前缀:明确告知模型这是系统压缩,不是用户输入。 */
export const QUERY_COMPACTION_PREFIX =
	"[上下文压缩] 本轮较早的工具执行历史已被系统压缩为以下摘要(不是用户输入,不要引用原文):\n\n";

/**
 * 查询内压缩器:维护上次压缩点,按需把中间历史替换为摘要消息。
 * 使用方式:每批工具结果落地后调用 maybeCompact(messages),
 * 返回非 null 计划时由调用方执行 splice 并调用 recordCompacted(messages, plan)。
 */
export class QueryCompactor {
	private readonly contextWindow: number;
	private readonly triggerTokens: number;
	private readonly keepRecentBatches: number;
	private readonly summarize: (segment: AgentMessage[], signal?: AbortSignal) => Promise<string>;
	private readonly estimate: (messages: AgentMessage[]) => number;
	/** 上次压缩点(消息索引,含);-1 表示从未压缩。 */
	private lastCompactIndex = -1;

	constructor(options: QueryCompactionOptions) {
		this.contextWindow = Math.max(1, options.contextWindow);
		this.triggerTokens = Math.floor(this.contextWindow * (options.triggerPercent ?? DEFAULT_TRIGGER_PERCENT));
		this.keepRecentBatches = Math.max(1, options.keepRecentBatches ?? DEFAULT_KEEP_RECENT_BATCHES);
		this.summarize = options.summarize;
		this.estimate = options.estimate ?? defaultEstimateTokens;
	}

	/**
	 * 评估是否需要压缩。返回 null 表示不需要;
	 * 否则返回压缩段边界与摘要,调用方负责 splice 替换。
	 */
	async maybeCompact(messages: AgentMessage[], signal?: AbortSignal): Promise<CompactionPlan | null> {
		const estimated = this.estimate(messages);
		if (estimated <= this.triggerTokens) {
			return null;
		}
		const plan = this.selectSegment(messages);
		if (!plan) return null;
		const summary = await this.summarize(messages.slice(plan.startIndex, plan.endIndex), signal);
		if (!summary.trim()) return null;
		return { ...plan, summary: summary.trim(), contextWindow: this.contextWindow };
	}

	/** 压缩段选择:自上次压缩点之后、保留尾部活跃批次之前的所有消息。 */
	selectSegment(messages: AgentMessage[]): { startIndex: number; endIndex: number } | null {
		const start = this.lastCompactIndex + 1;
		// 尾部保留:从末尾向前数 keepRecentBatches 对 assistant+toolResult。
		let tail = messages.length;
		let batches = 0;
		for (let i = messages.length - 1; i >= start; i--) {
			if (messages[i]?.role === "assistant") batches++;
			if (batches >= this.keepRecentBatches) {
				tail = i;
				break;
			}
		}
		if (tail - start < 2) return null; // 段内至少要有 2 条消息才有压缩价值。
		const segment = messages.slice(start, tail);
		if (!segment.some((message) => message.role === "assistant" || message.role === "toolResult")) {
			return null;
		}
		return { startIndex: start, endIndex: tail };
	}

	/** 压缩落地后记录新压缩点。 */
	recordCompacted(plan: CompactionPlan): void {
		// 摘要消息位于 startIndex(替换原段)。
		this.lastCompactIndex = plan.startIndex;
	}

	reset(): void {
		this.lastCompactIndex = -1;
	}
}

/** 默认 token 估算:字符数/4 + 图片按 4800 计(与 harness estimateTokens 同一量级)。 */
export function defaultEstimateTokens(messages: readonly AgentMessage[]): number {
	let chars = 0;
	for (const message of messages) {
		chars += messageChars(message);
	}
	return Math.ceil(chars / 4);
}

function messageChars(message: AgentMessage): number {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		if (part.type === "text" && typeof part.text === "string") chars += part.text.length;
		else if (part.type === "thinking" && typeof part.thinking === "string") chars += part.thinking.length;
		else if (part.type === "toolCall" && typeof part.name === "string") {
			chars += part.name.length;
			try {
				chars += JSON.stringify(part.arguments).length;
			} catch {
				// 参数不可序列化时忽略。
			}
		} else if (part.type === "image") {
			chars += 4800;
		}
	}
	return chars;
}

/** 构建摘要请求(akashic compaction summary 结构化字段)。 */
export const QUERY_COMPACTION_SYSTEM = `你是执行历史摘要器。把一段工具执行历史压缩为结构化摘要,只输出摘要正文。

要求:
- 保留:当前目标、关键决策、已完成的步骤与结果、文件操作(路径与要点)、剩余步骤
- 剔除:工具调用细节、原始输出、报错堆栈、与目标无关的中间过程
- 简洁,使用要点列表,中文输出`;

export function buildCompactionUserPrompt(segment: readonly AgentMessage[]): string {
	const lines: string[] = [];
	for (const message of segment) {
		if (message.role === "assistant") {
			const content = (message as { content?: unknown }).content;
			if (Array.isArray(content)) {
				for (const part of content) {
					if (typeof part !== "object" || part === null) continue;
					const record = part as Record<string, unknown>;
					if (record.type === "text" && typeof record.text === "string") lines.push(`[assistant] ${record.text}`);
					else if (record.type === "toolCall" && typeof record.name === "string") {
						lines.push(`[tool] ${record.name}`);
					}
				}
			}
		} else if (message.role === "toolResult") {
			const content = (message as { content?: unknown }).content;
			const text = Array.isArray(content)
				? content
						.map((part) =>
							typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text"
								? String((part as Record<string, unknown>).text ?? "")
								: "",
						)
						.join(" ")
						.trim()
				: "";
			lines.push(`[result] ${text.slice(0, 800)}`);
		}
	}
	return `待压缩的工具执行历史:\n\n${lines.join("\n") || "(空)"}\n\n输出结构化摘要:`;
}

/** 构造摘要投影消息(role: user,带系统压缩标记)。 */
export function buildCompactionSummaryMessage(summary: string, timestamp = Date.now()): AgentMessage {
	return {
		role: "user",
		content: `${QUERY_COMPACTION_PREFIX}${summary}`,
		timestamp,
	};
}

// ---------------------------------------------------------------------------
// 跨轮持久化(akashic react_compaction 元数据等价)
// ---------------------------------------------------------------------------

/** 压缩 marker 的 details 载荷(坐标在「本轮上下文」中度量)。 */
export interface QueryCompactionMarkerDetails {
	/** 压缩段起点(本轮上下文坐标)。 */
	startIndex: number;
	/** 被覆盖的消息数。 */
	coveredCount: number;
	/** 压缩时的上下文窗口(token)。 */
	contextWindow: number;
}

/**
 * 构造持久化 marker:role "custom"、display=false,host 的 message_end 分支会经
 * appendCustomMessageEntry 写入 session;convertToLlm 把 custom 渲染为 user 文本。
 * content 直接是摘要投影文本(带 QUERY_COMPACTION_PREFIX),重放时原样插入。
 */
export function buildQueryCompactionMarker(plan: CompactionPlan): AgentMessage {
	return {
		role: "custom",
		customType: QUERY_COMPACTION_CUSTOM_TYPE,
		content: `${QUERY_COMPACTION_PREFIX}${plan.summary}`,
		display: false,
		details: {
			startIndex: plan.startIndex,
			coveredCount: plan.endIndex - plan.startIndex,
			contextWindow: plan.contextWindow ?? 0,
		} satisfies QueryCompactionMarkerDetails,
		timestamp: Date.now(),
	};
}

export interface QueryCompactionMarker {
	index: number;
	startIndex: number;
	coveredCount: number;
	summary: string;
}

/** 扫描流中的压缩 marker(按出现顺序)。 */
export function collectQueryCompactionMarkers(messages: readonly AgentMessage[]): QueryCompactionMarker[] {
	const markers: QueryCompactionMarker[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "custom" || message.customType !== QUERY_COMPACTION_CUSTOM_TYPE) continue;
		const details = message.details as QueryCompactionMarkerDetails | undefined;
		if (
			!details ||
			!Number.isInteger(details.startIndex) ||
			!Number.isInteger(details.coveredCount) ||
			details.coveredCount <= 0
		) {
			continue;
		}
		markers.push({
			index: i,
			startIndex: details.startIndex,
			coveredCount: details.coveredCount,
			summary: typeof message.content === "string" ? message.content : "",
		});
	}
	return markers;
}

/**
 * 跨轮重放:把上一轮持久化的压缩 marker 落回上下文。
 *
 * 同轮多次压缩严格相邻(recordCompacted 把 lastCompactIndex 设为 plan.startIndex,
 * 下次 start = lastCompactIndex + 1),第 i 个 marker 覆盖原始流中的
 * `[A_i, A_i + c_i)`,其中 `A_i = startIndex_i - i + Σ_{j<i} c_j`。
 *
 * 边界校验:区间升序、不重叠、不越界;任一失败 → 原样返回(保留原文 + marker
 * 文本,只多付 token,绝不丢消息;通常意味着 host turn 级压缩已移除覆盖消息)。
 */
export function replayQueryCompactions(messages: AgentMessage[]): AgentMessage[] {
	const markers = collectQueryCompactionMarkers(messages);
	if (markers.length === 0) return messages;

	let sumPrev = 0;
	const ranges: Array<{ from: number; to: number; summary: string }> = [];
	for (let i = 0; i < markers.length; i++) {
		const marker = markers[i];
		const from = marker.startIndex - i + sumPrev;
		const to = from + marker.coveredCount;
		sumPrev += marker.coveredCount;
		ranges.push({ from, to, summary: marker.summary });
	}
	for (let i = 0; i < ranges.length; i++) {
		const range = ranges[i];
		if (range.from < 0 || range.to > messages.length) return messages;
		if (i > 0 && range.from < ranges[i - 1].to) return messages;
	}

	const markerIndexes = new Set(markers.map((marker) => marker.index));
	const result: AgentMessage[] = [];
	let cursor = 0;
	for (const range of ranges) {
		while (cursor < range.from) {
			if (!markerIndexes.has(cursor)) result.push(messages[cursor]);
			cursor++;
		}
		result.push({ role: "user", content: range.summary, timestamp: Date.now() });
		cursor = range.to;
	}
	while (cursor < messages.length) {
		if (!markerIndexes.has(cursor)) result.push(messages[cursor]);
		cursor++;
	}
	return result;
}
