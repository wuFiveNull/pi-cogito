import { describe, expect, it } from "vitest";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	catalogEntryFromToolDefinition,
	catalogSourceFromSourceInfo,
	explainCatalogMatch,
	KeywordSearchBackend,
	normalizeQuery,
	scoreCatalogEntry,
	ToolCatalog,
	type ToolCatalogEntry,
} from "../src/core/tool-catalog.ts";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";

function entry(name: string, overrides: Partial<ToolCatalogEntry> = {}): ToolCatalogEntry {
	return {
		name,
		description: `Description for ${name}`,
		source: "builtin",
		...overrides,
	};
}

function builtinCatalog(): { catalog: ToolCatalog; entries: ToolCatalogEntry[] } {
	const definitions = createAllToolDefinitions("/tmp");
	const entries = Object.values(definitions).map((definition) =>
		catalogEntryFromToolDefinition(
			definition,
			createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
		),
	);
	const catalog = new ToolCatalog();
	catalog.rebuild(entries);
	return { catalog, entries };
}

/** Chat-style tool definitions mirroring the real chat memory tools (name + searchHint). */
function chatStyleMemoryEntries(): ToolCatalogEntry[] {
	return [
		entry("memorize", {
			description: "把一条事实、偏好或流程写入长期记忆。",
			searchHint: "记住 记忆 写入 保存 记住用户信息 memorize",
			source: "chat",
		}),
		entry("recall_memory", {
			description: "检索长期记忆中与查询相关的内容(用户偏好、规则、历史事实)。",
			searchHint: "记忆 回忆 检索 用户偏好 历史 记得 recall",
			source: "chat",
		}),
		entry("forget_memory", {
			description: "按记忆 id 删除(遗忘)记忆条目。",
			searchHint: "忘记 删除记忆 遗忘 纠正错误记忆 forget",
			source: "chat",
		}),
	];
}

describe("normalizeQuery", () => {
	it("lowercases and keeps the whole stripped query plus whitespace parts", () => {
		expect(normalizeQuery("  File Read ")).toEqual(new Set(["file read", "file", "read"]));
	});

	it("splits CJK / non-CJK boundaries", () => {
		expect(normalizeQuery("RSS订阅")).toEqual(new Set(["rss订阅", "rss", "订阅", "订", "阅"]));
	});

	it("produces CJK bigrams and single chars", () => {
		expect(normalizeQuery("定时提醒")).toEqual(new Set(["定时提醒", "定时", "时提", "提醒", "定", "时", "提", "醒"]));
	});

	it("returns an empty set for blank queries", () => {
		expect(normalizeQuery("   ").size).toBe(0);
	});
});

describe("scoreCatalogEntry", () => {
	const keywords = (query: string) => normalizeQuery(query);

	it("scores exact name part hits highest", () => {
		const doc = entry("recall_memory", { searchHint: "hint", description: "desc" });
		expect(scoreCatalogEntry(doc, keywords("recall"))).toBe(10);
		expect(scoreCatalogEntry(doc, keywords("memory"))).toBe(10);
	});

	it("scores partial name part hits lower than exact", () => {
		const doc = entry("recall_memory", { searchHint: "hint", description: "desc" });
		// "cal" is contained in part "recall" -> partial.
		expect(scoreCatalogEntry(doc, keywords("cal"))).toBe(5);
		// "recallx" contains part "recall" -> partial (both directions).
		expect(scoreCatalogEntry(doc, keywords("recallx"))).toBe(5);
	});

	it("scores whole-name substring hits (fallback) lowest", () => {
		const doc = entry("recall_memory", { searchHint: "hint", description: "desc" });
		// "ll_mem" spans parts but is not inside any single part -> fallback.
		expect(scoreCatalogEntry(doc, keywords("ll_mem"))).toBe(3);
		expect(scoreCatalogEntry(doc, keywords("recall_memory_x"))).toBe(5); // contains whole part "recall"
	});

	it("adds searchHint weight independently of name hits", () => {
		const doc = entry("recall_memory", { searchHint: "记忆 回忆", description: "desc" });
		// Bigram "记忆" (+4) and single chars 记/忆 (+4 each) all hit the hint.
		expect(scoreCatalogEntry(doc, keywords("记忆"))).toBe(12);
		expect(scoreCatalogEntry(doc, keywords("回忆"))).toBe(12);
	});

	it("adds description weight independently", () => {
		const doc = entry("recall_memory", { searchHint: "hint", description: "检索历史记忆内容" });
		// "历史" (+2) plus single chars 历/史 (+2 each) all hit the description.
		expect(scoreCatalogEntry(doc, keywords("历史"))).toBe(6);
	});

	it("combines name, hint, and description weights", () => {
		const doc = entry("recall_memory", { searchHint: "记忆 回忆", description: "检索历史记忆内容" });
		expect(scoreCatalogEntry(doc, keywords("记忆"))).toBe(18);
	});

	it("returns zero when nothing matches", () => {
		const doc = entry("recall_memory", { searchHint: "hint", description: "desc" });
		expect(scoreCatalogEntry(doc, keywords("完全无关"))).toBe(0);
	});
});

describe("explainCatalogMatch", () => {
	it("generates per-field reasons decoupled from scoring", () => {
		const doc = entry("recall_memory", { searchHint: "记忆 回忆", description: "检索历史记忆" });
		const reasons = explainCatalogMatch(doc, normalizeQuery("recall 记忆"));
		expect(reasons).toContain("名称精确:recall");
		expect(reasons).toContain("提示:记忆");
		expect(reasons).toContain("描述:记忆");
	});

	it("marks partial and fallback name hits", () => {
		const doc = entry("recall_memory", { description: "desc" });
		expect(explainCatalogMatch(doc, normalizeQuery("cal"))).toContain("名称部分:cal");
		expect(explainCatalogMatch(doc, normalizeQuery("ll_mem"))).toContain("名称:ll_mem");
	});
});

describe("KeywordSearchBackend", () => {
	it("short-circuits on exact name matches", () => {
		const backend = new KeywordSearchBackend();
		backend.rebuild([entry("read", { description: "Read a file" })]);
		const results = backend.search("read", { limit: 1 });
		expect(results).toEqual([
			{ name: "read", description: "Read a file", whyMatched: ["名称:精确匹配"], source: "builtin" },
		]);
	});

	it("returns an empty list for blank queries without scanning", () => {
		const backend = new KeywordSearchBackend();
		backend.rebuild([entry("read")]);
		expect(backend.search("   ")).toEqual([]);
	});

	it("returns an empty list when nothing matches", () => {
		const backend = new KeywordSearchBackend();
		backend.rebuild([entry("read")]);
		expect(backend.search("zzz")).toEqual([]);
	});

	it("orders by score descending then name ascending", () => {
		const backend = new KeywordSearchBackend();
		backend.rebuild([
			entry("beta_tool", { searchHint: "keyword", description: "desc" }),
			entry("alpha_tool", { searchHint: "keyword", description: "desc" }),
			entry("unrelated", { description: "desc" }),
		]);
		const results = backend.search("keyword");
		// alpha and beta both score 4 from the hint (name parts do not contain
		// "keyword"), so the name tie-break puts alpha first.
		expect(results.map((result) => result.name)).toEqual(["alpha_tool", "beta_tool"]);
		expect(results[0].whyMatched).toEqual(["提示:keyword"]);
	});

	it("applies limit and excludedNames", () => {
		const backend = new KeywordSearchBackend();
		backend.rebuild([entry("one", { description: "match" }), entry("two", { description: "match" })]);
		expect(backend.search("match", { limit: 1 })).toHaveLength(1);
		expect(backend.search("match", { excludedNames: new Set(["one"]) }).map((r) => r.name)).toEqual(["two"]);
	});

	it("supports incremental add and remove", () => {
		const backend = new KeywordSearchBackend();
		backend.rebuild([entry("read")]);
		expect(backend.has("read")).toBe(true);

		backend.add(entry("write"));
		expect(backend.names()).toEqual(new Set(["read", "write"]));
		expect(backend.search("write").map((r) => r.name)).toEqual(["write"]);

		backend.remove("read");
		expect(backend.has("read")).toBe(false);
		expect(backend.names()).toEqual(new Set(["write"]));
	});
});

describe("ToolCatalog", () => {
	it("facade delegates maintenance and search", () => {
		const catalog = new ToolCatalog();
		catalog.add(entry("read", { description: "Read a file" }));
		catalog.add(entry("grep", { description: "Search contents" }));
		expect(catalog.names()).toEqual(new Set(["read", "grep"]));
		expect(catalog.get("read")?.source).toBe("builtin");
		expect(catalog.search("contents").map((match) => match.name)).toEqual(["grep"]);
		catalog.remove("read");
		expect(catalog.names()).toEqual(new Set(["grep"]));
	});
});

describe("catalog source mapping", () => {
	it("maps SourceInfo sources to catalog labels", () => {
		expect(catalogSourceFromSourceInfo(createSyntheticSourceInfo("<builtin:read>", { source: "builtin" }))).toBe(
			"builtin",
		);
		expect(catalogSourceFromSourceInfo(createSyntheticSourceInfo("<sdk:x>", { source: "sdk" }))).toBe("sdk");
		expect(catalogSourceFromSourceInfo(createSyntheticSourceInfo("<inline:chat-tools>", { source: "inline" }))).toBe(
			"chat",
		);
		expect(catalogSourceFromSourceInfo(createSyntheticSourceInfo("/ext.ts", { source: "local" }))).toBe("extension");
		expect(catalogSourceFromSourceInfo(createSyntheticSourceInfo("<x>", { source: "temporary" }))).toBe("temporary");
	});

	it("builds entries from definitions with optional searchHint", () => {
		const definition = {
			name: "read",
			label: "read",
			description: "Read a file",
			searchHint: "文件 阅读 查看",
		};
		const built = catalogEntryFromToolDefinition(
			definition,
			createSyntheticSourceInfo("<builtin:read>", { source: "builtin" }),
		);
		expect(built).toEqual({
			name: "read",
			label: "read",
			description: "Read a file",
			searchHint: "文件 阅读 查看",
			source: "builtin",
		});
	});

	it("omits searchHint when the definition does not provide one", () => {
		const built = catalogEntryFromToolDefinition(
			{ name: "plain", label: "plain", description: "d" },
			createSyntheticSourceInfo("<builtin:plain>", { source: "builtin" }),
		);
		expect("searchHint" in built).toBe(false);
	});
});

describe("acceptance: real tool definitions", () => {
	it("finds memory tools with a Chinese query via searchHint", () => {
		const { catalog } = builtinCatalog();
		for (const chatEntry of chatStyleMemoryEntries()) {
			catalog.add(chatEntry);
		}

		const results = catalog.search("记忆", { limit: 8 });
		const names = results.map((result) => result.name);
		expect(names).toContain("recall_memory");
		expect(names).toContain("memorize");
		const memoryHit = results.find((result) => result.name === "recall_memory");
		expect(memoryHit?.whyMatched).toContain("提示:记忆");
		expect(memoryHit?.source).toBe("chat");
	});

	it("finds read/write/edit with an English query", () => {
		const { catalog } = builtinCatalog();
		const results = catalog.search("file", { limit: 8 });
		const names = results.map((result) => result.name);
		expect(names).toContain("read");
		expect(names).toContain("write");
		expect(names).toContain("edit");
		for (const result of results) {
			expect(result.whyMatched.length).toBeGreaterThan(0);
			expect(result.source).toBe("builtin");
		}
	});

	it("indexes all builtin tools with searchHint examples", () => {
		const { catalog, entries } = builtinCatalog();
		expect(catalog.names()).toEqual(new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]));
		expect(entries.every((catalogEntry) => catalogEntry.searchHint !== undefined)).toBe(true);
	});
});
