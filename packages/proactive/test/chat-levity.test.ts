/**
 * Phase 1.5 — 空候选"轻松挑起话题"分支(akashic get_recent_chat 低概率路径)。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { ProactiveStore } from "../src/store.ts";

let tempDir = "";
let store: ProactiveStore;

const SENSE_STATE: SenseState = { lastUserAt: null, lastProactiveAt: null, energy: 0.3, baseScore: 0.8 };

function makeStages(overrides: { judgeVerdict?: JudgeVerdict; gateContextOpen?: boolean; idleHandled?: boolean } = {}) {
	const judge = vi.fn<(items: never[], ctx: TurnContext) => Promise<JudgeVerdict>>().mockResolvedValue(
		overrides.judgeVerdict ?? {
			action: "skip",
			itemIds: [],
			evidence: [],
			skipReason: "no_content",
			stepsTaken: 0,
		},
	);
	const resolve = vi.fn<(evidence: Evidence[], ctx: TurnContext) => Promise<string | null>>().mockResolvedValue(null);
	const deliver = vi.fn<() => Promise<{ delivered: boolean }>>().mockResolvedValue({ delivered: true });
	const idle = vi.fn<(ctx: TurnContext) => Promise<boolean>>().mockResolvedValue(overrides.idleHandled ?? false);
	const gate = {
		id: "stub",
		check: vi.fn().mockReturnValue({
			blocked: false,
			reason: "passed",
			baseScore: null,
			contextAsFallbackOpen: overrides.gateContextOpen ?? true,
		}),
		recordAction: vi.fn(),
	} as unknown as GateStrategy;
	const stages: ProactiveStages = {
		gate,
		sense: { id: "stub", sense: vi.fn().mockResolvedValue(SENSE_STATE) } as unknown as PresenceStrategy,
		schedule: { id: "stub", nextInterval: vi.fn().mockReturnValue(120) } as unknown as ScheduleStrategy,
		fetch: { id: "stub", start: vi.fn(), stop: vi.fn() } as unknown as FetchStrategy,
		prefetch: { id: "stub", prefetch: vi.fn() } as unknown as PrefetchStrategy,
		judge: { id: "stub", judge } as unknown as JudgeStrategy,
		resolve: { id: "stub", resolve } as unknown as ResolveStrategy,
		deliver: { id: "stub", deliver } as unknown as DeliverStrategy,
		idle: { id: "stub", run: idle } as unknown as IdleStrategy,
	};
	return { stages, judge, deliver, idle };
}

async function runOneTick(
	stages: ProactiveStages,
	options: { chatLevity?: boolean; chatLevityProbability?: number } = {},
): Promise<{ action: string; skip_reason: string }> {
	const recentMessages = vi.fn().mockResolvedValue([
		{ role: "user" as const, content: "最近在追一部剧" },
		{ role: "assistant" as const, content: "好看吗" },
	]);
	const engine = new ProactiveEngine(stages, store, {
		rules: new ProactiveRules(join(tempDir, "PROACTIVE_CONTEXT.md")),
		runtimePorts: { session: { recentMessages } },
		chatLevity: options.chatLevity,
		chatLevityProbability: options.chatLevityProbability,
	});
	await (engine as unknown as { tick(): Promise<unknown> }).tick();
	const db = new DatabaseSync(join(tempDir, "t.sqlite"), { readOnly: true });
	try {
		return db.prepare("SELECT action, skip_reason FROM tick_log ORDER BY id DESC LIMIT 1").get() as {
			action: string;
			skip_reason: string;
		};
	} finally {
		db.close();
	}
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "chat-levity-"));
	store = new ProactiveStore(join(tempDir, "t.sqlite"));
});

afterEach(() => {
	store.close();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("chat-levity 空候选闲聊分支", () => {
	it("sends a context_only draft message when the branch is open and the draw hits", async () => {
		const { stages, judge, deliver } = makeStages({
			judgeVerdict: {
				action: "context_only",
				itemIds: [],
				evidence: [],
				skipReason: "",
				stepsTaken: 1,
				draftMessage: "那部剧看到第几集啦?",
			},
		});
		const log = await runOneTick(stages, { chatLevity: true, chatLevityProbability: 1 });
		expect(log.action).toBe("context_only");
		expect(judge).toHaveBeenCalledTimes(1);
		expect(deliver).toHaveBeenCalledTimes(1);
		// 投递消息使用判题草稿。
		expect(deliver).toHaveBeenCalledWith(
			expect.objectContaining({ message: "那部剧看到第几集啦?" }),
			expect.anything(),
		);
		// context_only 兜底计数生效。
		expect(store.getState("lastContextOnly")).not.toBeNull();
	});

	it("falls back to idle when chatLevity is disabled", async () => {
		const { stages, judge, idle } = makeStages();
		const log = await runOneTick(stages, { chatLevity: false });
		expect(log.action).toBe("none");
		expect(log.skip_reason).toBe("no_candidates");
		expect(judge).not.toHaveBeenCalled();
		expect(idle).toHaveBeenCalledTimes(1);
	});

	it("falls back to idle when the probability draw misses", async () => {
		const { stages, judge } = makeStages();
		const log = await runOneTick(stages, { chatLevity: true, chatLevityProbability: 0 });
		expect(log.skip_reason).toBe("no_candidates");
		expect(judge).not.toHaveBeenCalled();
	});

	it("falls back to idle when the judge skips (no draft)", async () => {
		const { stages, judge, idle } = makeStages({
			judgeVerdict: { action: "skip", itemIds: [], evidence: [], skipReason: "no_content", stepsTaken: 1 },
		});
		const log = await runOneTick(stages, { chatLevity: true, chatLevityProbability: 1 });
		expect(log.skip_reason).toBe("no_candidates");
		expect(judge).toHaveBeenCalledTimes(1);
		expect(idle).toHaveBeenCalledTimes(1);
	});
});
