import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProactiveEngine } from "../src/engine.ts";
import { ProactiveRules } from "../src/rules.ts";
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
import type { ProactiveItem } from "../src/store.ts";
import { ProactiveStore } from "../src/store.ts";

let tempDir = "";
let store: ProactiveStore;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "tick-schedule-"));
	store = new ProactiveStore(join(tempDir, "t.sqlite"));
});

afterEach(() => {
	store.close();
	rmSync(tempDir, { recursive: true, force: true });
	vi.useRealTimers();
});

const SENSE_STATE: SenseState = { lastUserAt: null, lastProactiveAt: null, energy: 0.3, baseScore: 0.8 };

function makeStages() {
	const sense = vi.fn<() => Promise<SenseState>>().mockResolvedValue(SENSE_STATE);
	const schedule = vi.fn<(state: SenseState) => number>().mockReturnValue(120);
	const judge = vi
		.fn<(items: ProactiveItem[], ctx: TurnContext) => Promise<JudgeVerdict>>()
		.mockResolvedValue({ action: "skip", itemIds: [], evidence: [], skipReason: "stub", stepsTaken: 0 });
	const resolve = vi.fn<(evidence: Evidence[], ctx: TurnContext) => Promise<string | null>>().mockResolvedValue(null);
	const deliver = vi.fn<() => Promise<{ delivered: boolean }>>().mockResolvedValue({ delivered: false });
	const idle = vi.fn<(ctx: TurnContext) => Promise<boolean>>().mockResolvedValue(true);
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
		schedule: {
			id: "stub",
			nextInterval: schedule,
			traceContext: () => ({ tick_interval_s0: 4800, tick_interval_s1: 2400, tick_jitter: 0.3 }),
		} as unknown as ScheduleStrategy,
		fetch,
		prefetch: { id: "stub", prefetch } as unknown as PrefetchStrategy,
		judge: { id: "stub", judge } as unknown as JudgeStrategy,
		resolve: { id: "stub", resolve } as unknown as ResolveStrategy,
		deliver: { id: "stub", deliver } as unknown as DeliverStrategy,
		idle: { id: "stub", run: idle } as unknown as IdleStrategy,
	};
	return { stages, sense, schedule, judge, resolve, deliver, idle, gate };
}

function newEngine(stages: ProactiveStages): Promise<{ stop: () => Promise<void> }> {
	return new ProactiveEngine(stages, store, {
		rules: new ProactiveRules(join(tempDir, "PROACTIVE_CONTEXT.md")),
	}).start();
}

describe("closed-loop scheduling (akashic loop.py port)", () => {
	it("runs the first tick immediately and schedules the next interval from the tick result", async () => {
		vi.useFakeTimers();
		const { stages, schedule, idle } = makeStages();
		const { stop } = await newEngine(stages);
		try {
			// 首轮立即 tick:不经过 schedule 策略。
			expect(schedule).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(0);
			// 空候选 → idle 处理(drift)→ 终局 base_score=0 → 下一次间隔按 0 计算,
			// 而不是 sense 阶段的 0.8。
			expect(idle).toHaveBeenCalledTimes(1);
			expect(schedule).toHaveBeenCalledTimes(1);
			expect(schedule.mock.calls[0][0].baseScore).toBe(0);
		} finally {
			await stop();
			vi.useRealTimers();
		}
	});

	it("waits the tick-result interval before the next tick", async () => {
		vi.useFakeTimers();
		const { stages, idle } = makeStages();
		const { stop } = await newEngine(stages);
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(idle).toHaveBeenCalledTimes(1);
			// 间隔 120s:60s 时不应触发第二次 tick。
			await vi.advanceTimersByTimeAsync(60_000);
			expect(idle).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(idle).toHaveBeenCalledTimes(2);
		} finally {
			await stop();
			vi.useRealTimers();
		}
	});

	it("falls back to presence-driven scheduling when a tick errors", async () => {
		vi.useFakeTimers();
		const { stages, schedule, judge } = makeStages();
		judge.mockRejectedValue(new Error("boom"));
		// 需要候选,否则 judge 不会被调用。
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
		const { stop } = await newEngine(stages);
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(judge).toHaveBeenCalledTimes(1);
			// tick 异常 → 不使用 tick 结果,回退到 sense 的 base_score(0.8)。
			expect(schedule).toHaveBeenCalledTimes(1);
			expect(schedule.mock.calls[0][0].baseScore).toBe(0.8);
			expect(store.getState("lastError.tick")).toContain("boom");
		} finally {
			await stop();
			vi.useRealTimers();
		}
	});

	it("writes rate trace with fixed_no_presence mode and scheduler params (akashic trace)", async () => {
		vi.useFakeTimers();
		const { stages } = makeStages();
		const tracePath = join(tempDir, "traces", "proactive_rate_trace.jsonl");
		const engine = new ProactiveEngine(stages, store, {
			rules: new ProactiveRules(join(tempDir, "PROACTIVE_CONTEXT.md")),
			tracePath,
		});
		const { stop } = await engine.start();
		try {
			await vi.advanceTimersByTimeAsync(0);
		} finally {
			await stop();
			vi.useRealTimers();
		}
		const lines = readFileSync(tracePath, "utf-8").trim().split("\n");
		const rate = JSON.parse(lines[0]!) as { trace_type: string; payload: Record<string, unknown> };
		expect(rate.trace_type).toBe("proactive_rate");
		// SENSE_STATE.lastUserAt 为 null → fixed_no_presence 模式(akashic 同)。
		expect(rate.payload.mode).toBe("fixed_no_presence");
		// 调度参数进 payload(akashic rate trace 同)。
		expect(rate.payload.tick_interval_s0).toBe(4800);
		expect(rate.payload.tick_interval_s1).toBe(2400);
		expect(rate.payload.tick_jitter).toBe(0.3);
		// 启动时配置快照 trace(akashic proactive_config_trace.jsonl)。
		const configTrace = readFileSync(join(tempDir, "traces", "proactive_config_trace.jsonl"), "utf-8");
		expect(JSON.parse(configTrace).trace_type).toBe("proactive_config");
	});
});
