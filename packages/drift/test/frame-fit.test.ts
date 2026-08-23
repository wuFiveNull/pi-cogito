import { describe, expect, it } from "vitest";
import { type DriftContextSection, fitContextFrame } from "../src/runtime.ts";

function section(name: string, content: string): DriftContextSection {
	return { name, content };
}

describe("fitContextFrame", () => {
	const sections: DriftContextSection[] = [
		section("drift_skills", "skills block"),
		section("drift_briefing", "briefing block"),
		section("current_context_events", "x".repeat(5000)),
		section("recent_raw_chat", "y".repeat(5000)),
		section("drift_note", "note"),
	];

	it("keeps everything under the budget", async () => {
		const result = await fitContextFrame(
			sections,
			async (list) => list.map((s) => `## ${s.name}\n${s.content}`).join("\n\n"),
			1_000_000,
		);
		expect(result.dropped).toEqual([]);
		expect(result.content).toContain("## drift_skills");
		expect(result.content).not.toContain("dropped sections");
	});

	it("drops low-priority sections first and reports them", async () => {
		const render = async (list: readonly DriftContextSection[]): Promise<string> =>
			list.map((s) => `## ${s.name}\n${s.content}`).join("\n\n");
		const result = await fitContextFrame(sections, render, 1200);
		// current_context_events 与 recent_raw_chat 先被剔除,核心段保留。
		expect(result.dropped).toContain("current_context_events");
		expect(result.dropped).toContain("recent_raw_chat");
		expect(result.content).toContain("## drift_skills");
		expect(result.content).toContain("## drift_briefing");
		// 丢弃名单告知模型缺失了哪些 section。
		expect(result.content).toContain("[context frame dropped sections: ");
		expect(result.content).toContain("current_context_events");
	});

	it("still clips when core sections alone exceed the budget", async () => {
		const render = async (list: readonly DriftContextSection[]): Promise<string> =>
			list.map((s) => `## ${s.name}\n${s.content}`).join("\n\n");
		const tiny: DriftContextSection[] = [section("drift_skills", "z".repeat(10000))];
		const result = await fitContextFrame(tiny, render, 1000);
		expect(result.content).toContain("[context truncated by Drift budget]");
	});
});
