/**
 * Phase 1 — 生命周期编译(ext/lifecycle.ts):依赖展开、slot 校验、start/stop 回滚。
 */

import { describe, expect, it } from "vitest";
import { ProactiveFrame, ProactiveTickInput } from "../src/ext/frame.ts";
import { ProactiveLifecycleBuilder, ProactiveLifecycleSpec } from "../src/ext/lifecycle.ts";
import type { PhaseModule } from "../src/ext/phase.ts";

function frame(): ProactiveFrame {
	return new ProactiveFrame(new ProactiveTickInput("local", new Date()));
}

function makeModule(
	slot: string,
	options: { requires?: readonly string[]; produces?: readonly string[]; collects?: readonly string[] } = {},
): PhaseModule {
	return {
		slot,
		requires: options.requires,
		produces: options.produces,
		collects: options.collects,
		run: (f: ProactiveFrame) => f,
	};
}

describe("ProactiveLifecycleBuilder", () => {
	it("expands data-slot requires to their producer module slots", () => {
		const spec = new ProactiveLifecycleSpec("test", [makeModule("a.start", { produces: ["run:state"] })]);
		const consumer = makeModule("b.consume", { requires: ["run:state"] });
		const compiled = new ProactiveLifecycleBuilder().build(spec, [consumer]);
		// 数据依赖展开后 consumer 排在 producer 之后
		const slots = compiled.moduleSlots;
		expect(slots.indexOf("a.start")).toBeLessThan(slots.indexOf("b.consume"));
	});

	it("expands collects prefixes into producer module dependencies", () => {
		const spec = new ProactiveLifecycleSpec("test", [
			makeModule("a.start", { produces: ["proactive:gate:pass_probability"] }),
			makeModule("b.collect", { collects: ["proactive:gate:*"] }),
		]);
		const compiled = new ProactiveLifecycleBuilder().build(spec, []);
		expect(compiled.moduleSlots.indexOf("a.start")).toBeLessThan(compiled.moduleSlots.indexOf("b.collect"));
	});

	it("orders collect-prefixed producers before the collector even when declared after (expanded requires)", () => {
		// producer 声明在 collector 之后:展开后的 requires 边必须参与拓扑排序
		// (akashic topo_sort_modules(bindings) 语义),否则 collector 先跑收不到数据。
		const spec = new ProactiveLifecycleSpec("test", [
			makeModule("proactive.prompt.collect", { collects: ["proactive:prompt:system_bottom:*"] }),
		]);
		const compiled = new ProactiveLifecycleBuilder().build(spec, [
			makeModule("my.plugin.state", { produces: ["proactive:prompt:system_bottom:rules"] }),
		]);
		expect(compiled.moduleSlots.indexOf("my.plugin.state")).toBeLessThan(
			compiled.moduleSlots.indexOf("proactive.prompt.collect"),
		);
	});

	it("accepts data slots provided by initialSlots", () => {
		const spec = new ProactiveLifecycleSpec(
			"test",
			[makeModule("a.consume", { requires: ["proactive:cfg"] })],
			["proactive:cfg"],
		);
		expect(() => new ProactiveLifecycleBuilder().build(spec, [])).not.toThrow();
	});

	it("rejects missing data dependencies", () => {
		const spec = new ProactiveLifecycleSpec("test", [makeModule("a.consume", { requires: ["proactive:missing"] })]);
		expect(() => new ProactiveLifecycleBuilder().build(spec, [])).toThrow(/data dependency missing/);
	});

	it("rejects duplicated module slots across spec and contributions", () => {
		const spec = new ProactiveLifecycleSpec("test", [makeModule("a.x")]);
		expect(() => new ProactiveLifecycleBuilder().build(spec, [makeModule("a.x")])).toThrow(/slot duplicated/);
	});

	it("rejects terminal slots without a producer", () => {
		const spec = new ProactiveLifecycleSpec("test", [makeModule("a.x")], [], ["run:next_wakeup"]);
		expect(() => new ProactiveLifecycleBuilder().build(spec, [])).toThrow(/terminal slot has no producer/);
	});
});

describe("CompiledProactiveLifecycle", () => {
	it("runs modules in order", async () => {
		const order: string[] = [];
		const module = (slot: string): PhaseModule => ({
			slot,
			run: async (f: ProactiveFrame) => {
				order.push(slot);
				return f;
			},
		});
		const spec = new ProactiveLifecycleSpec("test", [module("a.x"), module("b.y")]);
		const compiled = new ProactiveLifecycleBuilder().build(spec, []);
		const result = await compiled.run(frame());
		expect(order).toEqual(["a.x", "b.y"]);
		expect(result).toBeInstanceOf(ProactiveFrame);
	});

	it("starts in order and rolls back in reverse on start failure", async () => {
		const events: string[] = [];
		const module = (slot: string, failStart = false): PhaseModule => ({
			slot,
			start: async () => {
				events.push(`start:${slot}`);
				if (failStart) throw new Error("start boom");
			},
			stop: async () => {
				events.push(`stop:${slot}`);
			},
			run: (f: ProactiveFrame) => f,
		});
		const spec = new ProactiveLifecycleSpec("test", [module("a.x"), module("b.y", true), module("c.z")]);
		const compiled = new ProactiveLifecycleBuilder().build(spec, []);
		await expect(compiled.start()).rejects.toThrow(/start boom/);
		// 失败模块视为已取得资源,逆序回滚;未启动的模块(c.z)不参与
		expect(events).toEqual(["start:a.x", "start:b.y", "stop:b.y", "stop:a.x"]);
	});

	it("stops in reverse order and aggregates errors", async () => {
		const events: string[] = [];
		const module = (slot: string, failStop = false): PhaseModule => ({
			slot,
			stop: async () => {
				events.push(`stop:${slot}`);
				if (failStop) throw new Error(`${slot} stop boom`);
			},
			run: (f: ProactiveFrame) => f,
		});
		const spec = new ProactiveLifecycleSpec("test", [module("a.x", true), module("b.y", true)]);
		const compiled = new ProactiveLifecycleBuilder().build(spec, []);
		await expect(compiled.stop()).rejects.toThrow(/stop failed/);
		expect(events).toEqual(["stop:b.y", "stop:a.x"]);
	});

	it("shields cleanup from cancellation: aborted signal still runs every stopper (akashic _await_cleanup)", async () => {
		const events: string[] = [];
		const module = (slot: string): PhaseModule => ({
			slot,
			stop: async () => {
				// 模拟慢清理:即使调用方已取消,清理也必须完成。
				await new Promise((resolve) => setTimeout(resolve, 10));
				events.push(`stop:${slot}`);
			},
			run: (f: ProactiveFrame) => f,
		});
		const spec = new ProactiveLifecycleSpec("test", [module("a.x"), module("b.y")]);
		const compiled = new ProactiveLifecycleBuilder().build(spec, []);
		const controller = new AbortController();
		controller.abort();
		const error = await compiled.stop(controller.signal).catch((caught: unknown) => caught);
		// 取消聚合为 AbortError,不截断任何 stopper。
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors.some((entry) => entry instanceof DOMException)).toBe(true);
		expect(events).toEqual(["stop:b.y", "stop:a.x"]);
	});

	it("inspects with lifecycle id", () => {
		const spec = new ProactiveLifecycleSpec("wake", [makeModule("wake.start")]);
		const compiled = new ProactiveLifecycleBuilder().build(spec, []);
		expect(compiled.inspect()).toContain("lifecycle=wake");
		expect(compiled.inspect()).toContain("wake.start");
	});
});
