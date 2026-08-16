import { describe, expect, it, vi } from "vitest";
import type { Clock } from "../src/clock.ts";
import { DriftIdleStrategy } from "../src/stages/idle.ts";
import type { TurnContext } from "../src/stages/types.ts";

function makeCtx(sessionKey = "local"): TurnContext {
	return { sessionKey } as TurnContext;
}

function fixedClock(at: Date): Clock {
	return { now: () => at, nowMs: () => at.getTime() };
}

function makeStrategy(options: {
	minIntervalHours: number;
	gateTtlHours?: number;
	lastDriftAt?: number | null;
	clock?: Clock;
}) {
	const gateWriter = vi.fn();
	const clock = options.clock ?? fixedClock(new Date("2026-01-01T00:00:00Z"));
	const store = {
		getState: vi.fn((key: string) => {
			if (key === "lastDriftAt") return options.lastDriftAt === undefined ? null : String(options.lastDriftAt);
			return null;
		}),
		setState: vi.fn(),
	};
	const strategy = new DriftIdleStrategy({
		store: store as never,
		minIntervalHours: options.minIntervalHours,
		gateTtlHours: options.gateTtlHours,
		clock,
		gateWriter: gateWriter as never,
	});
	return { strategy, gateWriter, clock, store };
}

describe("DriftIdleStrategy gate 写出(三进程模式)", () => {
	it("writes an allowed gate with a configurable TTL when due", async () => {
		const { strategy, gateWriter, clock } = makeStrategy({ minIntervalHours: 3, gateTtlHours: 7 });
		const entered = await strategy.run(makeCtx());
		expect(entered).toBe(true);
		expect(gateWriter).toHaveBeenCalledWith(
			expect.objectContaining({ verdict: "allowed", reason: "idle_due", ttlHours: 7 }),
		);
		expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
	});

	it("defaults the allowed TTL to max(1, minIntervalHours)", async () => {
		const { strategy, gateWriter } = makeStrategy({ minIntervalHours: 3 });
		await strategy.run(makeCtx());
		expect(gateWriter).toHaveBeenCalledWith(expect.objectContaining({ verdict: "allowed", ttlHours: 3 }));
	});

	it("writes a suppressed gate with the remaining interval TTL when not due", async () => {
		const lastDriftAt = new Date("2026-01-01T00:00:00Z").getTime();
		const { strategy, gateWriter, clock } = makeStrategy({
			minIntervalHours: 3,
			lastDriftAt,
			clock: fixedClock(new Date("2026-01-01T01:00:00Z")),
		});
		const entered = await strategy.run(makeCtx());
		expect(entered).toBe(false);
		expect(gateWriter).toHaveBeenCalledWith(
			expect.objectContaining({ verdict: "suppressed", reason: "min_interval", ttlHours: 2 }),
		);
		expect(clock.now().toISOString()).toBe("2026-01-01T01:00:00.000Z");
	});
});
