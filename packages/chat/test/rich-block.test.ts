import type { MemoryHit } from "@cogito/host";
import { describe, expect, it } from "vitest";
import { buildRichInjectionBlock, formatProcedureAnnotations, formatRelativeAge } from "../src/memory/rich-block.ts";

function hit(partial: Partial<MemoryHit>): MemoryHit {
	return {
		id: "mem1",
		memoryType: "event",
		summary: "用户完成了迁移",
		sourceRef: "s",
		happenedAt: null,
		score: 0.9,
		...partial,
	};
}

const NOW = new Date("2026-08-16T12:00:00Z");

describe("formatRelativeAge", () => {
	it("renders minutes/hours/days and skips missing or invalid timestamps", () => {
		expect(formatRelativeAge("2026-08-16T11:58:00Z", NOW)).toBe("距今约 2 分钟");
		expect(formatRelativeAge("2026-08-16T10:00:00Z", NOW)).toBe("距今约 2 小时");
		expect(formatRelativeAge("2026-08-14T12:00:00Z", NOW)).toBe("距今约 2 天");
		expect(formatRelativeAge(null, NOW)).toBe("");
		expect(formatRelativeAge("not-a-date", NOW)).toBe("");
	});
});

describe("formatProcedureAnnotations", () => {
	it("inlines trigger tags and steps", () => {
		expect(formatProcedureAnnotations({ trigger_tags: ["steam", "库存"], steps: ["先查询", "再汇总"] })).toBe(
			"(触发:steam、库存；步骤:1.先查询 2.再汇总)",
		);
	});

	it("returns an empty string without procedure metadata", () => {
		expect(formatProcedureAnnotations(undefined)).toBe("");
		expect(formatProcedureAnnotations({})).toBe("");
	});
});

describe("buildRichInjectionBlock", () => {
	it("renders relative time, evidence, and confidence labels per item", () => {
		const block = buildRichInjectionBlock(
			[
				hit({
					id: "a",
					memoryType: "profile",
					summary: "用户是后端工程师",
					sourceRef: "chat:c:1",
					happenedAt: "2026-08-16T10:00:00Z",
					score: 0.8,
				}),
				hit({
					id: "b",
					memoryType: "event",
					summary: "用户去了杭州",
					happenedAt: "2026-08-10T12:00:00Z",
					score: 0.5,
					confidenceLabel: "有印象,不确定",
				}),
			],
			{ now: NOW },
		);
		expect(block).toContain("## 记忆检索");
		expect(block).toContain("- [a] (画像) [距今约 2 小时] 用户是后端工程师(证据:可回源原文)");
		expect(block).toContain("- [b] (事件) [距今约 6 天] 用户去了杭州(证据:可回源原文；有印象,不确定)");
	});

	it("force-annotates procedures with a tool requirement and inlines steps", () => {
		const block = buildRichInjectionBlock(
			[
				hit({
					id: "p1",
					memoryType: "procedure",
					summary: "查 Steam 库存前必须先调用 steam_query",
					score: 0.6,
					extra: {
						tool_requirement: "steam_query",
						trigger_tags: ["steam", "库存"],
						steps: ["调用 steam_query", "汇总结果"],
					},
				}),
			],
			{ now: NOW },
		);
		expect(block).toContain(
			"- [p1] (流程) 查 Steam 库存前必须先调用 steam_query(必须调用工具:steam_query；证据:可回源原文)",
		);
	});

	it("filters by score threshold, applies per-type quotas and char budget", () => {
		const items: MemoryHit[] = [];
		for (let i = 0; i < 10; i++) {
			items.push(hit({ id: `e${i}`, memoryType: "event", summary: `事件 ${i}`, score: 0.01 + i * 0.03 }));
		}
		const block = buildRichInjectionBlock(items, { now: NOW });
		// 全部低于 0.45 阈值 → 空块。
		expect(block).toBe("");

		const above: MemoryHit[] = [];
		for (let i = 0; i < 10; i++) {
			above.push(hit({ id: `p${i}`, memoryType: "preference", summary: `偏好 ${i}`, score: 0.9 }));
		}
		const quotaBlock = buildRichInjectionBlock(above, { now: NOW });
		// procedure/preference 配额 4 条。
		expect(quotaBlock.match(/- \[p\d\]/g) ?? []).toHaveLength(4);

		const tiny = buildRichInjectionBlock(
			[hit({ id: "x", memoryType: "event", summary: "很长的摘要 ".repeat(100), score: 0.9 })],
			{ now: NOW, maxChars: 60 },
		);
		expect(tiny).toBe("");
	});

	it("returns an empty string for no hits", () => {
		expect(buildRichInjectionBlock([], { now: NOW })).toBe("");
	});
});
