/**
 * Schedule tools — schedule / list_schedules / cancel_schedule.
 *
 * Jobs are scoped to the conversation (per-session closure), so the agent
 * schedules reminders for its own chat without naming a target chat.
 */

import type { AgentToolResult, ToolDefinition } from "@cogito/host";
import { defineTool } from "@cogito/host";
import { Type } from "typebox";
import type { ChatScheduler, ChatScheduleTier, ChatScheduleTrigger } from "../scheduler.ts";

const tierSchema = Type.Union([Type.Literal("instant"), Type.Literal("soft")]);
const triggerSchema = Type.Union([Type.Literal("at"), Type.Literal("after"), Type.Literal("every")]);

export function createScheduleTools(
	scheduler: ChatScheduler,
	scope: { sessionKey: string; channel: string; chatId: string },
): ToolDefinition[] {
	return [
		defineTool({
			name: "schedule",
			label: "schedule",
			description:
				"注册定时任务,到点向当前会话发送消息。trigger: at(绝对时间,如 '14:30' 或 ISO 时间)、after(相对延迟,如 '30s' '5m' '2h' '1d')、every(循环,如 '1h' '30m' 或每日 '09:00')。tier: instant(到点直接发送 prompt 文本)、soft(到点调用 AI 生成内容后发送)。",
			promptSnippet: "Register a scheduled reminder",
			promptGuidelines: ["Use schedule for reminders and timed tasks; every triggers repeat until cancelled."],
			parameters: Type.Object({
				tier: tierSchema,
				trigger: triggerSchema,
				when: Type.String({ description: "触发时间描述,见说明" }),
				prompt: Type.String({ description: "instant:要发送的文本;soft:要生成内容的请求" }),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
				const result = await scheduler.schedule({
					sessionKey: scope.sessionKey,
					tier: params.tier as ChatScheduleTier,
					trigger: params.trigger as ChatScheduleTrigger,
					when: params.when,
					prompt: params.prompt,
					targetChannel: scope.channel,
					targetChatId: scope.chatId,
				});
				return result.ok
					? textResult(`已注册定时任务 (id=${result.id}),下次触发: ${result.nextFireAt}`)
					: textResult(`注册失败: ${result.error}`);
			},
		}),
		defineTool({
			name: "list_schedules",
			label: "list_schedules",
			description: "列出当前会话的所有定时任务。",
			promptSnippet: "List scheduled tasks",
			parameters: Type.Object({}),
			async execute(): Promise<AgentToolResult<undefined>> {
				const jobs = scheduler.list();
				const own = jobs.filter((job) => job.sessionKey === scope.sessionKey);
				if (own.length === 0) return textResult("当前会话没有定时任务。");
				const lines = own.map(
					(job) =>
						`${job.id} [${job.tier}/${job.trigger}] 下次: ${job.nextFireAt}${job.enabled ? "" : " (已停用)"} prompt: ${job.prompt}`,
				);
				return textResult(lines.join("\n"));
			},
		}),
		defineTool({
			name: "cancel_schedule",
			label: "cancel_schedule",
			description: "取消(停用)一个定时任务。",
			promptSnippet: "Cancel a scheduled task",
			parameters: Type.Object({
				id: Type.String({ description: "要取消的任务 id" }),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
				const cancelled = scheduler.cancel(params.id);
				return textResult(cancelled ? "已取消。" : `未找到任务: ${params.id}`);
			},
		}),
	];
}

function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}
