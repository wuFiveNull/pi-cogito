/**
 * 近期会话收集(akashic proactive_v2/sensor.py collect_recent 移植)。
 *
 * 判题工具 get_recent_chat 读取最近对话时,统一做三件事:
 * - 只保留 user/assistant 角色消息;
 * - 过滤 context frame(系统注入的上下文帧,不参与「最近对话」语义);
 * - 单条截断到 maxChars 字符,总量限制 recentChatMessages 条。
 *
 * context frame 标记与 akashic agent/prompting/assembler.py is_context_frame
 * 一致:`<system-reminder` 前缀与旧标记 `[SYSTEM_CONTEXT_FRAME]`。
 */

import type { ProactiveSessionMessage } from "../runtime/ports.ts";

/** akashic LEGACY_CONTEXT_FRAME_MARKER。 */
export const LEGACY_CONTEXT_FRAME_MARKER = "[SYSTEM_CONTEXT_FRAME]";

/** 是否 context frame 消息(akashic is_context_frame)。 */
export function isContextFrameContent(content: string): boolean {
	const text = content.replace(/^\s+/, "");
	return text.startsWith("<system-reminder") || text.startsWith(LEGACY_CONTEXT_FRAME_MARKER);
}

/** collect_recent 的默认单条截断长度(akashic sensor.py:200)。 */
export const RECENT_CHAT_MESSAGE_MAX_CHARS = 200;

export interface CollectRecentOptions {
	/** 返回的最大消息条数(akashic recent_chat_messages,默认 20)。 */
	limit?: number;
	/** 单条消息截断长度(akashic 200)。 */
	maxChars?: number;
}

/**
 * 过滤并格式化最近 user/assistant 消息(akashic Sensor.collect_recent)。
 * 返回 `role: content` 行,供 get_recent_chat 工具直接注入判题上下文。
 */
export function collectRecent(rows: readonly ProactiveSessionMessage[], options: CollectRecentOptions = {}): string {
	const limit = options.limit ?? 20;
	const maxChars = options.maxChars ?? RECENT_CHAT_MESSAGE_MAX_CHARS;
	const lines: string[] = [];
	for (const row of rows) {
		if (row.role !== "user" && row.role !== "assistant") continue;
		const content = String(row.content ?? "");
		if (!content) continue;
		if (isContextFrameContent(content)) continue;
		lines.push(`${row.role}: ${content.slice(0, maxChars)}`);
		if (lines.length >= limit) break;
	}
	return lines.join("\n");
}
