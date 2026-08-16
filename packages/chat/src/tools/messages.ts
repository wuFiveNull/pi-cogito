/**
 * Chat message history tools — fetch_messages / search_messages.
 *
 * Read the gateway's canonical channel message store (channel-messages.json),
 * which records every inbound/outbound message with its delivery status.
 */

import type { ChannelMessageRecord, ChannelSdk } from "@cogito/gateway";
import type { AgentToolResult, ToolDefinition } from "@cogito/host";
import { defineTool } from "@cogito/host";
import { Type } from "typebox";

export function createMessageHistoryTools(sdk: ChannelSdk): ToolDefinition[] {
	return [
		defineTool({
			name: "fetch_messages",
			label: "fetch_messages",
			description: "读取某个渠道会话的最近消息历史(含入站与出站)。",
			searchHint: "消息回溯 历史消息 最近消息 聊天记录 fetch",
			promptSnippet: "Fetch recent chat messages",
			promptGuidelines: ["Use fetch_messages to review what was said earlier in a channel chat."],
			parameters: Type.Object({
				channel: Type.String({ description: "渠道名,如 telegram、qq、web" }),
				chat_id: Type.String({ description: "会话 ID" }),
				limit: Type.Optional(Type.Number({ description: "最多返回消息数,默认 20,上限 100" })),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
				const limit = Math.max(1, Math.min(100, params.limit ?? 20));
				try {
					const records = sdk.listMessages({
						channel: params.channel,
						chatId: params.chat_id,
						limit,
					});
					return textResult(formatRecords(records));
				} catch (error) {
					return textResult(`读取消息失败: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		}),
		defineTool({
			name: "search_messages",
			label: "search_messages",
			description: "在渠道消息历史中按关键词搜索。",
			searchHint: "聊过什么 历史对话 消息搜索 之前说过 search",
			promptSnippet: "Search chat message history",
			parameters: Type.Object({
				query: Type.String({ description: "搜索关键词" }),
				channel: Type.Optional(Type.String({ description: "限定渠道名" })),
				chat_id: Type.Optional(Type.String({ description: "限定会话 ID" })),
				limit: Type.Optional(Type.Number({ description: "最多返回条数,默认 10,上限 50" })),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
				const limit = Math.max(1, Math.min(50, params.limit ?? 10));
				const needle = String(params.query ?? "").toLowerCase();
				if (needle.length === 0) return textResult("query 不能为空。");
				try {
					const records = sdk.listMessages({
						...(params.channel ? { channel: params.channel } : {}),
						...(params.chat_id ? { chatId: params.chat_id } : {}),
						limit: 500,
					});
					const hits = records
						.filter((record) => messageText(record).toLowerCase().includes(needle))
						.slice(0, limit);
					return textResult(formatRecords(hits));
				} catch (error) {
					return textResult(`搜索失败: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		}),
	];
}

function messageText(record: ChannelMessageRecord): string {
	const message = record.message;
	if (typeof message?.content === "string") return message.content;
	return "";
}

function formatRecords(records: ChannelMessageRecord[]): string {
	if (records.length === 0) return "没有找到消息。";
	const lines = records.map((record) => {
		const direction = record.direction === "inbound" ? "用户" : "助手";
		const at = new Date(record.createdAt).toISOString();
		return `[${at}] ${direction}: ${messageText(record)}`;
	});
	return lines.join("\n");
}

function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}
