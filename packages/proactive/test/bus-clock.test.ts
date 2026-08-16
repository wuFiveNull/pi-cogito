/**
 * Phase 0 — Clock 与 EventBus 的行为测试。
 *
 * 覆盖:可注入时钟、事件订阅/退订/异常隔离,以及 engine tick 终局事件
 * (ProactiveFinished)与固定时钟的集成。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Delivered, EventBus, ProactiveFinished } from "../src/bus.ts";
import { type Clock, SystemClock } from "../src/clock.ts";
import { ProactiveEngine } from "../src/engine.ts";
import { ProactiveRules } from "../src/rules.ts";
import { createDefaultStages, type DefaultStagesDeps } from "../src/stages/defaults.ts";
import { Presence } from "../src/stages/sense.ts";
import { ProactiveStore } from "../src/store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("EventBus", () => {
	it("dispatches events to subscribers of the same event class", async () => {
		const bus = new EventBus();
		const seen: ProactiveFinished[] = [];
		bus.on(ProactiveFinished, (e) => {
			seen.push(e);
		});
		await bus.emit(new ProactiveFinished(1, "local", "none", "no_candidates", null, 0, 10, 20));
		await bus.emit(new Delivered("local", "hi", [1], 30));
		expect(seen).toHaveLength(1);
		expect(seen[0].tickId).toBe(1);
		expect(seen[0].action).toBe("none");
	});

	it("supports multiple subscribers and unsubscribing", async () => {
		const bus = new EventBus();
		let a = 0;
		let b = 0;
		const offA = bus.on(ProactiveFinished, () => {
			a++;
		});
		bus.on(ProactiveFinished, () => {
			b++;
		});
		const event = new ProactiveFinished(1, "local", "none", "", null, 0, 0, 0);
		await bus.emit(event);
		expect(a).toBe(1);
		expect(b).toBe(1);
		offA();
		bus.off(ProactiveFinished, () => {});
		await bus.emit(event);
		expect(a).toBe(1);
		expect(b).toBe(2);
	});

	it("isolates handler exceptions", async () => {
		const bus = new EventBus();
		const seen: ProactiveFinished[] = [];
		bus.on(ProactiveFinished, () => {
			throw new Error("boom");
		});
		bus.on(ProactiveFinished, (e) => {
			seen.push(e);
		});
		const event = new ProactiveFinished(1, "local", "none", "", null, 0, 0, 0);
		await expect(bus.emit(event)).resolves.toBe(event);
		expect(seen).toHaveLength(1);
	});

	it("awaits async handlers and isolates scoped subscribers", async () => {
		const bus = new EventBus();
		const first = bus.scope("first");
		const second = bus.scope("second");
		const seen: string[] = [];
		bus.on(Delivered, () => {
			seen.push("root");
		});
		first.on(Delivered, async () => {
			await Promise.resolve();
			seen.push("first");
		});
		second.on(Delivered, () => {
			seen.push("second");
		});

		await first.emit(new Delivered("first", "message", [], 1));

		expect(seen).toEqual(["root", "first"]);
	});

	it("tracks subscriber counts", () => {
		const bus = new EventBus();
		expect(bus.subscriberCount(ProactiveFinished)).toBe(0);
		const off = bus.on(ProactiveFinished, () => {});
		expect(bus.subscriberCount(ProactiveFinished)).toBe(1);
		off();
		expect(bus.subscriberCount(ProactiveFinished)).toBe(0);
	});
});

describe("SystemClock", () => {
	it("returns current time as Date and ms", () => {
		const before = Date.now();
		expect(SystemClock.now()).toBeInstanceOf(Date);
		expect(SystemClock.nowMs()).toBeGreaterThanOrEqual(before);
	});
});

describe("engine events with injected clock", () => {
	it("emits ProactiveFinished with injected clock timestamps", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bus-clock-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "t.sqlite");
		const store = new ProactiveStore(dbPath);
		const fixed = new Date("2026-08-07T12:00:00.000Z");
		const clock: Clock = { now: () => fixed, nowMs: () => fixed.getTime() };
		const bus = new EventBus();
		const events: ProactiveFinished[] = [];
		bus.on(ProactiveFinished, (e) => {
			events.push(e);
		});

		const presence = new Presence(store, { sessionsDir: "/nonexistent" });
		const deps: DefaultStagesDeps = {
			store,
			presence,
			sourceInstances: [],
			intervals: {},
			driftMinIntervalHours: 3,
			clock,
		};
		const engine = new ProactiveEngine(createDefaultStages({}, deps), store, {
			rules: new ProactiveRules(join(dir, "no-rules.md")),
			clock,
			eventBus: bus,
		});
		await (engine as unknown as { tick(): Promise<unknown> }).tick();

		expect(events).toHaveLength(1);
		expect(events[0].sessionKey).toBe("local");
		expect(events[0].action).toBe("none");
		expect(events[0].skipReason).toBe("no_candidates");
		expect(events[0].startedAt).toBe(fixed.getTime());
		expect(events[0].finishedAt).toBe(fixed.getTime());
		store.close();
	});
});
