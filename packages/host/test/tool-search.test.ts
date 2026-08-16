import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@cogito/ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type ToolSearchResult = {
	matched: Array<{ name: string; description: string; whyMatched: string[]; source: string }>;
	added?: string[];
	tip?: string;
};

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const text = result.content.find((part) => part.type === "text" && part.text !== undefined)?.text ?? "";
	return text;
}

describe("tool_search integration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-tool-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function runToolSearch(
		session: Awaited<ReturnType<typeof createAgentSession>>["session"],
		query: string,
		limit?: number,
	): Promise<{ result: ToolSearchResult; raw: string; addedToolNames: string[] | undefined }> {
		const tool = session.agent.state.tools.find((candidate) => candidate.name === "tool_search")!;
		expect(tool).toBeDefined();
		const outcome = await tool.execute(
			"tool-search-call",
			{ query, ...(limit !== undefined ? { limit } : {}) },
			undefined,
			undefined,
		);
		return {
			result: JSON.parse(textOf(outcome)) as ToolSearchResult,
			raw: textOf(outcome),
			addedToolNames: outcome.addedToolNames,
		};
	}

	it("registers tool_search as an active builtin-sourced tool", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		const searchTool = session.getAllTools().find((tool) => tool.name === "tool_search");
		expect(searchTool?.sourceInfo).toMatchObject({ path: "<tool-search>", source: "builtin" });
		expect(session.getActiveToolNames()).toContain("tool_search");

		session.dispose();
	});

	it("searches builtin tools and returns whyMatched", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		const { result } = await runToolSearch(session, "file");
		const names = result.matched.map((match) => match.name);
		expect(names).toContain("read");
		expect(names).toContain("write");
		expect(names).toContain("edit");
		for (const match of result.matched) {
			expect(match.description.length).toBeGreaterThan(0);
			expect(match.whyMatched.length).toBeGreaterThan(0);
			expect(match.source).toBe("builtin");
		}

		session.dispose();
	});

	it("activates inactive matched tools so they become callable", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		// grep/find/ls are registered but not in the default active set.
		expect(session.getActiveToolNames()).not.toContain("grep");

		const { result, addedToolNames } = await runToolSearch(session, "grep");
		expect(result.matched.map((match) => match.name)).toContain("grep");
		expect(result.added).toContain("grep");
		expect(addedToolNames).toContain("grep");
		expect(session.getActiveToolNames()).toContain("grep");

		session.dispose();
	});

	it("excludes tool_search itself from its own results", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		const { result } = await runToolSearch(session, "tool_search");
		expect(result.matched.map((match) => match.name)).not.toContain("tool_search");

		session.dispose();
	});

	it("finds dynamically registered extension tools without a restart", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "custom_recall",
							label: "Custom Recall",
							description: "检索自定义记忆库中的相关内容。",
							searchHint: "记忆 回忆 自定义检索",
							promptSnippet: "Recall from the custom memory store",
							parameters: Type.Object({
								query: Type.String({ description: "检索关键词" }),
							}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		// Tool registered after initial load; not yet in the registry or catalog.
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("custom_recall");

		await session.bindExtensions({});
		expect(session.getAllTools().map((tool) => tool.name)).toContain("custom_recall");

		// A Chinese query finds the dynamically registered tool via its searchHint.
		const { result } = await runToolSearch(session, "记忆");
		const match = result.matched.find((candidate) => candidate.name === "custom_recall");
		expect(match).toBeDefined();
		expect(match?.whyMatched).toContain("提示:记忆");
		expect(match?.source).toBe("chat");

		session.dispose();
	});

	it("returns an empty list with a tip when nothing matches", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		const { result } = await runToolSearch(session, "zzzzqqqq");
		expect(result.matched).toEqual([]);
		expect(result.tip).toContain("没有找到匹配工具");

		session.dispose();
	});
});
