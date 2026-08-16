import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ProactiveEngine } from "../src/engine.ts";
import { createDefaultStages, type DefaultStagesDeps } from "../src/stages/defaults.ts";
import { Presence } from "../src/stages/sense.ts";
import { ProactiveStore } from "../src/store.ts";

const tempDirs: string[] = [];

function makeStore(): { store: ProactiveStore; dbPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "tick-steps-"));
	tempDirs.push(dir);
	const dbPath = join(dir, "t.sqlite");
	return { store: new ProactiveStore(dbPath), dbPath };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tick steps", () => {
	it("store records and lists tick steps", () => {
		const { store } = makeStore();
		const tickId = store.recordTickLog({
			session_key: "local",
			started_at: 1,
			finished_at: null,
			base_score: null,
			candidates: 0,
			steps: 0,
			action: "none",
			skip_reason: "",
			error: null,
		});
		store.recordTickStep({
			tick_id: tickId,
			step_index: 0,
			phase: "sense",
			detail: "候选 3 条",
			action_after: "judge",
			skip_reason_after: "",
			duration_ms: 5,
		});
		store.recordTickStep({
			tick_id: tickId,
			step_index: 1,
			phase: "judge",
			detail: "判题完成:send",
			action_after: "send",
			skip_reason_after: "",
			duration_ms: 120,
		});

		const steps = store.listTickSteps(tickId);
		expect(steps).toHaveLength(2);
		expect(steps[0].phase).toBe("sense");
		expect(steps[0].action_after).toBe("judge");
		expect(steps[1].phase).toBe("judge");
		expect(steps[1].duration_ms).toBe(120);

		// 其他 tick 的步骤不串
		expect(store.listTickSteps(tickId + 999)).toHaveLength(0);
	});

	it("engine records phase steps on an empty-candidate tick", async () => {
		const { store, dbPath } = makeStore();
		const presence = new Presence(store, { sessionsDir: "/nonexistent" });
		const deps: DefaultStagesDeps = {
			store,
			presence,
			sourceInstances: [],
			intervals: {},
			driftMinIntervalHours: 3,
		};
		const engine = new ProactiveEngine(createDefaultStages({}, deps), store, {
			rules: new (await import("../src/rules.ts")).ProactiveRules(join(tmpdir(), "no-rules.md")),
		});
		// 触发一次私有 tick(私有方法在 strip-types 下可访问)
		await (engine as unknown as { tick(): Promise<unknown> }).tick();
		// 取引擎刚建的 tick_log(文件里最后一条)
		const db = new DatabaseSync(dbPath, { readOnly: true });
		const last = db.prepare("SELECT * FROM tick_log ORDER BY id DESC LIMIT 1").get() as { id: number };
		const steps = store.listTickSteps(last.id);
		expect(steps.length).toBeGreaterThanOrEqual(1);
		expect(steps[0].phase).toBe("sense");
		expect(steps[0].action_after).toBe("idle");
		db.close();
		store.close();
	});
});
