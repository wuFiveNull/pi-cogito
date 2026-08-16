import { describe, expect, it } from "vitest";
import { EventBus } from "../src/bus.ts";
import {
	createPassiveTurnLifecycleModules,
	PassiveTurnFinished,
	PassiveTurnLifecycle,
	PassiveTurnStarted,
} from "../src/passive.ts";

describe("passive turn lifecycle", () => {
	it("emits all four phases around reasoning", async () => {
		const bus = new EventBus();
		const names: string[] = [];
		bus.onAny((event) => {
			names.push(event.constructor.name);
		});
		const lifecycle = new PassiveTurnLifecycle(bus);
		const result = await lifecycle.run(
			{ sessionKey: "local", turnIndex: 2, startedAt: 100, metadata: { channel: "test" } },
			() => "ok",
		);
		expect(result).toBe("ok");
		expect(names).toEqual([
			"PassiveTurnStarted",
			"PassiveBeforeReasoning",
			"PassiveAfterReasoning",
			"PassiveTurnFinished",
		]);
	});

	it("bridges pi-agent-core lifecycle modules and reports failures", async () => {
		const bus = new EventBus();
		const events: object[] = [];
		bus.on(PassiveTurnStarted, (event) => {
			events.push(event);
		});
		bus.on(PassiveTurnFinished, (event) => {
			events.push(event);
		});
		const lifecycle = new PassiveTurnLifecycle(bus);
		const modules = createPassiveTurnLifecycleModules(lifecycle, { sessionKey: "local" });
		for (const module of modules) {
			await module.run({
				context: {
					phase: module.phase,
					agentContext: { systemPrompt: "", messages: [] },
					newMessages: [],
					turnIndex: 0,
					hints: [],
					metadata: {},
				},
				get: () => undefined,
				set: () => undefined,
			});
		}
		expect(events).toHaveLength(2);
		expect(events[0]).toBeInstanceOf(PassiveTurnStarted);
		expect(events[1]).toBeInstanceOf(PassiveTurnFinished);
	});
});
