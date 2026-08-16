/**
 * message_push tool — the agent sends a message/file to any registered channel
 * mid-turn (akashic MessagePushTool equivalent).
 */

import type { AgentToolResult, ToolDefinition } from "@cogito/host";
import { defineTool } from "@cogito/host";
import { Type } from "typebox";
import type { ChatDelivery } from "../delivery.ts";

export function createMessagePushTool(delivery: ChatDelivery): ToolDefinition {
	return defineTool({
		name: "message_push",
		label: "message_push",
		description:
			"向指定渠道的用户主动发送消息、文件或图片。需要目标渠道名(如 telegram、qq、web)和目标 chat_id。message 与 media 至少提供一个。",
		promptSnippet: "Send a message or file to a channel chat",
		promptGuidelines: ["Use message_push to send proactive messages, reminders, or files to any registered channel."],
		parameters: Type.Object({
			target_channel: Type.String({ description: "目标渠道名,如 telegram、qq、web" }),
			target_chat_id: Type.String({ description: "目标会话 ID" }),
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
					channel: params.target_channel,
					chatId: params.target_chat_id,
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
