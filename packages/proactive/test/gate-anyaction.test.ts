import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProactiveEngine } from "../src/engine.ts";
import { ProactiveRules } from "../src/rules.ts";
import { AnyActionGate } from "../src/stages/anyaction.ts";
import { GateChain } from "../src/stages/gate.ts";
import type {
	DeliverStrategy,
	Evidence,
	FetchStrategy,
	GateStrategy,
	IdleStrategy,
	JudgeStrategy,
	JudgeVerdict,
	PrefetchStrategy,
	PresenceStrategy,
	ProactiveStages,
	ResolveStrategy,
	ScheduleStrategy,
	SenseState,
	TurnContext,
} from "../src/stages/types.ts";
import { ProactiveStore } from "../src/store.ts";

let tempDir = "";
let store: ProactiveStore;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "gate-anyaction-"));
	store = new ProactiveStore(join(tempDir, "t.sqlite"));
});

afterEach(() => {
	store.close();
	rmSync(tempDir, { recursive: true, force: true });
	vi.useRealTimers();
});

const DEFAULT_ANYACTION = {
	dailyMaxActions: 24,
	minIntervalSeconds: 300,
	probabilityMin: 0.03,
	probabilityMax: 0.45,
	idleScaleMinutes: 240,
	resetHourLocal: 12,
	timezone: "UTC",
};

describe("GateChain (akashic ProactiveGateChain port)", () => {
	it("blocks the tick during the delivery cooldown window", () => {
		const deliveryId = store.insertDelivery({
			session_key: "local",
			message: "刚推过",
			message_hash: "h",
			source_refs: "[]",
			evidence: "[]",
			action: "send",
			state_summary_tag: "none",
			delivered_at: Date.now(),
		});
		store.ackDeliveries([deliveryId]);
		const gate = new GateChain(store, {
			deliveryCooldownHours: 1,
			anyAction: null,
			contextOnly: { probability: 0.03, minIntervalHours: 12, dailyMax: 1 },
		});
		expect(gate.check(new Date())).toMatchObject({ blocked: true, reason: "cooldown" });
	});

	it("passes when nothing blocks and the context roll fails", () => {
		const gate = new GateChain(store, {
			deliveryCooldownHours: 1,
			anyAction: null,
			contextOnly: { probability: 0.03, minIntervalHours: 12, dailyMax: 1 },
			rng: () => 0.5, // 0.5 >= 0.03 → context 兜底不开放
		});
		expect(gate.check(new Date())).toEqual({
			blocked: false,
			reason: "passed",
			baseScore: null,
			contextAsFallbackOpen: false,
		});
	});

	it("opens the context fallback when the roll passes and limits allow", () => {
		const gate = new GateChain(store, {
			deliveryCooldownHours: 1,
			anyAction: null,
			contextOnly: { probability: 0.03, minIntervalHours: 12, dailyMax: 1 },
			rng: () => 0.01,
		});
		expect(gate.check(new Date()).contextAsFallbackOpen).toBe(true);
	});

	it("closes the context fallback when the 24h max is reached", () => {
		store.markContextOnlySend("local");
		const gate = new GateChain(store, {
			deliveryCooldownHours: 1,
			anyAction: null,
			contextOnly: { probability: 0.03, minIntervalHours: 12, dailyMax: 1 },
			rng: () => 0.01,
		});
		expect(gate.check(new Date()).contextAsFallbackOpen).toBe(false);
	});

	it("blocks via the anyaction gate when it is enabled and refuses", () => {
		const gate = new GateChain(store, {
			deliveryCooldownHours: 1,
			anyAction: { ...DEFAULT_ANYACTION, dailyMaxActions: 1 },
			contextOnly: { probability: 0, minIntervalHours: 12, dailyMax: 1 },
			rng: () => 0.5,
		});
		// 无 last_user_at → idle=480min → pAct≈0.39 < 0.5 → 拒绝。
		expect(gate.check(new Date())).toMatchObject({ blocked: true, reason: "presence" });
	});
});

describe("AnyActionGate (akashic anyaction.py port)", () => {
	it("refuses when the daily quota is exhausted", () => {
		const gate = new AnyActionGate({ ...DEFAULT_ANYACTION, dailyMaxActions: 2 }, store, () => 0);
		gate.recordAction(new Date());
		gate.recordAction(new Date());
		const { shouldAct, meta } = gate.shouldAct(new Date(), null);
		expect(shouldAct).toBe(false);
		expect(meta.reason).toBe("quota_exhausted");
		expect(meta.remainingToday).toBe(0);
	});

	it("refuses within the minimum interval after the last action", () => {
		const gate = new AnyActionGate({ ...DEFAULT_ANYACTION, minIntervalSeconds: 300 }, store, () => 0);
		gate.recordAction(new Date("2026-01-01T00:00:00Z"));
		const { shouldAct, meta } = gate.shouldAct(new Date("2026-01-01T00:02:00Z"), null);
		expect(shouldAct).toBe(false);
		expect(meta.reason).toBe("min_interval");
	});

	it("raises the action probability with idle time", () => {
		const gate = new AnyActionGate(DEFAULT_ANYACTION, store, () => 0.1);
		const now = new Date("2026-01-01T12:00:00Z");
		// 刚聊过(1 分钟):pAct≈0.03 → 0.1 抽签失败。
		expect(gate.shouldAct(now, now.getTime() - 60_000).shouldAct).toBe(false);
		// 静默 2 小时:pAct≈0.20 → 0.1 抽签通过。
		expect(gate.shouldAct(now, now.getTime() - 2 * 3600_000).shouldAct).toBe(true);
	});

	it("persists quota and rolls the window at the local reset hour", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T04:00:00Z")); // UTC 4 点 < 12 点重置
		const gate = new AnyActionGate({ ...DEFAULT_ANYACTION, dailyMaxActions: 2 }, store, () => 0);
		gate.recordAction(new Date());
		gate.recordAction(new Date());
		expect(gate.shouldAct(new Date(), null).meta.reason).toBe("quota_exhausted");
		expect(store.getState("anyaction.quota")).toContain('"used":2');
		// 跨过本地 12 点 → 新窗口,配额清零。
		vi.setSystemTime(new Date("2026-01-01T13:00:00Z"));
		const meta = gate.shouldAct(new Date(), null).meta;
		expect(meta.usedToday).toBe(0);
		expect(meta.remainingToday).toBe(2);
	});
});

describe("engine gate integration", () => {
	const SENSE_STATE: SenseState = { lastUserAt: null, lastProactiveAt: null, energy: 0.3, baseScore: 0.8 };

	function makeStages() {
		const sense = vi.fn<() => Promise<SenseState>>().mockResolvedValue(SENSE_STATE);
		const schedule = vi.fn<(state: SenseState) => number>().mockReturnValue(120);
		const judge = vi
			.fn<(items: never[], ctx: TurnContext) => Promise<JudgeVerdict>>()
			.mockResolvedValue({ action: "skip", itemIds: [], evidence: [], skipReason: "stub", stepsTaken: 0 });
		const resolve = vi
			.fn<(evidence: Evidence[], ctx: TurnContext) => Promise<string | null>>()
			.mockResolvedValue(null);
		const deliver = vi.fn<() => Promise<{ delivered: boolean }>>().mockResolvedValue({ delivered: false });
		const idle = vi.fn<(ctx: TurnContext) => Promise<boolean>>().mockResolvedValue(false);
		const fetch = { id: "stub", start: vi.fn(), stop: vi.fn() } as unknown as FetchStrategy;
		const prefetch = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const gate = {
			id: "stub",
			check: vi
				.fn()
				.mockReturnValue({ blocked: false, reason: "passed", baseScore: null, contextAsFallbackOpen: false }),
			recordAction: vi.fn(),
		} as unknown as GateStrategy;
		const stages: ProactiveStages = {
			gate,
			sense: { id: "stub", sense, recordProactiveSent: vi.fn() } as unknown as PresenceStrategy,
			schedule: { id: "stub", nextInterval: schedule } as unknown as ScheduleStrategy,
			fetch,
			prefetch: { id: "stub", prefetch } as unknown as PrefetchStrategy,
			judge: { id: "stub", judge } as unknown as JudgeStrategy,
			resolve: { id: "stub", resolve } as unknown as ResolveStrategy,
			deliver: { id: "stub", deliver } as unknown as DeliverStrategy,
			idle: { id: "stub", run: idle } as unknown as IdleStrategy,
		};
		return { stages, sense, schedule, judge, resolve, deliver, idle, gate };
	}

	async function runOneTick(stages: ProactiveStages): Promise<void> {
		const engine = new ProactiveEngine(stages, store, {
			rules: new ProactiveRules(join(tempDir, "PROACTIVE_CONTEXT.md")),
		});
		await (engine as unknown as { tick(): Promise<unknown> }).tick();
	}

	function lastTickLog(): { action: string; skip_reason: string; base_score: number | null } {
		const db = new DatabaseSync(join(tempDir, "t.sqlite"), { readOnly: true });
		try {
			return db.prepare("SELECT action, skip_reason, base_score FROM tick_log ORDER BY id DESC LIMIT 1").get() as {
				action: string;
				skip_reason: string;
				base_score: number | null;
			};
		} finally {
			db.close();
		}
	}

	it("ends the tick without judging when the gate blocks", async () => {
		const { stages, judge, gate } = makeStages();
		(gate.check as ReturnType<typeof vi.fn>).mockReturnValue({
			blocked: true,
			reason: "cooldown",
			baseScore: null,
			contextAsFallbackOpen: false,
		});
		await runOneTick(stages);
		expect(judge).not.toHaveBeenCalled();
		expect(store.getState("lastError.tick")).toBeUndefined();
		const log = lastTickLog();
		expect(log.action).toBe("none");
		expect(log.skip_reason).toBe("cooldown");
		expect(log.base_score).toBeNull();
	});

	it("records an anyaction quota hit after a successful delivery", async () => {
		store.insertItem({
			scope: "",
			source: "t",
			sub_source: "t",
			title: "候选",
			url: null,
			summary: null,
			recommendation: null,
			verdict: null,
			verdict_reason: null,
			title_hash: "h1",
			interest_score: null,
			fetched_at: Date.now(),
		});
		const { stages, deliver, gate } = makeStages();
		deliver.mockResolvedValue({ delivered: true });
		stages.resolve = {
			id: "stub",
			resolve: vi.fn().mockResolvedValue("要发送的消息") as unknown as ResolveStrategy["resolve"],
		};
		stages.judge = {
			id: "stub",
			judge: vi.fn().mockResolvedValue({
				action: "send",
				itemIds: [1],
				evidence: [{ id: "ev1", itemId: 1, source: "t", title: "候选", snippet: "s", url: "" }],
				skipReason: "",
				stepsTaken: 1,
			}) as unknown as JudgeStrategy["judge"],
		};
		await runOneTick(stages);
		expect(gate.recordAction).toHaveBeenCalledTimes(1);
	});

	it("records an anyaction quota hit when idle enters drift", async () => {
		const { stages, idle, gate } = makeStages();
		idle.mockResolvedValue(true);
		await runOneTick(stages);
		expect(idle).toHaveBeenCalledTimes(1);
		expect(gate.recordAction).toHaveBeenCalledTimes(1);
	});

	it("passes contextAsFallbackOpen to the judge context", async () => {
		store.insertItem({
			scope: "",
			source: "t",
			sub_source: "t",
			title: "候选",
			url: null,
			summary: null,
			recommendation: null,
			verdict: null,
			verdict_reason: null,
			title_hash: "h2",
			interest_score: null,
			fetched_at: Date.now(),
		});
		const { stages, gate } = makeStages();
		(gate.check as ReturnType<typeof vi.fn>).mockReturnValue({
			blocked: false,
			reason: "passed",
			baseScore: null,
			contextAsFallbackOpen: true,
		});
		const judgeMock = vi.fn(async (_items: never[], ctx: TurnContext) => {
			expect(ctx.contextAsFallbackOpen).toBe(true);
			return { action: "skip", itemIds: [], evidence: [], skipReason: "stub", stepsTaken: 0 } as JudgeVerdict;
		});
		stages.judge = { id: "stub", judge: judgeMock as unknown as JudgeStrategy["judge"] };
		await runOneTick(stages);
		expect(judgeMock).toHaveBeenCalledTimes(1);
	});
});
