/**
 * Integration tests for the subagent extension:
 * - registerTool path: spawn / spawn_manage are enumerable and executable
 *   after loading the extension through the harness resource loader;
 * - chat-style end-to-end: the main agent calls spawn (sync), the subagent
 *   executes in isolation, and the result comes back as a tool_result;
 * - background end-to-end: spawn returns immediately, and the completion is
 *   delivered back to the origin session as a new user message/turn.
 */

import type { AgentMessage } from "@cogito/agent-core";
import { describe, expect, it } from "vitest";
import { createSubagentExtension } from "../src/core/subagent-extension.ts";
import { SubagentManager, type SubagentRunner } from "../src/core/subagent-manager.ts";
import { createSubagentAgentRunner } from "../src/core/subagent-runner.ts";
import { createFauxStreamFn, createHarnessWithExtensions, fauxModel } from "./test-harness.ts";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`waitFor timeout: ${label}`);
		}
		await delay(10);
	}
}

function messageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text?: string } => isRecord(part) && part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messagesOfType(messages: AgentMessage[], role: AgentMessage["role"]): AgentMessage[] {
	return messages.filter((message) => message.role === role);
}

function lastMessageText(messages: AgentMessage[], role: AgentMessage["role"]): string {
	const last = messagesOfType(messages, role).at(-1);
	return last ? messageText(last) : "";
}

describe("subagent extension", () => {
	it("registers spawn and spawn_manage tools via registerTool", async () => {
		const manager = new SubagentManager({
			runner: {
				run: async () => ({ status: "completed", exitReason: "completed", result: "ok" }),
				shutdown: async () => {},
			},
		});
		const harness = await createHarnessWithExtensions({
			extensionFactories: [createSubagentExtension({ manager })],
		});
		try {
			const toolNames = harness.session.getAllTools().map((tool) => tool.name);
			expect(toolNames).toContain("spawn");
			expect(toolNames).toContain("spawn_manage");
			const activeNames = harness.session.getActiveToolNames();
			expect(activeNames).toContain("spawn");
			expect(activeNames).toContain("spawn_manage");

			// The wrapped tools are executable directly through the agent runtime.
			const manageTool = harness.agent.state.tools.find((tool) => tool.name === "spawn_manage");
			expect(manageTool).toBeDefined();
			const listResult = await manageTool?.execute("tc_list", { action: "list" });
			expect(listResult).toBeDefined();
			expect(JSON.parse(messageTextFromResult(listResult))).toEqual({ running_count: 0, jobs: [] });
		} finally {
			harness.cleanup();
		}
	});

	it("reports capacity errors as tool text instead of throwing", async () => {
		// Fill all admission slots with hanging jobs, then call the registered
		// spawn tool: the capacity error must come back as result text.
		const hanging: SubagentRunner = {
			run: async (_request, signal) => {
				await new Promise<void>((_resolve, reject) => {
					if (signal.aborted) {
						reject(new DOMException("aborted", "AbortError"));
						return;
					}
					signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
						once: true,
					});
				});
				throw new Error("unreachable");
			},
			shutdown: async () => {},
		};
		const manager = new SubagentManager({ runner: hanging, maxConcurrent: 1 });
		manager.spawn({ task: "occupying the slot" });
		const harness = await createHarnessWithExtensions({
			extensionFactories: [createSubagentExtension({ manager })],
		});
		try {
			const spawnTool = harness.agent.state.tools.find((tool) => tool.name === "spawn");
			expect(spawnTool).toBeDefined();
			const result = await spawnTool?.execute("tc_spawn", { task: "another task" });
			expect(result).toBeDefined();
			const text = messageTextFromResult(result);
			expect(text).toContain("spawn 失败");
			expect(text).toContain("subagent capacity reached");
			expect(manager.getRunningCount()).toBe(1);
		} finally {
			await manager.shutdown();
			harness.cleanup();
		}
	});

	it("sync e2e: main agent spawns, subagent executes, result returns as tool_result", async () => {
		const subFaux = createFauxStreamFn(["子任务报告: 找到了 3 个匹配文件"]);
		const runner = createSubagentAgentRunner({
			model: fauxModel,
			cwd: harnessCwd(),
			streamFn: subFaux.streamFn,
		});
		const manager = new SubagentManager({ runner });
		const harness = await createHarnessWithExtensions({
			responses: [
				{
					toolCalls: [
						{ name: "spawn", args: { task: "找出所有匹配文件", label: "匹配", run_in_background: false } },
					],
				},
				"主回复: 已汇总子任务结果。",
			],
			extensionFactories: [createSubagentExtension({ manager })],
		});
		try {
			await harness.session.prompt("请帮我调研一下");
			await harness.agent.waitForIdle();

			// The subagent ran exactly once, isolated from the main transcript.
			expect(subFaux.state.callCount).toBe(1);

			// The result came back as a tool_result the main agent can continue from.
			const toolResults = messagesOfType(harness.session.messages, "toolResult");
			expect(toolResults.length).toBe(1);
			const toolResultText = messageText(toolResults[0]);
			expect(toolResultText).toContain("[子任务「匹配」结果]");
			expect(toolResultText).toContain("状态: completed");
			expect(toolResultText).toContain("子任务报告: 找到了 3 个匹配文件");

			// The main session kept its own transcript shape (no subagent internals).
			const roles = harness.session.messages.map((message) => message.role);
			expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
			expect(lastMessageText(harness.session.messages, "assistant")).toContain("主回复: 已汇总子任务结果。");
		} finally {
			harness.cleanup();
		}
	});

	it("background e2e: spawn returns immediately, completion is delivered back as a new turn", async () => {
		const subFaux = createFauxStreamFn([{ text: "后台调研结果: 42", delayMs: 100 }]);
		const runner = createSubagentAgentRunner({
			model: fauxModel,
			cwd: harnessCwd(),
			streamFn: subFaux.streamFn,
		});
		const manager = new SubagentManager({ runner });
		const harness = await createHarnessWithExtensions({
			responses: [
				{
					toolCalls: [{ name: "spawn", args: { task: "后台调研", label: "后台", run_in_background: true } }],
				},
				"已创建后台任务,完成后我会继续处理。",
				"最终: 子任务结果已收到,正在汇报。",
			],
			extensionFactories: [createSubagentExtension({ manager })],
		});
		try {
			await harness.session.prompt("开始调研");
			await harness.agent.waitForIdle();

			// The first turn ended without waiting for the background job: the
			// completion message is not in the transcript yet.
			expect(lastMessageText(harness.session.messages, "assistant")).toContain("已创建后台任务");
			expect(
				messagesOfType(harness.session.messages, "user").some((message) =>
					messageText(message).includes("[后台子任务完成"),
				),
			).toBe(false);

			// The completion arrives as a new user message, then a follow-up turn.
			await waitFor(
				() =>
					messagesOfType(harness.session.messages, "user").some((message) =>
						messageText(message).includes("[后台子任务完成"),
					),
				"background completion message",
			);
			const delivered = messagesOfType(harness.session.messages, "user").find((message) =>
				messageText(message).includes("[后台子任务完成"),
			);
			expect(delivered).toBeDefined();
			expect(messageText(delivered as AgentMessage)).toContain("后台调研结果: 42");
			expect(messageText(delivered as AgentMessage)).toContain("状态: completed");

			await waitFor(
				() => lastMessageText(harness.session.messages, "assistant").includes("最终: 子任务结果已收到"),
				"follow-up turn reply",
			);
			expect(subFaux.state.callCount).toBe(1);
			expect(manager.getRunningCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});

function harnessCwd(): string {
	return process.cwd();
}

function messageTextFromResult(result: unknown): string {
	const record = result as { content?: Array<{ type: string; text?: string }> };
	return (record.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}
