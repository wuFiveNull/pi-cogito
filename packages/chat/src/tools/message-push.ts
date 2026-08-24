/**
 * message_push tool — the agent sends a message/file to any registered channel
 * mid-turn (akashic MessagePushTool equivalent).
 */

import type { AgentToolResult, ToolDefinition } from "@cogito/host";
import { defineTool } from "@cogito/host";
import { Type } from "typebox";
import type { ChatDelivery } from "../delivery.ts";
import type { ChatSessionScope } from "../session-pool.ts";

export function createMessagePushTool(delivery: ChatDelivery, scope: ChatSessionScope): ToolDefinition {
	const defaultChannel = scope.channel;
	const defaultChatId = scope.chatId;
	return defineTool({
		name: "message_push",
		label: "message_push",
		description:
			"向指定渠道的用户主动发送消息、文件或图片。target_channel 与 target_chat_id 可省略,省略时发送到当前对话所在渠道(通常就是要回复的用户)。message 与 media 至少提供一个。",
		searchHint: "推送 发消息 主动通知 提醒 发文件 发送",
		promptSnippet: "Send a message or file to a channel chat",
		promptGuidelines: [
			"Use message_push to send proactive messages, reminders, or files to any registered channel.",
			"省略 target_channel/target_chat_id 时发送到当前对话渠道;不要编造 web/default 之类的不存在的目标。",
		],
		parameters: Type.Object({
			target_channel: Type.Optional(Type.String({ description: "目标渠道名,省略时用当前对话渠道" })),
			target_chat_id: Type.Optional(Type.String({ description: "目标会话 ID,省略时用当前对话会话" })),
			message: Type.Optional(Type.String({ description: "要发送的文本内容" })),
			media: Type.Optional(
				Type.Array(
					Type.String({
						description: "要发送的文件/图片:HTTP(S) URL、本地路径或 data URL",
					}),
				),
			),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
			const content = params.message ?? "";
			const media = params.media ?? [];
			if (content.length === 0 && media.length === 0) {
				return textResult("message 与 media 至少提供一个。");
			}
			try {
				await delivery.send({
					channel: params.target_channel ?? defaultChannel,
					chatId: params.target_chat_id ?? defaultChatId,
					content,
					...(media.length > 0 ? { media } : {}),
				});
				return textResult("已发送。");
			} catch (error) {
				return textResult(`发送失败: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});
}

function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}
