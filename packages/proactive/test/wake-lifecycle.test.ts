/**
 * Phase 4 — wake 生命周期模块图(ext kernel 驱动 wake 链路)。
 */

import { describe, expect, it } from "vitest";
import { ProactiveKernel } from "../src/ext/kernel.ts";
import { ProactiveLifecycleSpec } from "../src/ext/lifecycle.ts";
import { buildWakeModules, wakeLifecycleSpec } from "../src/wake/lifecycle.ts";
import type { WakeRuntime } from "../src/wake/runtime.ts";

describe("wake lifecycle module graph", () => {
	it("compiles the wake lifecycle with the expected module order", () => {
		const kernel = new ProactiveKernel(buildWakeModules({} as WakeRuntime), {
			lifecycle: wakeLifecycleSpec,
		});
		const inspect = kernel.inspect();
		expect(inspect).toContain("lifecycle=wake");
		const order = ["wake.start", "wake.ingest", "wake.content.decide", "wake.drift.decide", "wake.schedule"];
		const positions = order.map((slot) => inspect.indexOf(slot));
		expect(positions.every((pos) => pos >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	});

	it("requires the terminal slot run:next_wakeup", () => {
		const spec = new ProactiveLifecycleSpec("wake", [], [], ["run:missing"]);
		expect(() => new ProactiveKernel([], { lifecycle: spec })).toThrow(/terminal slot has no producer/);
	});
});
