/**
 * Phase 3 — default 生命周期模块化集成测试。
 *
 * 通过 ProactiveEngine 驱动完整模块链(gate → sense → route → judge → resolve
 * → commit → schedule),验证行为与旧 engine.tick 一致:tick 日志、终局事件、
 * 各分支(action/skip_reason/base_score)。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Delivered, EventBus, ProactiveFinished } from "../src/bus.ts";
import { ProactiveEngine } from "../src/engine.ts";
import type { ProactiveFrame } from "../src/ext/frame.ts";
import { ProactiveKernel } from "../src/ext/kernel.ts";
import { ProactiveLifecycleSpec } from "../src/ext/lifecycle.ts";
import { defaultLifecycleSpec } from "../src/lifecycles/default/index.ts";
import { buildDefaultModules } from "../src/lifecycles/default/modules.ts";
import { DefaultRuntime } from "../src/lifecycles/default/runtime.ts";
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
import { ProactiveStore } from "../src/store.ts";

let tempDir = "";
let store: ProactiveStore;

const SENSE_STATE: SenseState = { lastUserAt: null, lastProactiveAt: null, energy: 0.3, baseScore: 0.8 };

function makeStages(
	overrides: Partial<{
		gateBlocked: string;
		judgeVerdict: JudgeVerdict;
		idleHandled: boolean;
		message: string | null;
		delivered: boolean;
	}> = {},
) {
	const sense = vi.fn<() => Promise<SenseState>>().mockResolvedValue(SENSE_STATE);
	const schedule = vi.fn<(state: SenseState) => number>().mockReturnValue(120);
	const judge = vi
		.fn<(items: never[], ctx: TurnContext) => Promise<JudgeVerdict>>()
		.mockResolvedValue(
			overrides.judgeVerdict ?? { action: "skip", itemIds: [], evidence: [], skipReason: "stub", stepsTaken: 0 },
		);
	const resolve = vi
		.fn<(evidence: Evidence[], ctx: TurnContext) => Promise<string | null>>()
		.mockResolvedValue(overrides.message ?? null);
	const deliver = vi
		.fn<() => Promise<{ delivered: boolean }>>()
		.mockResolvedValue({ delivered: overrides.delivered ?? false });
	const idle = vi.fn<(ctx: TurnContext) => Promise<boolean>>().mockResolvedValue(overrides.idleHandled ?? false);
	const fetch = { id: "stub", start: vi.fn(), stop: vi.fn() } as unknown as FetchStrategy;
	const prefetch = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
	const gate = {
		id: "stub",
		check: vi
			.fn()
			.mockReturnValue(
				overrides.gateBlocked
					? { blocked: true, reason: overrides.gateBlocked, baseScore: null, contextAsFallbackOpen: false }
					: { blocked: false, reason: "passed", baseScore: null, contextAsFallbackOpen: false },
			),
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

async function runOneTick(
	stages: ProactiveStages,
	eventBus?: EventBus,
): Promise<{ action: string; skip_reason: string; base_score: number | null }> {
	const engine = new ProactiveEngine(stages, store, {
		rules: new ProactiveRules(join(tempDir, "PROACTIVE_CONTEXT.md")),
		eventBus,
	});
	await (engine as unknown as { tick(): Promise<unknown> }).tick();
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

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "lifecycle-default-"));
	store = new ProactiveStore(join(tempDir, "t.sqlite"));
});

function insertCandidate(): void {
	store.insertItem({
		scope: "",
		source: "dailyhot",
		sub_source: "github",
		title: "deepseek 发布新模型",
		url: "https://example.com/1",
		summary: "新模型支持更长上下文",
		title_hash: "h1",
		interest_score: null,
		recommendation: null,
		verdict: null,
		verdict_reason: null,
		fetched_at: Date.now(),
	});
}

afterEach(() => {
	store.close();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("default lifecycle tick chain", () => {
	it("ends the tick at the gate when blocked (no sense/judge)", async () => {
		const { stages, sense, judge } = makeStages({ gateBlocked: "cooldown" });
		const log = await runOneTick(stages);
		expect(log).toEqual({ action: "none", skip_reason: "cooldown", base_score: null });
		expect(sense).not.toHaveBeenCalled();
		expect(judge).not.toHaveBeenCalled();
	});

	it("routes to drift on empty candidates and records base_score 0", async () => {
		const { stages, idle } = makeStages({ idleHandled: true });
		const log = await runOneTick(stages);
		expect(log).toEqual({ action: "drift", skip_reason: "", base_score: 0 });
		expect(idle).toHaveBeenCalledTimes(1);
	});

	it("judges and delivers a send verdict", async () => {
		const bus = new EventBus();
		const finished: ProactiveFinished[] = [];
		const delivered: Delivered[] = [];
		bus.on(ProactiveFinished, (e) => {
			finished.push(e);
		});
		bus.on(Delivered, (e) => {
			delivered.push(e);
		});
		const { stages, judge, resolve, deliver } = makeStages({
			judgeVerdict: {
				action: "send",
				itemIds: [1],
				evidence: [{ id: "e1", itemId: 1, source: "dailyhot", title: "t", snippet: "s", url: "" }],
				skipReason: "",
				stepsTaken: 3,
			},
			message: "值得一看:deepseek 发布新模型",
			delivered: true,
		});
		insertCandidate();
		const log = await runOneTick(stages, bus);
		expect(log).toEqual({ action: "send", skip_reason: "", base_score: 0.8 });
		expect(judge).toHaveBeenCalledTimes(1);
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(finished).toHaveLength(1);
		expect(finished[0].action).toBe("send");
		expect(delivered).toHaveLength(1);
		expect(delivered[0].message).toBe("值得一看:deepseek 发布新模型");
	});

	it("keeps context_only as the terminal action", async () => {
		insertCandidate();
		const { stages } = makeStages({
			judgeVerdict: { action: "context_only", itemIds: [], evidence: [], skipReason: "", stepsTaken: 1 },
		});
		const log = await runOneTick(stages);
		expect(log.action).toBe("context_only");
		expect(store.getState("lastContextOnly")).not.toBeNull();
	});

	it("records judgment audit fields in tick_log (akashic interesting/discarded/cited/llm_count)", async () => {
		insertCandidate();
		const { stages } = makeStages({
			judgeVerdict: {
				action: "send",
				itemIds: [1],
				evidence: [{ id: "e1", itemId: 1, source: "dailyhot", title: "t", snippet: "s", url: "" }],
				skipReason: "",
				stepsTaken: 3,
				discardedItemIds: [2],
				citedItemIds: [1],
				llmCallCount: 2,
			},
			message: "值得一看",
			delivered: true,
		});
		await runOneTick(stages);
		const db = new DatabaseSync(join(tempDir, "t.sqlite"), { readOnly: true });
		try {
			const row = db
				.prepare(
					`SELECT interesting_ids, discarded_ids, cited_ids, drift_entered, final_message, llm_call_count
					 FROM tick_log ORDER BY id DESC LIMIT 1`,
				)
				.get() as {
				interesting_ids: string;
				discarded_ids: string;
				cited_ids: string;
				drift_entered: number;
				final_message: string;
				llm_call_count: number;
			};
			expect(JSON.parse(row.interesting_ids)).toEqual([1]);
			expect(JSON.parse(row.discarded_ids)).toEqual([2]);
			expect(JSON.parse(row.cited_ids)).toEqual([1]);
			expect(row.drift_entered).toBe(0);
			expect(row.final_message).toBe("值得一看");
			expect(row.llm_call_count).toBe(2);
		} finally {
			db.close();
		}
	});

	it("records a resolved message even when delivery dedupes", async () => {
		const { stages, deliver } = makeStages({
			judgeVerdict: {
				action: "send",
				itemIds: [1],
				evidence: [{ id: "e1", itemId: 1, source: "dailyhot", title: "t", snippet: "s", url: "" }],
				skipReason: "",
				stepsTaken: 1,
			},
			message: "hello",
			delivered: false,
		});
		insertCandidate();
		const log = await runOneTick(stages);
		expect(log).toEqual({ action: "send", skip_reason: "", base_score: 0.8 });
		expect(deliver).toHaveBeenCalledTimes(1);
	});
});

describe("default lifecycle module graph", () => {
	it("compiles the default lifecycle with the expected module order", async () => {
		const runtime = new DefaultRuntime({
			stages: makeStages().stages,
			store,
			rules: new ProactiveRules(join(tempDir, "PROACTIVE_CONTEXT.md")),
			contextOnlyDailyMax: 1,
		});
		const kernel = new ProactiveKernel(buildDefaultModules(runtime), {
			lifecycle: defaultLifecycleSpec,
		});
		const inspect = kernel.inspect();
		expect(inspect).toContain("lifecycle=default");
		const order = [
			"proactive.run.start",
			"proactive.admission.collect",
			"proactive.sense",
			"proactive.prompt.collect",
			"proactive.route",
			"proactive.judge",
			"proactive.resolve",
			"proactive.commit",
			"proactive.schedule",
		];
		const positions = order.map((slot) => inspect.indexOf(slot));
		expect(positions.every((pos) => pos >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	});

	it("rejects a lifecycle missing the terminal slot producer", () => {
		expect(
			() =>
				new ProactiveKernel([], {
					lifecycle: new ProactiveLifecycleSpec("default", [], [], ["run:missing"]),
				}),
		).toThrow(/terminal slot has no producer/);
	});

	it("collects plugin prompt/effect slots into the judge context and tick audit (akashic proactive.prompt.collect)", async () => {
		insertCandidate();
		const { stages, judge } = makeStages({
			judgeVerdict: { action: "skip", itemIds: [], evidence: [], skipReason: "stub", stepsTaken: 0 },
		});
		// 插件模块:写入 system_bottom 段与 effect 记录(akashic
		// proactive:prompt:system_bottom:* / proactive:effect:* 数据 slot)。
		const pluginModule = {
			slot: "my.plugin.state",
			produces: ["proactive:prompt:system_bottom:my-rules", "proactive:effect:note"] as const,
			run: (frame: ProactiveFrame) => {
				frame.slots["proactive:prompt:system_bottom:my-rules"] = "插件规则:凌晨不推送";
				frame.slots["proactive:effect:note"] = { type: "plugin", detail: "采集了一次" };
				return frame;
			},
		};
		const runtime = new DefaultRuntime({
			stages,
			store,
			rules: new ProactiveRules(join(tempDir, "PROACTIVE_CONTEXT.md")),
			contextOnlyDailyMax: 1,
		});
		const kernel = new ProactiveKernel([...buildDefaultModules(runtime), pluginModule], {
			lifecycle: defaultLifecycleSpec,
		});
		await kernel.runTickResult("local");

		// 插件段进入 judge 上下文(TurnContext.promptSections)。
		const judgeCtx = judge.mock.calls[0]?.[1] as TurnContext | undefined;
		expect(judgeCtx?.promptSections).toEqual(["插件规则:凌晨不推送"]);
		// effect 记录进入 tick 审计(effects_json)。
		const db = new DatabaseSync(join(tempDir, "t.sqlite"), { readOnly: true });
		try {
			const row = db.prepare("SELECT effects_json FROM tick_log ORDER BY id DESC LIMIT 1").get() as {
				effects_json: string;
			};
			expect(JSON.parse(row.effects_json)).toEqual([{ type: "plugin", detail: "采集了一次" }]);
		} finally {
			db.close();
		}
	});
});
