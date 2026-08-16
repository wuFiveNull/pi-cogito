/**
 * Memory tools — memorize / recall_memory / forget_memory.
 *
 * Scoped to the conversation by default (scope comes from the per-session
 * closure); callers may pass explicit channel/chatId to target another chat.
 */

import type { AgentToolResult, MemoryScope, ToolDefinition } from "@cogito/host";
import { defineTool, MEMORY_TYPES, type MemoryType } from "@cogito/host";
import { Type } from "typebox";
import type { ChatMemory } from "../memory.ts";

const memoryTypeSchema = Type.Union(MEMORY_TYPES.map((type) => Type.Literal(type)));

export function createMemoryTools(memory: ChatMemory, scope: MemoryScope): ToolDefinition[] {
	return [
		defineTool({
			name: "memorize",
			label: "memorize",
			description:
				"把一条事实、偏好或流程写入长期记忆。memoryType: event(一次性事实/决定)、profile(稳定用户信息)、preference(用户偏好与规则)、procedure(多步骤流程)。默认 scope 为当前会话;可用 channel/chatId 指定其他会话。",
			searchHint: "记住 记忆 写入 保存 记住用户信息 memorize",
			promptSnippet: "Write a fact to long-term memory",
			promptGuidelines: [
				"Prefer memorize over repeating facts: durable user facts, preferences, and procedures belong in memory.",
			],
			parameters: Type.Object({
				summary: Type.String({ description: "要记住的内容" }),
				memoryType: Type.Optional(memoryTypeSchema),
				channel: Type.Optional(Type.String({ description: "记忆所属渠道(默认当前会话)" })),
				chatId: Type.Optional(Type.String({ description: "记忆所属会话(默认当前会话)" })),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
				const targetScope = explicitScope(params.channel, params.chatId) ?? scope;
				try {
					const id = await memory.remember({
						summary: params.summary,
						memoryType: params.memoryType as MemoryType | undefined,
						scope: targetScope,
						sourceRef: "chat",
					});
					return textResult(`已记住 (id=${id})。`);
				} catch (error) {
					return textResult(`记忆失败: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		}),
		defineTool({
			name: "recall_memory",
			label: "recall_memory",
			description:
				"检索长期记忆中与查询相关的内容(用户偏好、规则、历史事实)。默认 scope 为当前会话;可用 channel/chatId 指定其他会话。",
			searchHint: "记忆 回忆 检索 用户偏好 历史 记得 recall",
			promptSnippet: "Recall related long-term memory",
			parameters: Type.Object({
				query: Type.String({ description: "检索关键词或问题" }),
				channel: Type.Optional(Type.String({ description: "检索渠道(默认当前会话)" })),
				chatId: Type.Optional(Type.String({ description: "检索会话(默认当前会话)" })),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
				const targetScope = explicitScope(params.channel, params.chatId) ?? scope;
				try {
					const block = await memory.recallBlock(params.query, targetScope);
					return textResult(block.length > 0 ? block : "没有检索到相关记忆。");
				} catch (error) {
					return textResult(`检索失败: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		}),
		defineTool({
			name: "forget_memory",
			label: "forget_memory",
			description: "按记忆 id 删除(遗忘)记忆条目。",
			searchHint: "忘记 删除记忆 遗忘 纠正错误记忆 forget",
			promptSnippet: "Forget memory items",
			parameters: Type.Object({
				ids: Type.Array(Type.String({ description: "要删除的记忆 id" })),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
				try {
					const result = memory.forget(params.ids);
					return textResult(
						`已遗忘 ${result.affected.length} 条${result.missing.length > 0 ? `,${result.missing.length} 条不存在` : ""}。`,
					);
				} catch (error) {
					return textResult(`遗忘失败: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		}),
	];
}

function explicitScope(channel: string | undefined, chatId: string | undefined): MemoryScope | undefined {
	if (channel !== undefined && chatId !== undefined && channel.length > 0 && chatId.length > 0) {
		return { channel, chatId };
	}
	return undefined;
}

function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}
