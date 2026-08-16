/**
 * Phase 1 — ProactiveKernel(ext/kernel.ts):runTickResult / lastResult / 初始 slots。
 */

import { describe, expect, it } from "vitest";
import { type ProactiveFrame, ProactiveTickResult } from "../src/ext/frame.ts";
import { ProactiveKernel } from "../src/ext/kernel.ts";
import { ProactiveLifecycleSpec } from "../src/ext/lifecycle.ts";
import type { PhaseModule } from "../src/ext/phase.ts";

describe("ProactiveKernel", () => {
	it("runs a tick and returns the frame output", async () => {
		const module: PhaseModule = {
			slot: "proactive.commit",
			produces: ["run:next_wakeup"],
			run: (frame: ProactiveFrame) => {
				frame.output = new ProactiveTickResult(0.42, 2400);
				return frame;
			},
		};
		const kernel = new ProactiveKernel([module], {
			lifecycle: new ProactiveLifecycleSpec("default", [], [], ["run:next_wakeup"]),
		});
		const result = await kernel.runTickResult("local");
		expect(result?.baseScore).toBe(0.42);
		expect(result?.nextIntervalSeconds).toBe(2400);
		expect(kernel.lastResult?.baseScore).toBe(0.42);
	});

	it("runTick returns only the base score", async () => {
		const module: PhaseModule = {
			slot: "proactive.commit",
			run: (frame: ProactiveFrame) => {
				frame.output = new ProactiveTickResult(0.8, 1200);
				return frame;
			},
		};
		const kernel = new ProactiveKernel([module], {
			lifecycle: new ProactiveLifecycleSpec("default", [], [], []),
		});
		expect(await kernel.runTick("local")).toBe(0.8);
	});

	it("injects initial slots into the frame", async () => {
		let seen: Record<string, unknown> = {};
		const module: PhaseModule = {
			slot: "proactive.start",
			requires: ["proactive:cfg"],
			run: (frame: ProactiveFrame) => {
				seen = frame.slots;
				return frame;
			},
		};
		const kernel = new ProactiveKernel([module], {
			lifecycle: new ProactiveLifecycleSpec("default", [], ["proactive:cfg"], []),
			initialSlotsFn: (sessionKey) => ({ "proactive:cfg": { sessionKey } }),
		});
		await kernel.runTickResult("local");
		expect(seen["proactive:cfg"]).toEqual({ sessionKey: "local" });
	});

	it("start/stop delegate to lifecycle hooks", async () => {
		const events: string[] = [];
		const module: PhaseModule = {
			slot: "a.x",
			start: async () => {
				events.push("start");
			},
			stop: async () => {
				events.push("stop");
			},
			run: (frame: ProactiveFrame) => frame,
		};
		const kernel = new ProactiveKernel([module], {
			lifecycle: new ProactiveLifecycleSpec("default", [], [], []),
		});
		await kernel.start();
		await kernel.stop();
		expect(events).toEqual(["start", "stop"]);
	});

	it("inspects the compiled lifecycle", () => {
		const kernel = new ProactiveKernel([], {
			lifecycle: new ProactiveLifecycleSpec("wake", [], [], []),
		});
		expect(kernel.inspect()).toContain("lifecycle=wake");
	});
});
