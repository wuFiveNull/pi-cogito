import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentTick, type TickToolDeps } from "../src/stages/judge-agent-tick.ts";
import { type ProactiveItemKind, ProactiveStore } from "../src/store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllGlobals();
});

function makeStore(): ProactiveStore {
	const agentDir = mkdtempSync(join(tmpdir(), "proactive-judge-tools-"));
	tempDirs.push(agentDir);
	return new ProactiveStore(join(agentDir, "proactive.sqlite"));
}

function insertItem(store: ProactiveStore, title: string, kind: ProactiveItemKind = "content", summary?: string): void {
	store.insertItem({
		scope: "",
		source: "dailyhot",
		sub_source: "github",
		title,
		url: `https://example.com/${encodeURIComponent(title)}`,
		summary: summary ?? `摘要 ${title}`,
		title_hash: `h-${title}-${kind}`,
		interest_score: null,
		recommendation: null,
		verdict: null,
		verdict_reason: null,
		kind,
		fetched_at: Date.now(),
	});
}

interface ScriptStep {
	toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
	content?: string;
}

/** Fake OpenAI-compatible endpoint driven by a scripted tool-call sequence. */
function mockLlm(script: ScriptStep[]) {
	let call = 0;
	const fetchMock = vi.fn().mockImplementation(async (url: string, _init?: RequestInit) => {
		const step = script[Math.min(call, script.length - 1)]!;
		call++;
		if (String(url).includes("/chat/completions")) {
			const toolCalls = step.toolCalls?.map((tool, index) => ({
				id: `call-${call}-${index}`,
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
		return { ok: true, text: async () => `<html><body><p>正文 ${step.toolCalls?.[0]?.name}</p></body></html>` };
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function runTick(
	store: ProactiveStore,
	script: ScriptStep[],
	options: {
		toolDeps?: TickToolDeps;
		chatLevity?: boolean;
		maxSteps?: number;
		contextAsFallbackOpen?: boolean;
		recordToolStep?: (step: Record<string, unknown>) => void;
	} = {},
) {
	mockLlm(script);
	return runAgentTick({
		items: store.listNew(),
		rulesPanel: "禁止推送明星八卦",
		preferenceBlock: "用户关注 AI",
		contextAsFallbackOpen: options.contextAsFallbackOpen,
		chatLevity: options.chatLevity,
		model: "test-model",
		baseUrl: "https://api.example.com/v1",
		apiKey: "sk-test",
		store,
		config: { maxSteps: options.maxSteps ?? 20 },
		toolDeps: options.toolDeps,
		recordToolStep: options.recordToolStep as never,
	});
}

describe("judge tools (akashic proactive_flow tools.py 移植)", () => {
	it("mark_interesting persists the verdict and avoids the completeness loop", async () => {
		const store = makeStore();
		insertItem(store, "deepseek 新模型");
		insertItem(store, "明星八卦");
		const ctx = await runTick(store, [
			{ toolCalls: [{ name: "mark_interesting", args: { item_ids: [1], reason: "用户关注 AI" } }] },
			{ toolCalls: [{ name: "mark_not_interesting", args: { item_ids: [2], reason: "规则过滤" } }] },
			{ toolCalls: [{ name: "finish_judgment", args: { action: "send", item_ids: [1], skip_reason: "" } }] },
		]);
		// 显式分类后 completeness 不再回环;send 仍需证据,因此缺证据回环后 send 被接受。
		expect(ctx.terminalAction).toBe("send");
		expect(store.getItem(1)?.verdict).toBe("interesting");
		expect(store.getItem(1)?.verdict_reason).toBe("用户关注 AI");
		expect(store.getItem(2)?.verdict).toBe("not_interesting");
		expect(store.getItem(2)?.status).toBe("dismissed");
	});

	it("alert items take the fast path: send without evidence synthesizes alert evidence", async () => {
		const store = makeStore();
		insertItem(store, "服务故障告警", "alert", "线上服务不可用,已自动重启");
		insertItem(store, "普通新闻", "content");
		const ctx = await runTick(store, [
			{ toolCalls: [{ name: "finish_judgment", args: { action: "send", item_ids: [1], skip_reason: "" } }] },
		]);
		expect(ctx.terminalAction).toBe("send");
		expect(ctx.citedItemIds).toEqual([1]);
		// alert 自动获得证据,无需 fetch_evidence 回环。
		expect(ctx.evidence.some((evidence) => evidence.itemId === 1)).toBe(true);
	});

	it("completeness loop only applies to content candidates, not alerts", async () => {
		const store = makeStore();
		insertItem(store, "告警 A", "alert");
		insertItem(store, "未分类内容", "content");
		// 第一轮 skip 因 content 未分类被回环;alert 不参与 completeness。
		await runTick(
			store,
			[
				{
					toolCalls: [
						{ name: "finish_judgment", args: { action: "skip", item_ids: [], skip_reason: "no_content" } },
					],
				},
				{ toolCalls: [{ name: "mark_not_interesting", args: { item_ids: [2], reason: "低质量" } }] },
				{
					toolCalls: [
						{ name: "finish_judgment", args: { action: "skip", item_ids: [], skip_reason: "no_content" } },
					],
				},
			],
			{ maxSteps: 6 },
		);
		// 回环要求补分类 → mark_not_interesting 执行过;alert 从未被要求分类。
		expect(store.getItem(2)?.verdict).toBe("not_interesting");
		expect(store.getItem(1)?.verdict).toBeNull();

		// 纯 alert + skip:不触发 completeness,直接收尾。
		const store2 = makeStore();
		insertItem(store2, "告警 B", "alert");
		const ctx2 = await runTick(
			store2,
			[
				{
					toolCalls: [
						{ name: "finish_judgment", args: { action: "skip", item_ids: [], skip_reason: "no_content" } },
					],
				},
			],
			{ maxSteps: 4 },
		);
		expect(ctx2.terminalAction).toBe("skip");
	});

	it("get_recent_chat / recall_memory / web_fetch / web_search register only with providers", async () => {
		const store = makeStore();
		insertItem(store, "新闻 X", "content");
		const recentChat = vi.fn().mockResolvedValue("user: 最近在聊 AI\nassistant: 是的");
		const recall = vi.fn().mockResolvedValue("[preference] 关注开源项目");
		const webFetch = vi.fn().mockResolvedValue({ text: "来源页正文", url: "https://example.com/1" });
		const webSearch = vi.fn().mockResolvedValue([{ title: "R1", url: "https://example.com/r1", snippet: "s1" }]);
		const toolDeps: TickToolDeps = {
			recentChatFn: recentChat,
			recallMemoryFn: recall,
			webFetchFn: webFetch,
			webSearchFn: webSearch,
		};
		const seen: string[] = [];
		await runTick(
			store,
			[
				{
					toolCalls: [
						{ name: "get_recent_chat", args: {} },
						{ name: "recall_memory", args: { query: "AI github" } },
						{ name: "web_fetch", args: { url: "https://example.com/1" } },
						{ name: "web_search", args: { query: "deepseek v4" } },
					],
				},
				{ toolCalls: [{ name: "mark_not_interesting", args: { item_ids: [1], reason: "已核实无价值" } }] },
				{
					toolCalls: [
						{ name: "finish_judgment", args: { action: "skip", item_ids: [], skip_reason: "no_content" } },
					],
				},
			],
			{ toolDeps, recordToolStep: (step) => seen.push(String(step.toolName)) },
		);
		expect(recentChat).toHaveBeenCalledOnce();
		expect(recall).toHaveBeenCalledWith("AI github");
		expect(webFetch).toHaveBeenCalledWith("https://example.com/1", expect.any(Number), expect.any(Number));
		expect(webSearch).toHaveBeenCalledWith("deepseek v4", expect.any(Number), expect.any(Number));
		expect(seen).toContain("get_recent_chat");
		expect(seen).toContain("recall_memory");
		expect(seen).toContain("web_fetch");
		expect(seen).toContain("web_search");
	});

	it("tools are absent when no providers are wired", async () => {
		const store = makeStore();
		insertItem(store, "新闻 Y", "content");
		const seen: string[] = [];
		await runTick(
			store,
			[
				{ toolCalls: [{ name: "get_recent_chat", args: {} }] },
				{
					toolCalls: [
						{ name: "finish_judgment", args: { action: "skip", item_ids: [], skip_reason: "no_content" } },
					],
				},
			],
			{ recordToolStep: (step) => seen.push(String(step.toolName)) },
		);
		// 无 provider 时工具未注册:LLM 调用了未知工具,收到未知提示但仍可 finish。
		expect(seen).not.toContain("get_recent_chat");
	});

	it("message_push stages a draft without terminating the loop; draft survives to the verdict", async () => {
		const store = makeStore();
		insertItem(store, "deepseek 发布 v4", "content");
		const ctx = await runTick(store, [
			{ toolCalls: [{ name: "fetch_evidence", args: { item_id: 1 } }] },
			{ toolCalls: [{ name: "message_push", args: { message: "deepseek 发了新模型", evidence_ids: ["ev1"] } }] },
			{ toolCalls: [{ name: "message_push", args: { message: "deepseek 发了新模型", evidence_ids: ["ev1"] } }] },
			{ toolCalls: [{ name: "finish_judgment", args: { action: "send", item_ids: [1], skip_reason: "" } }] },
		]);
		expect(ctx.terminalAction).toBe("send");
		expect(ctx.draftMessage).toBe("deepseek 发了新模型");
	});

	it("chat-levity mode restricts tools and supports context_only with a draft", async () => {
		const store = makeStore();
		const recentChat = vi.fn().mockResolvedValue("user: 最近在追一部剧\nassistant: 好看吗");
		const ctx = await runTick(
			store,
			[
				{ toolCalls: [{ name: "get_recent_chat", args: {} }] },
				{ toolCalls: [{ name: "message_push", args: { message: "那部剧看到第几集啦?" } }] },
				{
					toolCalls: [
						{ name: "finish_judgment", args: { action: "context_only", item_ids: [], skip_reason: "" } },
					],
				},
			],
			{ chatLevity: true, toolDeps: { recentChatFn: recentChat } },
		);
		expect(ctx.terminalAction).toBe("context_only");
		expect(ctx.draftMessage).toBe("那部剧看到第几集啦?");
		expect(recentChat).toHaveBeenCalledOnce();
	});

	it("cache token stats accumulate from LLM usage", async () => {
		const store = makeStore();
		insertItem(store, "新闻 Z", "content");
		let call = 0;
		const fetchMock = vi.fn().mockImplementation(async (url: string, _init?: RequestInit) => {
			call++;
			if (String(url).includes("/chat/completions")) {
				const toolCalls =
					call === 1
						? [
								{
									id: "c1",
									type: "function",
									function: {
										name: "mark_not_interesting",
										arguments: JSON.stringify({ item_ids: [1], reason: "x" }),
									},
								},
							]
						: [
								{
									id: "c2",
									type: "function",
									function: {
										name: "finish_judgment",
										arguments: JSON.stringify({ action: "skip", item_ids: [], skip_reason: "no_content" }),
									},
								},
							];
				return {
					ok: true,
					json: async () => ({
						choices: [{ message: { content: null, tool_calls: toolCalls } }],
						usage: {
							prompt_tokens: 100,
							completion_tokens: 10,
							prompt_cache_hit_tokens: 40,
							prompt_cache_miss_tokens: 60,
						},
					}),
				};
			}
			return { ok: true, text: async () => "page" };
		});
		vi.stubGlobal("fetch", fetchMock);
		const ctx = await runAgentTick({
			items: store.listNew(),
			rulesPanel: "",
			preferenceBlock: "",
			model: "m",
			baseUrl: "https://api.example.com/v1",
			apiKey: "k",
			store,
			config: { maxSteps: 5 },
		});
		expect(ctx.llmCallCount).toBe(2);
		expect(ctx.llmCacheReadTokens).toBe(80); // 2 次调用各 40
	});
});
