import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallPreferences } from "@cogito/gate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { htmlToText, runAgentTick } from "../src/stages/judge-agent-tick.ts";
import { NO_CONTENT_TOKEN, resolveMessage } from "../src/stages/resolve-evidence.ts";
import { ProactiveStore } from "../src/store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllGlobals();
});

function makeStore(): ProactiveStore {
	const agentDir = mkdtempSync(join(tmpdir(), "proactive-tick-"));
	tempDirs.push(agentDir);
	return new ProactiveStore(join(agentDir, "proactive.sqlite"));
}

function makeItems(store: ProactiveStore): void {
	store.insertItem({
		scope: "",
		source: "dailyhot",
		sub_source: "github",
		title: "deepseek 发布新模型",
		url: "https://example.com/1",
		summary: "新模型支持更长上下文",
		title_hash: "h1",
		interest_score: null,
		recommendation: null,
		verdict: null,
		verdict_reason: null,
		fetched_at: Date.now(),
	});
	store.insertItem({
		scope: "",
		source: "dailyhot",
		sub_source: "weibo",
		title: "明星八卦",
		url: null,
		summary: "某明星日常",
		title_hash: "h2",
		interest_score: null,
		recommendation: null,
		verdict: null,
		verdict_reason: null,
		fetched_at: Date.now(),
	});
}

/** Fake OpenAI-compatible endpoint driven by a scripted tool-call sequence. */
function mockLlm(
	script: Array<{ toolCalls?: Array<{ name: string; args: Record<string, unknown> }>; content?: string }>,
) {
	let call = 0;
	const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
		const step = script[Math.min(call, script.length - 1)]!;
		call++;
		if (String(url).includes("/chat/completions")) {
			const _body = JSON.parse(String(init?.body)) as {
				tools?: unknown[];
				messages: Array<{ role: string; content?: string | null; tool_calls?: unknown[] }>;
			};
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
		// Evidence fetch: return a plain HTML page.
		return {
			ok: true,
			text: async () => "<html><body><h1>新模型详情</h1><p>deepseek 发布了 v4 模型,上下文 256k。</p></body></html>",
		};
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, nextCall: () => call };
}

describe("agent tick (akashic AgentTick + Judge)", () => {
	it("collects evidence and finishes with send", async () => {
		const store = makeStore();
		makeItems(store);
		const script = [
			{ toolCalls: [{ name: "fetch_evidence", args: { item_id: 1 } }] },
			{
				toolCalls: [
					{
						name: "finish_judgment",
						args: { action: "send", item_ids: [1], skip_reason: "" },
					},
				],
			},
		];
		mockLlm(script);

		const ctx = await runAgentTick({
			items: store.listNew(),
			rulesPanel: "禁止推送明星八卦",
			preferenceBlock: "用户关注 AI",
			model: "test-model",
			baseUrl: "https://api.example.com/v1",
			apiKey: "sk-test",
			store,
			config: { maxSteps: 4 },
		});

		expect(ctx.terminalAction).toBe("send");
		expect(ctx.interestingItemIds).toEqual([1]);
		expect(ctx.evidence.length).toBe(1);
		expect(ctx.evidence[0]?.snippet).toContain("256k");
		expect(ctx.stepsTaken).toBe(2);
		// Evidence persisted on the item for the resolve stage.
		expect(store.getItem(1)?.evidence).toContain("256k");
	});

	it("defaults to skip on budget exhaustion without finish", async () => {
		const store = makeStore();
		makeItems(store);
		// LLM never calls finish: 4 fetch_evidence calls then budget exhausted.
		const script = [
			{ toolCalls: [{ name: "fetch_evidence", args: { item_id: 1 } }] },
			{ toolCalls: [{ name: "fetch_evidence", args: { item_id: 2 } }] },
			{ toolCalls: [{ name: "fetch_evidence", args: { item_id: 1 } }] },
			{ toolCalls: [{ name: "fetch_evidence", args: { item_id: 2 } }] },
		];
		mockLlm(script);

		const ctx = await runAgentTick({
			items: store.listNew(),
			rulesPanel: "",
			preferenceBlock: "",
			model: "m",
			baseUrl: "https://api.example.com/v1",
			apiKey: "k",
			store,
			config: { maxSteps: 3 },
		});

		expect(ctx.terminalAction).toBe("skip");
		expect(ctx.skipReason).toBe("step_budget_exhausted");
		expect(ctx.interestingItemIds).toEqual([]);
	});

	it("never sends unclassified candidates", async () => {
		const store = makeStore();
		makeItems(store);
		// finish says send [2] but no evidence was fetched for 2. The send
		// reflection re-prompts up to 3 rounds; after that the finish is
		// accepted and the evidence-less item is still filtered out.
		mockLlm([
			{
				toolCalls: [
					{
						name: "finish_judgment",
						args: { action: "send", item_ids: [2], skip_reason: "" },
					},
				],
			},
		]);

		const ctx = await runAgentTick({
			items: store.listNew(),
			rulesPanel: "",
			preferenceBlock: "",
			model: "m",
			baseUrl: "https://api.example.com/v1",
			apiKey: "k",
			store,
			config: { maxSteps: 4 },
		});

		expect(ctx.terminalAction).toBe("send");
		expect(ctx.interestingItemIds).toEqual([]); // 2 has no evidence
	});

	it("returns skip when the LLM endpoint is unavailable", async () => {
		const store = makeStore();
		makeItems(store);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }));

		const ctx = await runAgentTick({
			items: store.listNew(),
			rulesPanel: "",
			preferenceBlock: "",
			model: "m",
			baseUrl: "https://api.example.com/v1",
			apiKey: "k",
			store,
			config: { maxSteps: 3 },
		});

		expect(ctx.terminalAction).toBe("skip");
		expect(ctx.skipReason).toBe("tick_llm_unavailable");
	});

	it("moves explicitly rejected candidates out of the new queue", async () => {
		const store = makeStore();
		makeItems(store);
		mockLlm([
			{
				toolCalls: [
					{
						name: "mark_not_interesting",
						args: { item_ids: [1], reason: "与用户兴趣无关" },
					},
				],
			},
			{
				toolCalls: [
					{
						name: "mark_not_interesting",
						args: { item_ids: [2], reason: "低质量" },
					},
				],
			},
			{
				toolCalls: [{ name: "finish_judgment", args: { action: "skip", item_ids: [], skip_reason: "无合适内容" } }],
			},
		]);

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

		expect(ctx.terminalAction).toBe("skip");
		expect(store.getItem(1)?.status).toBe("dismissed");
		expect(store.getItem(2)?.status).toBe("dismissed");
		expect(store.listNew()).toEqual([]);
	});
});

describe("resolve (akashic Evidence-First compose)", () => {
	it("writes a message from evidence", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					choices: [{ message: { content: "deepseek 发布了 v4 模型,上下文 256k。 https://example.com/1" } }],
				}),
			}),
		);
		const message = await resolveMessage({
			evidence: [
				{
					id: "ev1",
					itemId: 1,
					source: "github",
					title: "deepseek 发布新模型",
					snippet: "deepseek 发布了 v4 模型,上下文 256k。",
					url: "https://example.com/1",
				},
			],
			preferenceBlock: "",
			rulesPanel: "",
			model: "m",
			baseUrl: "https://api.example.com/v1",
			apiKey: "k",
			nowStr: "2026-05-01T00:00:00Z",
		});
		expect(message).toContain("256k");
	});

	it("returns null on <no_content/> (insufficient evidence / blocked by rules)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ choices: [{ message: { content: NO_CONTENT_TOKEN } }] }),
			}),
		);
		const message = await resolveMessage({
			evidence: [{ id: "ev1", itemId: 1, source: "github", title: "t", snippet: "s", url: "" }],
			preferenceBlock: "- [preference] 禁止推送该主题",
			rulesPanel: "",
			model: "m",
			baseUrl: "https://api.example.com/v1",
			apiKey: "k",
			nowStr: "2026-05-01T00:00:00Z",
		});
		expect(message).toBeNull();
	});
});

describe("htmlToText", () => {
	it("strips tags and normalizes whitespace", () => {
		expect(htmlToText("<html><body><p>a  b</p><script>x()</script>c</body></html>")).toBe("a b c");
	});
});

describe("memory recall (akashic judge preference block)", () => {
	it("reads active preference/procedure rules from the memory engine db", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "proactive-mem-"));
		tempDirs.push(agentDir);
		const memoryDb = join(agentDir, "memory.sqlite");
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(memoryDb);
		db.exec(`
CREATE TABLE memory_items (
  id TEXT PRIMARY KEY, memory_type TEXT NOT NULL, summary TEXT NOT NULL,
  content_hash TEXT NOT NULL, reinforcement INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active', updated_at TEXT NOT NULL
);`);
		db.prepare(
			"INSERT INTO memory_items (id, memory_type, summary, content_hash, status, updated_at) VALUES ('m1', 'preference', '用户不喜欢明星八卦', 'c1', 'active', '2026-01-01')",
		).run();
		db.prepare(
			"INSERT INTO memory_items (id, memory_type, summary, content_hash, status, updated_at) VALUES ('m2', 'preference', '用户关注 AI 与开源', 'c2', 'active', '2026-01-01')",
		).run();
		db.prepare(
			"INSERT INTO memory_items (id, memory_type, summary, content_hash, status, updated_at) VALUES ('m3', 'procedure', '查余额先调工具', 'c3', 'superseded', '2026-01-01')",
		).run();
		db.close();

		const all = recallPreferences(memoryDb);
		expect(all.length).toBe(2); // superseded excluded

		const matched = recallPreferences(memoryDb, "AI 开源");
		expect(matched.map((m) => m.id)).toEqual(["m2"]);
	});
});
