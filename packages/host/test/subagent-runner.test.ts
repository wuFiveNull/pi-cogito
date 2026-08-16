/**
 * Tests for createSubagentAgentRunner: isolated in-process execution with the
 * faux stream function, tool whitelisting, iteration caps, and abort bridging.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@cogito/agent-core";
import type { AssistantMessage } from "@cogito/ai";
import { createAssistantMessageEventStream } from "@cogito/ai";
import { describe, expect, it } from "vitest";
import { createSubagentAgentRunner, DEFAULT_SUBAGENT_TOOLS } from "../src/core/subagent-runner.ts";
import { createFauxStreamFn, fauxModel } from "./test-harness.ts";

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "subagent-runner-"));
}

function cleanCwd(dir: string): void {
	if (existsSync(dir)) rmSync(dir, { recursive: true });
}

/** Extract the tool names the model saw in the first LLM call. */
function firstContextTools(streamFn: ReturnType<typeof createFauxStreamFn>): string[] {
	const context = streamFn.state.contexts[0];
	return (context.tools ?? []).map((tool) => tool.name);
}

describe("createSubagentAgentRunner", () => {
	it("runs a task and returns the final assistant text", async () => {
		const cwd = tempCwd();
		try {
			const faux = createFauxStreamFn(["调研结论: 文件在 src/index.ts"]);
			const runner = createSubagentAgentRunner({
				model: fauxModel,
				cwd,
				streamFn: faux.streamFn,
			});
			const result = await runner.run({ task: "找到入口文件" }, new AbortController().signal);
			expect(result.status).toBe("completed");
			expect(result.exitReason).toBe("completed");
			expect(result.result).toBe("调研结论: 文件在 src/index.ts");
		} finally {
			cleanCwd(cwd);
		}
	});

	it("applies the request tool whitelist and skips unknown tools", async () => {
		const cwd = tempCwd();
		try {
			const faux = createFauxStreamFn([
				{ toolCalls: [{ name: "read", args: { file_path: join(cwd, "missing.txt") } }] },
				"done reading",
			]);
			const runner = createSubagentAgentRunner({
				model: fauxModel,
				cwd,
				streamFn: faux.streamFn,
			});
			const result = await runner.run(
				{ task: "read a file", tools: ["read", "spawn", "bogus_tool"] },
				new AbortController().signal,
			);
			expect(result.status).toBe("completed");
			expect(firstContextTools(faux)).toEqual(["read"]);
		} finally {
			cleanCwd(cwd);
		}
	});

	it("defaults to the read-only research tool set", async () => {
		const cwd = tempCwd();
		try {
			const faux = createFauxStreamFn(["plain text reply"]);
			const runner = createSubagentAgentRunner({
				model: fauxModel,
				cwd,
				streamFn: faux.streamFn,
			});
			await runner.run({ task: "no tools specified" }, new AbortController().signal);
			expect(firstContextTools(faux)).toEqual([...DEFAULT_SUBAGENT_TOOLS]);
		} finally {
			cleanCwd(cwd);
		}
	});

	it("returns failed with the error message for LLM errors", async () => {
		const cwd = tempCwd();
		try {
			const faux = createFauxStreamFn([{ error: "provider rate limited" }]);
			const runner = createSubagentAgentRunner({
				model: fauxModel,
				cwd,
				streamFn: faux.streamFn,
			});
			const result = await runner.run({ task: "will fail" }, new AbortController().signal);
			expect(result.status).toBe("failed");
			expect(result.exitReason).toBe("error");
			expect(result.result).toContain("provider rate limited");
		} finally {
			cleanCwd(cwd);
		}
	});

	it("returns cancelled immediately when the signal is already aborted", async () => {
		const cwd = tempCwd();
		try {
			const faux = createFauxStreamFn(["should never run"]);
			const runner = createSubagentAgentRunner({
				model: fauxModel,
				cwd,
				streamFn: faux.streamFn,
			});
			const controller = new AbortController();
			controller.abort();
			const result = await runner.run({ task: "aborted before start" }, controller.signal);
			expect(result.status).toBe("cancelled");
			expect(faux.state.callCount).toBe(0);
		} finally {
			cleanCwd(cwd);
		}
	});

	it("cancels a mid-run task when the signal aborts", async () => {
		const cwd = tempCwd();
		try {
			// Stream that only settles once the signal aborts (mimics a provider
			// honoring the request signal).
			const signalAware: StreamFn = (_model, _context, options) => {
				const stream = createAssistantMessageEventStream();
				const pending = setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: lateMessage() });
				}, 60_000);
				options?.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(pending);
						stream.push({ type: "error", reason: "aborted", error: abortedMessage() });
					},
					{ once: true },
				);
				return stream;
			};
			const runner = createSubagentAgentRunner({
				model: fauxModel,
				cwd,
				streamFn: signalAware,
			});
			const controller = new AbortController();
			const pending = runner.run({ task: "long task" }, controller.signal);
			setTimeout(() => controller.abort(), 30);
			const result = await pending;
			expect(result.status).toBe("cancelled");
			expect(result.exitReason).toBe("aborted");
		} finally {
			cleanCwd(cwd);
		}
	});

	it("stops the tool loop at the iteration cap", async () => {
		const cwd = tempCwd();
		try {
			// Tool-call responses keep the loop alive; the cap must stop it at
			// maxIterations LLM calls.
			const faux = createFauxStreamFn([
				{ toolCalls: [{ name: "read", args: { file_path: join(cwd, "a.txt") } }] },
				{ toolCalls: [{ name: "read", args: { file_path: join(cwd, "b.txt") } }] },
				{ toolCalls: [{ name: "read", args: { file_path: join(cwd, "c.txt") } }] },
			]);
			const runner = createSubagentAgentRunner({
				model: fauxModel,
				cwd,
				streamFn: faux.streamFn,
				maxIterations: 2,
			});
			const result = await runner.run({ task: "loop bounded" }, new AbortController().signal);
			expect(faux.state.callCount).toBe(2);
			// The last assistant message carried only tool calls, so no text output.
			expect(result.status).toBe("failed");
			expect(result.exitReason).toBe("no_output");
		} finally {
			cleanCwd(cwd);
		}
	});

	it("honors a per-request system prompt override", async () => {
		const cwd = tempCwd();
		try {
			const faux = createFauxStreamFn(["ok"]);
			const runner = createSubagentAgentRunner({
				model: fauxModel,
				cwd,
				streamFn: faux.streamFn,
			});
			await runner.run({ task: "task", systemPrompt: "CUSTOM SUBAGENT PROMPT" }, new AbortController().signal);
			expect(faux.state.contexts[0].systemPrompt).toContain("CUSTOM SUBAGENT PROMPT");
		} finally {
			cleanCwd(cwd);
		}
	});
});

function lateMessage(): AssistantMessage {
	return assistantMessage("late");
}

function abortedMessage(): AssistantMessage {
	return {
		...assistantMessage(""),
		stopReason: "aborted",
		errorMessage: "aborted",
	};
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "anthropic-messages",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
