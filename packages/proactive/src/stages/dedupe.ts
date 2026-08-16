/**
 * LLM 消息去重(akashic deduper.py port)。
 *
 * 规则去重(内容 id / 消息 hash / 最近 N 条文本相等)只能识别字面重复;
 * 语义重复(同一事件的不同表述、同一状态总结框架)需要 LLM 判断。
 * 在规则去重通过后调用。调用失败时放行,不阻塞投递(akashic 会抛错使 tick
 * 失败,这里选择 fail-open)。
 */

import { type ChatCompletionClient, OpenAICompatibleChatClient } from "@cogito/ai/chat";

export interface RecentDeliveryLike {
	message: string;
	delivered_at?: number;
	state_summary_tag?: string;
}

export interface DedupeResult {
	duplicate: boolean;
	reason: string;
}

export interface DedupeLlmOptions {
	model: string;
	baseUrl: string;
	apiKey: string | undefined;
	requestTimeoutMs?: number;
	fetchFn?: typeof fetch;
	/** 宿主注入的 ChatCompletionClient(pi-host ModelRuntime);缺省走配置式客户端。 */
	client?: ChatCompletionClient;
}

/** 格式化近期消息列表(akashic _format_recent_proactive_entries)。 */
export function formatRecentEntries(recent: RecentDeliveryLike[]): string {
	return recent
		.map((message, index) => {
			const meta: string[] = [];
			if (message.delivered_at) meta.push(`time=${new Date(message.delivered_at).toISOString()}`);
			const tag = (message.state_summary_tag ?? "").trim();
			if (tag && tag !== "none") meta.push(`state_tag=${tag}`);
			const suffix = meta.length > 0 ? ` (${meta.join("; ")})` : "";
			return `[${index + 1}]${suffix} ${message.message}`;
		})
		.join("\n---\n");
}

const DEDUPE_SYSTEM_PROMPT = `你是消息重复检测器。判断【新消息】是否与【近期已发消息】在实质信息上重复。
重复包括:同一事件重复,或同一用户状态总结/安慰框架重复。
不重复包括:同话题但有真正新进展或明显不同角度。
只输出 JSON。`;

function buildUserPrompt(newMessage: string, recentText: string): string {
	return (
		`近期已发消息:\n${recentText}\n\n` +
		`---\n新消息:${newMessage}\n\n` +
		"---\n只输出 JSON:\n" +
		'{"is_duplicate": false, "reason": "简短说明"}'
	);
}

/** 从 LLM 回复中提取 JSON 对象(容忍 ```json 围栏)。 */
export function extractJsonObject(text: string): Record<string, unknown> {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
	const candidate = fenced ? (fenced[1] ?? "").trim() : trimmed;
	try {
		const parsed = JSON.parse(candidate) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * LLM 判断新消息是否与近期已发消息语义重复。近期消息为空时直接放行。
 * 调用失败(网络/解析)时返回 { duplicate: false, reason: "dedupe_*" }。
 */
export async function isMessageDuplicate(
	newMessage: string,
	recent: RecentDeliveryLike[],
	options: DedupeLlmOptions,
): Promise<DedupeResult> {
	if (recent.length === 0) return { duplicate: false, reason: "无近期主动消息,放行" };
	try {
		const client =
			options.client ??
			new OpenAICompatibleChatClient({
				model: options.model,
				baseUrl: options.baseUrl,
				apiKey: options.apiKey ?? "",
				requestTimeoutMs: options.requestTimeoutMs,
			});
		const response = await client.complete({
			messages: [
				{ role: "system", content: DEDUPE_SYSTEM_PROMPT },
				{ role: "user", content: buildUserPrompt(newMessage, formatRecentEntries(recent)) },
			],
			maxTokens: 128,
			temperature: 0,
			fetchFn: options.fetchFn,
		});
		if (!response.content) return { duplicate: false, reason: "dedupe_no_content" };
		const payload = extractJsonObject(response.content);
		if (typeof payload.is_duplicate !== "boolean" || typeof payload.reason !== "string") {
			return { duplicate: false, reason: "dedupe_invalid_json" };
		}
		return { duplicate: payload.is_duplicate, reason: payload.reason };
	} catch {
		return { duplicate: false, reason: "dedupe_llm_unavailable" };
	}
}
