/**
 * Wake 单事件工具(akashic plugins/wake_proactive/event_tools.py port)。
 * alert 强制 send_event;context 可 send_event / skip_event。
 */

export interface EventToolResult {
	decision: "reply" | "skip";
	message: string;
}

export interface EventToolSchema {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const EVENT_TOOL_SCHEMAS: EventToolSchema[] = [
	{
		type: "function",
		function: {
			name: "send_event",
			description: "发送根据本轮单条 alert 或 context 写成的自然主动消息。",
			parameters: {
				type: "object",
				properties: { message: { type: "string" } },
				required: ["message"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "skip_event",
			description: "当前 ContextEvent 不值得单独打扰用户,保持安静。",
			parameters: {
				type: "object",
				properties: { reason: { type: "string" } },
				required: ["reason"],
				additionalProperties: false,
			},
		},
	},
];

export function executeEventTool(name: string, arguments_: Record<string, unknown>): EventToolResult {
	if (name === "skip_event") return { decision: "skip", message: "" };
	if (name !== "send_event") throw new Error(`unknown wake event tool: ${name}`);
	const message = String(arguments_.message ?? "").trim();
	if (!message) throw new Error("send_event message 不能为空");
	return { decision: "reply", message };
}
