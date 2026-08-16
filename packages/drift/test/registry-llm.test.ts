import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDriftLlmFn, type DriftChatClient } from "../src/index.ts";
import { OpenAICompatibleDriftChatClient } from "../src/llm.ts";
import { createDriftContext } from "../src/runtime.ts";
import { DriftStateStore } from "../src/state.ts";
import { buildDriftToolRegistry, type DriftTool, DriftToolRegistry } from "../src/tools.ts";

const tempDirs: string[] = [];
const stores: DriftStateStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTool(name: string, description: string): DriftTool {
	return {
		name,
		description,
		parameters: { type: "object" },
		execute: async () => "ok",
	};
}

describe("DriftToolRegistry", () => {
	it("keeps built-ins ahead of duplicates and supports search", () => {
		const builtIn = makeTool("read_file", "读取工作区文件");
		const registry = new DriftToolRegistry([builtIn]);
		expect(registry.register(makeTool("read_file", "替代实现"))).toBe(false);
		expect(registry.register(makeTool("workspace_note", "写入 workspace 笔记"))).toBe(true);
		expect(registry.get("read_file")).toBe(builtIn);
		expect(registry.search("workspace").map((tool) => tool.name)).toEqual(["workspace_note"]);
	});

	it("resolves workspace paths separately from the drift directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "drift-registry-"));
		const driftDir = join(root, "drift");
		const workspaceDir = join(root, "workspace");
		mkdirSync(driftDir, { recursive: true });
		mkdirSync(workspaceDir, { recursive: true });
		const store = new DriftStateStore({ driftDir });
		stores.push(store);
		const ctx = createDriftContext("local", new Date());
		const tools = buildDriftToolRegistry(ctx, { driftDir, workspaceDir, store });
		const write = tools.find((tool) => tool.name === "write_file");
		const read = tools.find((tool) => tool.name === "read_file");
		expect(write).toBeDefined();
		expect(read).toBeDefined();

		const writeResult = JSON.parse(
			await write!.execute({ path: "workspace/notes/today.md", content: "hello" }, ctx),
		) as { ok?: boolean };
		expect(writeResult.ok).toBe(true);
		expect(() => writeFileSync(join(workspaceDir, "notes", "today.md"), "hello")).not.toThrow();
		expect(await read!.execute({ path: "workspace/notes/today.md" }, ctx)).toBe("hello");
	});

	it("uses host-owned session access for fetch and search tools", async () => {
		const root = mkdtempSync(join(tmpdir(), "drift-session-access-"));
		const driftDir = join(root, "drift");
		mkdirSync(driftDir, { recursive: true });
		const store = new DriftStateStore({ driftDir });
		stores.push(store);
		tempDirs.push(root);
		const ctx = createDriftContext("session-a", new Date("2026-05-01T00:00:00.000Z"));
		const tools = buildDriftToolRegistry(ctx, {
			driftDir,
			workspaceDir: root,
			store,
			sessionAccess: {
				fetchMessages: async ({ sessionKey, sourceRef }) => [
					{ role: "user", content: `${sessionKey}:${sourceRef ?? "none"}` },
				],
				searchMessages: async ({ query }) => [{ role: "assistant", content: `found:${query}` }],
			},
		});
		const fetch = tools.find((tool) => tool.name === "fetch_messages");
		const search = tools.find((tool) => tool.name === "search_messages");

		expect(fetch).toBeDefined();
		expect(search).toBeDefined();
		expect(JSON.parse(await fetch!.execute({ context: 1, source_ref: "turn-1" }, ctx))).toEqual({
			messages: [{ role: "user", content: "session-a:turn-1" }],
		});
		expect(JSON.parse(await search!.execute({ query: "Drift", limit: 1 }, ctx))).toEqual({
			messages: [{ role: "assistant", content: "found:Drift" }],
		});
	});
});

function responseForToolCall(): Response {
	return new Response(
		JSON.stringify({
			choices: [
				{
					message: {
						tool_calls: [{ id: "call-1", function: { name: "select_skill", arguments: '{"skill_name":"x"}' } }],
					},
				},
			],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("Drift LLM adapter", () => {
	it("normalizes OpenAI tool calls and retries transient HTTP errors", async () => {
		let attempts = 0;
		const fetchFn: typeof fetch = async () => {
			attempts += 1;
			return attempts === 1 ? new Response("busy", { status: 503 }) : responseForToolCall();
		};
		const client = new OpenAICompatibleDriftChatClient({
			model: "test-model",
			baseUrl: "https://example.test/v1/",
			apiKey: "secret",
			maxRetries: 1,
			retryDelayMs: 0,
			fetchFn,
		});
		const result = await client.complete({
			messages: [{ role: "system", content: "x" }],
			schemas: [],
			toolChoice: "required",
			maxTokens: 10,
		});
		expect(attempts).toBe(2);
		expect(result?.toolCalls[0]).toEqual({
			id: "call-1",
			name: "select_skill",
			arguments: '{"skill_name":"x"}',
		});
	});

	it("supports a host-provided client and preserves invalid argument fallback", async () => {
		const seen: string[] = [];
		const client: DriftChatClient = {
			complete: async (request) => {
				seen.push(String(request.messages.at(-1)?.role ?? ""));
				return { toolCalls: [{ id: "call-2", name: "finish_drift", arguments: "not-json" }] };
			},
		};
		const llm = buildDriftLlmFn(
			{ model: "test-model", baseUrl: "https://example.test", apiKey: undefined },
			{ client },
		);
		const call = await llm([{ role: "system", content: "context" }], [], "required");
		expect(seen).toEqual(["user"]);
		expect(call).toEqual({ id: "call-2", name: "finish_drift", input: {} });
	});

	it("reports request failures and lets the runtime persist them as paused", async () => {
		const errors: Array<{ model: string; durationMs: number }> = [];
		const llm = buildDriftLlmFn(
			{ model: "test-model", baseUrl: "https://example.test", apiKey: undefined },
			{
				client: {
					complete: async () => {
						throw new Error("provider unavailable");
					},
				},
				observer: {
					onError: ({ model, durationMs }) => {
						errors.push({ model, durationMs });
					},
				},
			},
		);

		await expect(llm([], [], "required")).rejects.toThrow("provider unavailable");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.model).toBe("test-model");
		expect(errors[0]?.durationMs).toBeGreaterThanOrEqual(0);
	});
});
