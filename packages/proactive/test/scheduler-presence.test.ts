import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourcePollStrategy, SourceScheduler } from "../src/stages/fetch-scheduler.ts";
import { computeEnergy, dEnergy, dRecent, nextTickFromScore, TickScheduler } from "../src/stages/schedule.ts";
import { Presence } from "../src/stages/sense.ts";
import { ProactiveStore } from "../src/store.ts";

const tempDirs: string[] = [];
let agentDir = "";

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.useRealTimers();
});

function makeStore(): ProactiveStore {
	agentDir = mkdtempSync(join(tmpdir(), "proactive-test-"));
	tempDirs.push(agentDir);
	return new ProactiveStore(join(agentDir, "proactive.sqlite"));
}

function writeSession(file: string, userTs: number): void {
	const dir = join(agentDir, "sessions");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, file),
		`{"type":"session","id":"s1","timestamp":"2026-01-01T00:00:00.000Z"}\n{"type":"message","id":"m1","message":{"role":"user","content":"hi","timestamp":"${new Date(userTs).toISOString()}"}}\n`,
		"utf-8",
	);
}

describe("energy (akashic energy.py)", () => {
	it("decays on three timescales; no user message -> 0", () => {
		const now = 1_800_000_000_000;
		expect(computeEnergy(null, now)).toBe(0);
		const fresh = computeEnergy(now - 60_000, now);
		const old = computeEnergy(now - 3 * 86_400_000, now);
		expect(fresh).toBeGreaterThan(0.95);
		expect(old).toBeLessThan(fresh);
		expect(old).toBeGreaterThan(0);
	});

	it("d_energy is hunger: low energy -> high contribution", () => {
		expect(dEnergy(0.1)).toBeCloseTo(0.9);
		expect(dEnergy(0.9)).toBeCloseTo(0.1);
		expect(dEnergy(1.2)).toBe(0);
	});

	it("d_recent grows logarithmically with message count", () => {
		expect(dRecent(0)).toBe(0);
		expect(dRecent(5)).toBeCloseTo(Math.log1p(5) / Math.log1p(10));
		expect(dRecent(1000)).toBe(1);
	});

	it("nextTickFromScore: high score -> short interval, with jitter", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		expect(nextTickFromScore(0.5, { tickS1: 2400, tickS0: 4800, tickJitter: 0 })).toBe(2400);
		expect(nextTickFromScore(0.1, { tickS1: 2400, tickS0: 4800, tickJitter: 0 })).toBe(4800);
		expect(nextTickFromScore(0.5, { tickS1: 2400, tickS0: 4800, tickJitter: 0.3 })).toBe(2400); // r=1.0
		vi.restoreAllMocks();
	});
});

describe("TickScheduler (akashic ProactiveScheduler)", () => {
	it("uses energy-driven base_score and adapts the interval", () => {
		const scheduler = new TickScheduler({
			scoreWeightEnergy: 0.35,
			tickS1: 2400,
			tickS0: 4800,
			tickJitter: 0,
		});
		const now = Date.now();
		// 刚聊完(能量高 -> 饥渴度低 -> base_score 低 -> 长间隔)。
		const justTalked = scheduler.nextInterval(null, now - 60_000);
		// 很久没聊(能量低 -> 饥渴度高 -> base_score 高 -> 短间隔)。
		const longSilence = scheduler.nextInterval(null, now - 48 * 3600_000);
		expect(longSilence).toBeLessThan(justTalked);
		expect(longSilence).toBe(2400);
		expect(justTalked).toBe(4800);
	});

	it("falls back to a fixed interval without presence", () => {
		const scheduler = new TickScheduler({ fallbackIntervalSeconds: 1800 });
		expect(scheduler.nextInterval(null, null)).toBe(1800);
	});

	it("defaults score_weight_energy to 0.35 (akashic STRATEGY_PARAMS)", () => {
		const scheduler = new TickScheduler({ tickS1: 2400, tickS0: 4800, tickJitter: 0 });
		const now = Date.now();
		// 48h 无互动:energy≈0 → dEnergy≈1 → baseScore=0.35 > 0.2 → s1 档。
		expect(scheduler.nextInterval(null, now - 48 * 3600_000)).toBe(2400);
		// 1 分钟前刚聊:energy≈0.98 → dEnergy≈0.017 → baseScore≈0.006 < 0.2 → s0 档。
		expect(scheduler.nextInterval(null, now - 60_000)).toBe(4800);
	});
});

describe("Presence (akashic presence.py)", () => {
	it("persists exact last_user_at from session message timestamps", () => {
		const store = makeStore();
		const presence = new Presence(store, { sessionsDir: join(agentDir, "sessions") });
		writeSession("a.jsonl", 1_800_000_000_000);
		writeSession("b.jsonl", 1_800_100_000_000);
		expect(presence.refresh()).toBe(1_800_100_000_000);
		expect(store.getPresence("local").last_user_at).toBe(1_800_100_000_000);

		// Re-scan keeps the stored value; a newer session updates it.
		writeSession("c.jsonl", 1_800_200_000_000);
		expect(presence.refresh()).toBe(1_800_200_000_000);
	});

	it("records proactive sends", () => {
		const store = makeStore();
		const presence = new Presence(store, { sessionsDir: join(agentDir, "sessions") });
		presence.recordProactiveSent(1_800_300_000_000);
		expect(store.getPresence("local").last_proactive_at).toBe(1_800_300_000_000);
	});

	it("incremental scan re-reads only changed files (akashic record-on-write 近似)", () => {
		const store = makeStore();
		const presence = new Presence(store, { sessionsDir: join(agentDir, "sessions") });
		writeSession("a.jsonl", 1_800_000_000_000);
		expect(presence.refresh()).toBe(1_800_000_000_000);

		// 同一文件追加更新的用户消息:mtime 变化 → 重读,新时间可见。
		const dir = join(agentDir, "sessions");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "a.jsonl");
		writeFileSync(
			file,
			`{"type":"message","id":"m2","message":{"role":"user","content":"again","timestamp":"${new Date(1_800_400_000_000).toISOString()}"}}\n`,
			{ flag: "a", encoding: "utf-8" },
		);
		expect(presence.refresh()).toBe(1_800_400_000_000);
		expect(store.getPresence("local").last_user_at).toBe(1_800_400_000_000);
	});

	it("recordUserMessage updates presence without scanning (akashic record_user_message)", () => {
		const store = makeStore();
		const presence = new Presence(store, { sessionsDir: join(agentDir, "sessions") });
		presence.recordUserMessage(1_800_500_000_000);
		expect(store.getPresence("local").last_user_at).toBe(1_800_500_000_000);
		// 扫描(空目录)不会回退显式记录。
		expect(presence.refresh()).toBe(1_800_500_000_000);
		// 更早的显式记录不覆盖更新的。
		presence.recordUserMessage(1_800_400_000_000);
		expect(presence.refresh()).toBe(1_800_500_000_000);
	});
});

describe("SourceScheduler (akashic feed poller)", () => {
	it("supports tick-driven source fetches without starting a background timer", async () => {
		let now = 1_800_000_000_000;
		const persisted = new Map<string, string>();
		const fetch = vi.fn().mockResolvedValue({ received: 1, inserted: 1, duplicates: 0, quarantined: 0 });
		const onFetched = vi.fn();
		const onError = vi.fn();
		const strategy = new SourcePollStrategy(
			[{ id: "feed", fetch }],
			{ feed: 60_000 },
			60_000,
			{ now: () => new Date(now), nowMs: () => now },
			{
				getState: (key) => persisted.get(key),
				setState: (key, value) => persisted.set(key, value),
			},
			true,
		);
		strategy.start(onFetched, onError);
		await Promise.resolve();
		expect(fetch).not.toHaveBeenCalled();

		await strategy.runOnce();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(onFetched).toHaveBeenCalledWith("feed", { received: 1, inserted: 1, duplicates: 0, quarantined: 0 });
		now += 59_999;
		await strategy.runOnce();
		expect(fetch).toHaveBeenCalledTimes(1);
		now += 1;
		await strategy.runOnce();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(onError).not.toHaveBeenCalled();
		strategy.stop();
	});

	it("polls due sources and backs off failures", async () => {
		vi.useFakeTimers();
		const fetchA = vi.fn().mockResolvedValue(undefined);
		const fetchB = vi.fn().mockRejectedValue(new Error("down"));
		const onError = vi.fn();
		const scheduler = new SourceScheduler(
			[
				{ id: "a", fetch: fetchA },
				{ id: "b", fetch: fetchB },
			],
			{ intervals: { a: 60_000, b: 60_000 }, tickMs: 60_000, failureBackoff: 2 },
			async (id) => (id === "a" ? fetchA() : fetchB()),
			onError,
		);
		scheduler.start();
		expect(fetchA).toHaveBeenCalledTimes(1); // immediate first tick
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetchA).toHaveBeenCalledTimes(2);
		expect(fetchB).toHaveBeenCalledTimes(1); // b backed off after the first failure
		expect(onError).toHaveBeenCalledWith("b", expect.any(Error));

		// Backoff: b waits 2x interval after the failure; a keeps its cadence.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetchA).toHaveBeenCalledTimes(3);
		expect(fetchB).toHaveBeenCalledTimes(2); // backoff expired at 2x interval

		scheduler.stop();
	});

	it("restores last fetch and failure backoff after restart", async () => {
		vi.useFakeTimers();
		let now = 1_800_000_000_000;
		const values = new Map<string, string>();
		const stateStore = {
			getState: (key: string) => values.get(key),
			setState: (key: string, value: string) => values.set(key, value),
		};
		const clock = { now: () => new Date(now), nowMs: () => now };
		const fetch = vi.fn().mockRejectedValue(new Error("down"));
		const onError = vi.fn();
		const makeScheduler = () =>
			new SourceScheduler(
				[{ id: "feed", fetch }],
				{ intervals: { feed: 60_000 }, tickMs: 60_000, clock, stateStore },
				async () => fetch(),
				onError,
			);

		const first = makeScheduler();
		first.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).toHaveBeenCalledTimes(1);
		first.stop();
		const persisted = JSON.parse(values.get("sourceScheduler.feed") ?? "{}");
		expect(persisted).toMatchObject({ lastFetchedAt: now, consecutiveFailures: 1 });

		const second = makeScheduler();
		second.start();
		expect(fetch).toHaveBeenCalledTimes(1); // restart does not bypass backoff
		now += 120_000;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetch).toHaveBeenCalledTimes(2);
		second.stop();
	});
});

describe("ProactiveStore state (akashic state.py)", () => {
	it("dedups deliveries by content, message and recent-N", () => {
		const store = makeStore();
		const refs = JSON.stringify([{ id: 7 }]);
		store.insertDelivery({
			session_key: "local",
			message: "第一条消息",
			message_hash: "hash-1",
			source_refs: refs,
			evidence: "[]",
			action: "send",
			state_summary_tag: "none",
			delivered_at: Date.now(),
		});
		store.ackDeliveries([1]);
		expect(store.isContentDelivered(["7"], 24)).toBe(true);
		expect(store.isContentDelivered(["8"], 24)).toBe(false);
		expect(store.isMessageDelivered("hash-1", 24)).toBe(true);
		expect(store.recentDeliveredMessages(5)).toEqual(["第一条消息"]);
	});

	it("counts daily quotas and logs ticks", () => {
		const store = makeStore();
		expect(store.incrementDailyCount("context_only")).toBe(1);
		expect(store.incrementDailyCount("context_only")).toBe(2);
		expect(store.getDailyCount("context_only")).toBe(2);

		const id = store.recordTickLog({
			session_key: "local",
			started_at: 1,
			finished_at: null,
			base_score: null,
			candidates: 3,
			steps: 0,
			action: "none",
			skip_reason: "",
			error: null,
		});
		store.finishTickLog(id, {
			finished_at: 2,
			base_score: 0.5,
			steps: 4,
			action: "send",
			skip_reason: "",
			error: null,
		});
	});

	it("acks deliveries for the outlet", () => {
		const store = makeStore();
		const acknowledged: Array<{ message: string; at: number }> = [];
		store.onDeliveryAcknowledged((record, at) => acknowledged.push({ message: record.message, at }));
		store.insertDelivery({
			session_key: "local",
			message: "待确认",
			message_hash: "h",
			source_refs: "[]",
			evidence: "[]",
			action: "send",
			state_summary_tag: "none",
			delivered_at: 1,
		});
		expect(store.listPendingDeliveries().length).toBe(1);
		store.ackDeliveries([1]);
		expect(store.listPendingDeliveries().length).toBe(0);
		expect(acknowledged).toEqual([{ message: "待确认", at: expect.any(Number) }]);
	});
});
