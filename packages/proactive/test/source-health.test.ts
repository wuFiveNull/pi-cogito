import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceAckCoordinator } from "../src/runtime/source-ack.ts";
import { SourceHealthTracker } from "../src/runtime/source-health.ts";
import { SourcePollStrategy } from "../src/stages/fetch-scheduler.ts";
import { ProactiveStore } from "../src/store.ts";
import type { ProactiveSource } from "../src/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): ProactiveStore {
	const dir = mkdtempSync(join(tmpdir(), "proactive-source-health-"));
	tempDirs.push(dir);
	return new ProactiveStore(join(dir, "proactive.sqlite"));
}

describe("source health and circuit breaker", () => {
	it("opens after consecutive failures and closes after a successful probe", () => {
		const store = makeStore();
		const tracker = new SourceHealthTracker({ store, failureThreshold: 2, cooldownMs: 100 });

		expect(tracker.tryAcquire("feed", 0)).toBe(true);
		tracker.recordFailure("feed", 0, "first");
		expect(tracker.tryAcquire("feed", 1)).toBe(true);
		tracker.recordFailure("feed", 1, "second");
		expect(tracker.tryAcquire("feed", 50)).toBe(false);
		expect(tracker.tryAcquire("feed", 101)).toBe(true);
		tracker.recordSuccess("feed", 101, { received: 2, accepted: 1 });

		expect(tracker.read("feed")).toMatchObject({
			status: "ok",
			circuitState: "closed",
			consecutiveFailures: 0,
			fetchAttempts: 3,
			fetchFailures: 2,
			received: 2,
			accepted: 1,
		});
		store.close();
	});

	it("prevents a broken source from being called while its circuit is open", async () => {
		const store = makeStore();
		let now = 1;
		let shouldFail = true;
		const fetch = vi.fn(async () => {
			if (shouldFail) throw new Error("upstream down");
			return { received: 1, inserted: 1, duplicates: 0, quarantined: 0 };
		});
		const tracker = new SourceHealthTracker({ store, failureThreshold: 1, cooldownMs: 100 });
		const strategy = new SourcePollStrategy(
			[{ id: "feed", fetch }],
			{ feed: 1 },
			1,
			{ nowMs: () => now, now: () => new Date(now) },
			store,
			false,
			tracker,
		);
		const onError = vi.fn();
		strategy.start(() => {}, onError);

		await strategy.runOnce();
		now = 2;
		await strategy.runOnce();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledTimes(1);

		now = 102;
		shouldFail = false;
		await strategy.runOnce();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(tracker.read("feed")?.circuitState).toBe("closed");
		strategy.stop();
		store.close();
	});
});

describe("durable source ACK backoff", () => {
	it("does not retry before next_attempt_at and survives tracker recreation", async () => {
		const store = makeStore();
		let fail = true;
		const ack = vi.fn(async () => {
			if (fail) throw new Error("ack unavailable");
		});
		const source: ProactiveSource = { id: "feed", label: "Feed", fetch: async () => [], ack };
		const clock = { now: () => new Date(0), nowMs: () => 0 };
		const coordinator = new SourceAckCoordinator({
			store,
			sources: new Map([["feed", source]]),
			clock,
			retryBaseDelayMs: 100,
			retryMaxDelayMs: 1000,
		});

		await expect(coordinator.acknowledge("feed", ["event-1"])).rejects.toThrow("ack unavailable");
		expect(store.listPendingSourceAcknowledgements()[0]?.next_attempt_at).toBe(100);
		await coordinator.flush(1000, { now: 50 });
		expect(ack).toHaveBeenCalledTimes(1);

		fail = false;
		const restarted = new SourceAckCoordinator({
			store,
			sources: new Map([["feed", source]]),
			clock: { now: () => new Date(100), nowMs: () => 100 },
			retryBaseDelayMs: 100,
			retryMaxDelayMs: 1000,
		});
		await restarted.flush();
		expect(ack).toHaveBeenCalledTimes(2);
		expect(store.listPendingSourceAcknowledgements()).toHaveLength(0);
		store.close();
	});
});
