import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPusherConfig, runPusher } from "../src/index.ts";

const tempDirs: string[] = [];
const originalCwd = process.cwd();
let workDir = "";
let sourcesDir = "";
let dbPath = "";
let sessionsDir = "";

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "pusher-run-"));
	tempDirs.push(workDir);
	// 挂载目录唯一:临时 cwd 下的 .cogito/extensions/proactive。
	sourcesDir = join(workDir, ".cogito", "extensions", "proactive");
	dbPath = join(workDir, "proactive.sqlite");
	sessionsDir = join(workDir, "sessions");
	mkdirSync(sourcesDir, { recursive: true });
	mkdirSync(sessionsDir, { recursive: true });
	process.chdir(workDir);
});

afterEach(() => {
	process.chdir(originalCwd);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadPusherConfig", () => {
	it("loads json config and returns {} for missing files", () => {
		const configPath = join(workDir, "proactive.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				tick: { fallbackIntervalSeconds: 3600 },
				drift: { webPolicy: { allowPrivateNetwork: false, maxRedirectHops: 0 } },
				retention: { maxDeliveryAgeDays: 30, driftMaxRuns: 1000 },
				sources: { dailyhot: { enabled: true } },
			}),
			"utf-8",
		);
		const config = loadPusherConfig(configPath);
		expect(config.tick?.fallbackIntervalSeconds).toBe(3600);
		expect(config.drift?.webPolicy?.maxRedirectHops).toBe(0);
		expect(config.retention?.driftMaxRuns).toBe(1000);
		expect(loadPusherConfig(join(workDir, "missing.json"))).toEqual({});
	});

	it("fails loudly for malformed or structurally invalid config", () => {
		const malformedPath = join(workDir, "malformed.json");
		writeFileSync(malformedPath, "{", "utf-8");
		expect(() => loadPusherConfig(malformedPath)).toThrow(/invalid proactive config/);

		const invalidPath = join(workDir, "invalid.json");
		writeFileSync(invalidPath, JSON.stringify({ reload: { debounceMs: -1 } }), "utf-8");
		expect(() => loadPusherConfig(invalidPath)).toThrow(/reload\.debounceMs/);

		const invalidWebPolicyPath = join(workDir, "invalid-web-policy.json");
		writeFileSync(invalidWebPolicyPath, JSON.stringify({ drift: { webPolicy: { maxRedirectHops: 6 } } }), "utf-8");
		expect(() => loadPusherConfig(invalidWebPolicyPath)).toThrow(/maxRedirectHops/);

		const invalidGateTtlPath = join(workDir, "invalid-gate-ttl.json");
		writeFileSync(invalidGateTtlPath, JSON.stringify({ drift: { gateTtlHours: -2 } }), "utf-8");
		expect(() => loadPusherConfig(invalidGateTtlPath)).toThrow(/gateTtlHours/);
	});

	it("validates numeric ranges (akashic _validate_ranges)", () => {
		const cases: Array<[string, Record<string, unknown>, RegExp]> = [
			["tick-s0", { tick: { tickS0: 0 } }, /tick\.tickS0/],
			["tick-s1", { tick: { tickS1: 200000 } }, /tick\.tickS1/],
			["tick-jitter", { tick: { tickJitter: 1.5 } }, /tick\.tickJitter/],
			["tick-decreasing", { tick: { tickS0: 240, tickS1: 480 } }, /tick 必须递减/],
			["unknown-root-key", { not_a_real_key: 1 }, /非法的根级键/],
			["anyaction-prob-min", { gate: { anyaction: { probabilityMin: -0.1 } } }, /anyaction\.probabilityMin/],
			["anyaction-prob-max", { gate: { anyaction: { probabilityMax: 2 } } }, /anyaction\.probabilityMax/],
			[
				"anyaction-min-max",
				{ gate: { anyaction: { probabilityMin: 0.8, probabilityMax: 0.2 } } },
				/probabilityMin must not exceed/,
			],
			["anyaction-scale", { gate: { anyaction: { idleScaleMinutes: 0 } } }, /idleScaleMinutes/],
			["context-prob", { gate: { contextOnly: { probability: 2 } } }, /contextOnly\.probability/],
			["chat-levity-prob", { gate: { contextOnly: { chatLevityProbability: -1 } } }, /chatLevityProbability/],
			["dedupe-hours", { safety: { deliveryDedupeHours: 1000 } }, /deliveryDedupeHours/],
			["ack-delay", { sourceAck: { retryBaseDelayMs: 10 } }, /sourceAck\.retryBaseDelayMs/],
		];
		for (const [name, payload, pattern] of cases) {
			const path = join(workDir, `invalid-${name}.json`);
			writeFileSync(path, JSON.stringify(payload), "utf-8");
			expect(() => loadPusherConfig(path), name).toThrow(pattern);
		}
		// 合法边界通过。
		const okPath = join(workDir, "valid-ranges.json");
		writeFileSync(
			okPath,
			JSON.stringify({
				tick: { tickS0: 480, tickS1: 240, tickJitter: 0.2 },
				gate: {
					anyaction: { probabilityMin: 0.2, probabilityMax: 0.82, idleScaleMinutes: 30 },
					contextOnly: { probability: 0.03, chatLevity: true, chatLevityProbability: 0.1 },
				},
				safety: { deliveryDedupeHours: 24 },
				sourceAck: { retryBaseDelayMs: 5000, retryMaxDelayMs: 300000 },
				webPolicy: { allowPrivateNetwork: false, maxRedirectHops: 0 },
			}),
			"utf-8",
		);
		expect(() => loadPusherConfig(okPath)).not.toThrow();
	});
});

describe("runPusher", () => {
	it("runs replay.eventsPath through Pipeline and the real tick executor", async () => {
		writeFileSync(
			join(sourcesDir, "idle-source.ts"),
			`export default class IdleSource {
  id = "idle-source";
  label = "Idle";
  async fetch() { return []; }
}`,
			"utf-8",
		);
		const eventsPath = join(workDir, "events.jsonl");
		const clockPath = join(workDir, "clock.json");
		const reportPath = join(workDir, "replay-report.jsonl");
		writeFileSync(
			eventsPath,
			`${JSON.stringify({
				event_id: "historical-1",
				source_id: "feed",
				available_at: "2026-01-01T00:01:00Z",
				title: "历史候选",
			})}\n`,
			"utf-8",
		);

		const result = await runPusher({
			dbPath,
			sessionsDir,
			replay: { eventsPath, clockPath, reportPath },
			gate: { busyFn: () => true },
		});
		try {
			expect(result.replay?.tickCount).toBe(1);
			expect(result.replay?.failedTickCount).toBe(0);
			const { ProactiveStore } = await import("../src/store.ts");
			const store = new ProactiveStore(dbPath);
			try {
				expect(store.listNew(10).map((item) => item.title)).toEqual(["历史候选"]);
			} finally {
				store.close();
			}
		} finally {
			await result.stop();
		}
	});

	it("loads sources, fetches on schedule and writes items to the store", async () => {
		writeFileSync(
			join(sourcesDir, "test-source.ts"),
			`export default class TestSource {
  id = "test-source";
  label = "Test";
  defaultIntervalMs = 60000;
  async fetch() {
    return [
      { source: "feed", title: "重要新闻", url: "https://x/1" },
      { source: "feed", title: "普通内容" }
    ];
  }
}`,
			"utf-8",
		);
		writeFileSync(
			join(sourcesDir, "broken.ts"),
			`export default class Broken {
  id = "broken";
  label = "Broken";
  async fetch() {
    throw new Error("upstream down");
  }
}`,
			"utf-8",
		);

		const { stop } = await runPusher({
			dbPath,
			sessionsDir,
			tick: { fallbackIntervalSeconds: 3600 },
			gate: { busyFn: () => true },
			fetch: { mode: "background" },
			sources: { "test-source": { intervalMin: 60 } },
		});

		try {
			// Fetch is async; poll the store until the first round lands.
			const { ProactiveStore } = await import("../src/store.ts");
			const store = new ProactiveStore(dbPath);
			try {
				for (let i = 0; i < 50; i++) {
					if (store.listNew(10).length > 0) break;
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				const items = store.listNew(10);
				expect(items.map((item) => item.title).sort()).toEqual(["普通内容", "重要新闻"]);
				expect(JSON.parse(store.getState("health.source.test-source") ?? "{}")).toMatchObject({
					status: "ok",
					received: 2,
					quarantined: 0,
				});
				expect(JSON.parse(store.getState("health.source.broken") ?? "{}")).toMatchObject({ status: "error" });
				// The failing source recorded an error state instead of crashing the pusher.
				expect(store.getState("lastError.broken")).toContain("upstream down");
			} finally {
				store.close();
			}
		} finally {
			stop();
		}
	});
});
