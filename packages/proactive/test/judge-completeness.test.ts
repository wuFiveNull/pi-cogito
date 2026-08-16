import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionResponse } from "@cogito/ai/chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentTick } from "../src/stages/judge-agent-tick.ts";
import { ProactiveStore } from "../src/store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllGlobals();
});

function makeStore(): ProactiveStore {
	const agentDir = mkdtempSync(join(tmpdir(), "proactive-complete-"));
	tempDirs.push(agentDir);
	return new ProactiveStore(join(agentDir, "proactive.sqlite"));
}

function makeItems(store: ProactiveStore): void {
	for (const [title, hash] of [
		["deepseek 发布新模型", "h1"],
		["明星八卦", "h2"],
	] as const) {
		store.insertItem({
			scope: "",
			source: "dailyhot",
			sub_source: "github",
			title,
			url: `https://example.com/${hash}`,
			summary: "摘要",
			title_hash: hash,
			interest_score: null,
			recommendation: null,
			verdict: null,
			verdict_reason: null,
			fetched_at: Date.now(),
		});
	}
}

interface ScriptStep {
	toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
	content?: string;
}

/**
 * Fake OpenAI-compatible endpoint with message capture. The script repeats
 * its last entry for extra calls (stubborn LLM behaviour), matching
 * tick-resolve.test.ts.
 */
function mockLlm(script: ScriptStep[]): { seenUserMessages: () => string[] } {
	let chatCall = 0;
	const seenUserMessages: string[] = [];
	const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
		if (String(url).includes("/chat/completions")) {
			// 脚本索引只随 chat 调用前进;证据抓取(HTML)不消耗脚本。
			const step = script[Math.min(chatCall, script.length - 1)]!;
			chatCall++;
			const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string | null }> };
			for (const message of body.messages) {
				if (message.role === "user" && message.content) seenUserMessages.push(message.content);
			}
			const toolCalls = step.toolCalls?.map((tool, index) => ({
				id: `call-${chatCall}-${index}`,
				type: "function",
				function: { name: tool.name, arguments: JSON.stringify(tool.args) },
			}));
			return {
				ok: true,
				json: async () => ({
					choices: [
						{
							message: {
								content: step.content ?? null,
								...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
							},
						},
					],
				}),
			};
		}
		return { ok: true, text: async () => "<html><body><p>正文内容</p></body></html>" };
	});
	vi.stubGlobal("fetch", fetchMock);
	return { seenUserMessages: () => [...seenUserMessages] };
}

function runTick(store: ProactiveStore, maxSteps: number) {
	return runAgentTick({
		items: store.listNew(),
		rulesPanel: "",
		preferenceBlock: "",
		model: "m",
		baseUrl: "https://api.example.com/v1",
		apiKey: "k",
		store,
		config: { maxSteps },
	});
}

describe("judge completeness loops (akashic judge.py port)", () => {
	it("re-prompts to classify candidates before accepting a skip", async () => {
		const store = makeStore();
		makeItems(store);
		// 1: skip with both candidates unclassified → 完整性提示
		// 2: mark 2 不感兴趣 + skip → 现在 2 已分类,1 已抓证据? 不,1 未抓 → 仍不完整
		const { seenUserMessages } = mockLlm([
			{
				toolCalls: [{ name: "finish_judgment", args: { action: "skip", item_ids: [], skip_reason: "no_content" } }],
			},
			{
				toolCalls: [
					{ name: "mark_not_interesting", args: { item_ids: [2], reason: "八卦" } },
					{ name: "fetch_evidence", args: { item_id: 1 } },
				],
			},
			{
				toolCalls: [{ name: "finish_judgment", args: { action: "skip", item_ids: [], skip_reason: "no_content" } }],
			},
		]);

		const ctx = await runTick(store, 8);

		expect(ctx.terminalAction).toBe("skip");
		expect(ctx.discardedItemIds).toEqual([2]);
		expect(ctx.evidence.map((e) => e.itemId)).toEqual([1]);
		// 第一轮回环注入了完整性提示,并列出未分类条目。
		const completenessPrompt = seenUserMessages()[1] ?? "";
		expect(completenessPrompt).toContain("尚未完成分类");
		expect(completenessPrompt).toContain("id=1");
		expect(completenessPrompt).toContain("id=2");
		// 第三轮 user 消息不再带完整性提示(已全部分类)。
		expect(seenUserMessages()[2]).not.toContain("尚未完成分类");
	});

	it("sends only classified candidates after the completeness loop", async () => {
		const store = makeStore();
		makeItems(store);
		mockLlm([
			{
				toolCalls: [{ name: "finish_judgment", args: { action: "skip", item_ids: [], skip_reason: "no_content" } }],
			},
			{
				toolCalls: [
					{ name: "fetch_evidence", args: { item_id: 1 } },
					{ name: "mark_not_interesting", args: { item_ids: [2] } },
				],
			},
			{ toolCalls: [{ name: "finish_judgment", args: { action: "send", item_ids: [1], skip_reason: "" } }] },
		]);

		const ctx = await runTick(store, 8);

		expect(ctx.terminalAction).toBe("send");
		expect(ctx.interestingItemIds).toEqual([1]);
		expect(ctx.discardedItemIds).toEqual([2]);
	});

	it("bounds the completeness loop at 5 rounds, then accepts the skip", async () => {
		const store = makeStore();
		makeItems(store);
		// LLM 一直 skip 且不分类:5 轮完整性回环后第 6 次 skip 被接受。
		mockLlm([
			{ toolCalls: [{ name: "finish_judgment", args: { action: "skip", item_ids: [], skip_reason: "other" } }] },
		]);

		const ctx = await runTick(store, 8);

		expect(ctx.terminalAction).toBe("skip");
		expect(ctx.skipReason).toBe("other");
		expect(ctx.stepsTaken).toBe(6);
		expect(ctx.discardedItemIds).toEqual([]);
	});

	it("re-prompts to fetch evidence for send items, then sends them", async () => {
		const store = makeStore();
		makeItems(store);
		const { seenUserMessages } = mockLlm([
			{ toolCalls: [{ name: "finish_judgment", args: { action: "send", item_ids: [2], skip_reason: "" } }] },
			{ toolCalls: [{ name: "fetch_evidence", args: { item_id: 2 } }] },
			{ toolCalls: [{ name: "finish_judgment", args: { action: "send", item_ids: [2], skip_reason: "" } }] },
		]);

		const ctx = await runTick(store, 8);

		expect(ctx.terminalAction).toBe("send");
		expect(ctx.interestingItemIds).toEqual([2]);
		expect(ctx.evidence.map((e) => e.itemId)).toEqual([2]);
		const reflectionPrompt = seenUserMessages()[1] ?? "";
		expect(reflectionPrompt).toContain("尚未抓取证据");
		expect(reflectionPrompt).toContain("2");
	});

	it("forces a finish when evidence was collected but no terminal action was given", async () => {
		const store = makeStore();
		makeItems(store);
		const { seenUserMessages } = mockLlm([
			{ toolCalls: [{ name: "fetch_evidence", args: { item_id: 1 } }] },
			{ content: "我再想想,不调用工具" },
			{ toolCalls: [{ name: "finish_judgment", args: { action: "send", item_ids: [1], skip_reason: "" } }] },
		]);

		const ctx = await runTick(store, 8);

		expect(ctx.terminalAction).toBe("send");
		expect(ctx.interestingItemIds).toEqual([1]);
		const forcePrompt = seenUserMessages()[2] ?? "";
		expect(forcePrompt).toContain("尚未调用 finish_judgment");
	});

	it("marks discarded candidates as not interesting even when never fetched", async () => {
		const store = makeStore();
		makeItems(store);
		mockLlm([
			{
				toolCalls: [
					{ name: "mark_not_interesting", args: { item_ids: [1, 2], reason: "都不推" } },
					{ name: "finish_judgment", args: { action: "skip", item_ids: [], skip_reason: "other" } },
				],
			},
		]);

		const ctx = await runTick(store, 8);

		expect(ctx.terminalAction).toBe("skip");
		expect(ctx.discardedItemIds.sort()).toEqual([1, 2]);
		expect(ctx.interestingItemIds).toEqual([]);
	});

	it("fetch_evidence reads the prefetched cache without a network fetch (akashic content_store)", async () => {
		const store = makeStore();
		makeItems(store);
		// prepare 阶段已缓存正文(akashic DataGateway content_store)。
		store.setItemEvidence(1, "预取正文片段,足够长以命中缓存。".repeat(10));
		let htmlFetches = 0;
		let chatCall = 0;
		const script = [
			{
				tool_calls: [
					{
						id: "c1",
						type: "function",
						function: { name: "fetch_evidence", arguments: JSON.stringify({ item_id: 1 }) },
					},
				],
			},
			{
				tool_calls: [
					{
						id: "c2",
						type: "function",
						function: {
							name: "finish_judgment",
							arguments: JSON.stringify({ action: "send", item_ids: [1] }),
						},
					},
				],
			},
		];
		const fetchMock = vi.fn().mockImplementation(async (url: string, _init?: RequestInit) => {
			if (String(url).includes("/chat/completions")) {
				const step = script[Math.min(chatCall, script.length - 1)]!;
				chatCall++;
				return {
					ok: true,
					json: async () => ({
						choices: [
							{ message: { content: null, ...(step.tool_calls ? { tool_calls: step.tool_calls } : {}) } },
						],
					}),
				};
			}
			htmlFetches++;
			return { ok: true, text: async () => "<html><body>正文</body></html>" };
		});
		vi.stubGlobal("fetch", fetchMock);

		const ctx = await runTick(store, 8);

		expect(htmlFetches).toBe(0);
		expect(ctx.evidence).toHaveLength(1);
		expect(ctx.evidence[0]!.snippet).toContain("预取正文片段");
	});
});

describe("AgentTickJudgeStrategy with an injected host client", () => {
	it("runs the full tick through the injected client without a config apiKey", async () => {
		const store = makeStore();
		makeItems(store);
		// 注入 client:首轮 finish_judgment send(带证据抓取)。
		const complete = vi.fn(async (): Promise<ChatCompletionResponse> => {
			const toolCalls = [
				{
					id: "c1",
					name: "fetch_evidence",
					arguments: { item_id: 1 },
				},
				{
					id: "c2",
					name: "finish_judgment",
					arguments: { action: "send", item_ids: [1], skip_reason: "" },
				},
			];
			return {
				content: null,
				toolCalls,
				message: { role: "assistant" } as never,
			} as unknown as ChatCompletionResponse;
		});
		const ctx = await runAgentTick({
			items: store.listNew(),
			rulesPanel: "",
			preferenceBlock: "",
			model: "unused",
			baseUrl: "unused",
			apiKey: undefined,
			client: { complete },
			store,
			config: {
				maxSteps: 8,
				// 证据抓取走注入的 fetch,避免真实网络请求(example.com)造成 flaky。
				fetchFn: vi.fn(async () => ({
					ok: true,
					status: 200,
					text: async () => "<html><body>deepseek 发布新模型的完整正文。</body></html>",
				})) as unknown as typeof fetch,
			},
		});
		expect(complete).toHaveBeenCalled();
		expect(ctx.terminalAction).toBe("send");
		expect(ctx.evidence.length).toBeGreaterThan(0);
	});
});
