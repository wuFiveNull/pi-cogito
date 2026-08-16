/**
 * Phase 1 — 模块图拓扑排序与依赖校验(ext/phase.ts)。
 */

import { describe, expect, it } from "vitest";
import type { ProactiveFrame } from "../src/ext/frame.ts";
import { collectPrefixedSlots, inspectPhase, type PhaseModule, topoSortModules } from "../src/ext/phase.ts";

function makeModule(slot: string, requires: readonly string[] = [], produces: readonly string[] = []): PhaseModule {
	return {
		slot,
		requires,
		produces,
		run: (frame: ProactiveFrame) => frame,
	};
}

describe("topoSortModules", () => {
	it("orders modules so dependencies run first", () => {
		const modules = [
			makeModule("proactive.commit", ["proactive.proposal.resolve", "run:proposal"], ["run:result"]),
			makeModule("proactive.start", [], ["run:state"]),
			makeModule("proactive.proposal.resolve", ["run:state"], ["run:proposal"]),
		];
		const sorted = topoSortModules(modules);
		expect(sorted.map((m) => m.slot)).toEqual(["proactive.start", "proactive.proposal.resolve", "proactive.commit"]);
	});

	it("rejects duplicated slots", () => {
		const modules = [makeModule("a.x"), makeModule("a.x")];
		expect(() => topoSortModules(modules)).toThrow(/slot duplicated/);
	});

	it("rejects cycles", () => {
		const modules = [makeModule("a.x", ["b.y"]), makeModule("b.y", ["a.x"])];
		expect(() => topoSortModules(modules)).toThrow(/cycle/);
	});

	it("disables modules with missing module dependencies instead of failing", () => {
		const modules = [makeModule("a.x", ["missing.slot"]), makeModule("b.y")];
		const sorted = topoSortModules(modules);
		expect(sorted.map((m) => m.slot)).toEqual(["b.y"]);
	});

	it("keeps declaration order for independent modules", () => {
		const modules = [makeModule("a.x"), makeModule("b.y"), makeModule("c.z")];
		const sorted = topoSortModules(modules);
		expect(sorted.map((m) => m.slot)).toEqual(["a.x", "b.y", "c.z"]);
	});
});

describe("inspectPhase", () => {
	it("renders execution order and dependency tree", () => {
		const modules = [
			makeModule("proactive.start", [], ["run:state"]),
			makeModule("proactive.commit", ["run:state", "run:proposal"], ["run:result"]),
			makeModule("proactive.judge", ["run:state"], ["run:proposal"]),
		];
		const text = inspectPhase(modules);
		expect(text).toContain("执行顺序:");
		expect(text).toContain("0. proactive.start");
		expect(text).toContain("依赖树:");
		expect(text).toContain("proactive.commit");
	});
});

describe("collectPrefixedSlots", () => {
	it("collects matching prefix and strips it", () => {
		const slots = { "proactive:gate:pass_probability": 0.5, "proactive:effect:a": { x: 1 }, other: 1 };
		const collected = collectPrefixedSlots(slots, "proactive:gate:");
		expect(collected).toEqual({ pass_probability: 0.5 });
		expect(collectPrefixedSlots(slots, "proactive:effect:")).toEqual({ a: { x: 1 } });
	});

	it("skips reserved fields and empty names", () => {
		const slots = { "proactive:gate:": 1, "proactive:gate:x": 2 };
		expect(collectPrefixedSlots(slots, "proactive:gate:", ["x"])).toEqual({});
	});
});
