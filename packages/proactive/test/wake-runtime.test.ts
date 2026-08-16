import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WakeRuntime, type WakeRuntimeDeps } from "../src/wake/runtime.ts";
import { WakeStateStore } from "../src/wake/state.ts";
import type { WakeEvent } from "../src/wake/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeState(): WakeStateStore {
	const dir = mkdtempSync(join(tmpdir(), "wake-runtime-"));
	tempDirs.push(dir);
	return new WakeStateStore(join(dir, "wake_proactive.db"));
}

interface ScriptStep {
	toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

/** chat 脚本:按调用顺序出工具调用;超界时用最后一步。 */
function makeChat(script: ScriptStep[]) {
	let call = 0;
	return vi.fn(async () => {
		const step = script[Math.min(call, script.length - 1)]!;
		call++;
		return { content: null, toolCalls: step.toolCalls ?? [] };
	});
}

function _contentEvent(id: string, score = 0.9): WakeEvent {
	return {
		kind: "content",
		sourceId: "feed",
		source: "feed",
		ackSourceId: "feed",
		eventId: id,
		id: `feed:${id}`,
		item_id: `feed:${id}`,
		publishedAt: "2026-01-01T00:00:00Z",
		preprocessScore: score,
		title: `标题 ${id}`,
		url: "https://example.com/x",
	};
}

function makeDeps(overrides: Partial<WakeRuntimeDeps> = {}): WakeRuntimeDeps {
	return {
		sessionKey: "local",
		stateStore: makeState(),
		fetchChannels: async () => ({ alert: [], content: [], context: [] }),
		chat: makeChat([]),
		model: "m",
		maxTokens: 1024,
		lastUserAt: () => 1_700_000_000_000,
		recentPassiveConversation: () => "",
		recentProactiveMessages: () => "",
		readRules: () => "",
		readMemory: () => "",
		deliver: vi.fn(async () => true),
		webFetchFn: async () => ({ text: "正文内容,有实际信息。" }),
		rng: () => 0.001,
		tickIntervalSeconds: 300,
		nowFn: () => new Date("2026-01-01T01:00:00Z"),
		...overrides,
	};
}

describe("WakeRuntime decision chain (akashic runtime.py port)", () => {
	it("persists successful and failed wake tick audits", async () => {
		const state = makeState();
		const runtime = new WakeRuntime(makeDeps({ stateStore: state }));
		await runtime.runTick();
		expect(state.listTickLogs(1)[0]).toMatchObject({ status: "success", error: null });
		runtime.close();
	});

	it("writes an allowed drift gate in three-process mode (driftGate present)", async () => {
		const state = makeState();
		const now = new Date("2026-01-01T01:00:00Z");
		const driftGate = vi.fn();
		const runtime = new WakeRuntime(
			makeDeps({
				stateStore: state,
				driftGate,
				nowFn: () => now,
			}),
		);

		await runtime.runTick();

		expect(driftGate).toHaveBeenCalledTimes(1);
		expect(driftGate).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionKey: "local",
				verdict: "allowed",
				reason: "wake_idle",
				ttlHours: 1,
			}),
		);
		// 门控观察记录(wake_observations kind=drift)说明许可原因与 TTL。
		const driftObservations = state.observations("drift");
		expect(driftObservations).toHaveLength(1);
		expect(JSON.parse(String(driftObservations[0]?.trigger_json))).toMatchObject({
			verdict: "allowed",
			reason: "wake_idle",
			ttl_hours: 1,
		});
		runtime.close();
	});

	it("uses the configured drift gate TTL and prefetches context into the gate", async () => {
		const state = makeState();
		const now = new Date("2026-01-01T01:00:00Z");
		const driftGate = vi.fn();
		const runtime = new WakeRuntime(
			makeDeps({
				stateStore: state,
				driftGate,
				driftGateTtlHours: 5,
				fetchChannels: async () => ({
					alert: [],
					content: [],
					context: [
						{
							kind: "context",
							_source: "presence",
							presence: "active",
							confidence: 1,
							interruptibility: 0.8,
							observed_at: now.toISOString(),
						},
					],
				}),
				nowFn: () => now,
			}),
		);

		await runtime.runTick();

		expect(driftGate).toHaveBeenCalledWith(
			expect.objectContaining({
				verdict: "allowed",
				ttlHours: 5,
				context: expect.stringContaining('"presence":"active"'),
			}),
		);
		runtime.close();
	});

	it("omits the gate context when no ContextEvent is active", async () => {
		const state = makeState();
		const now = new Date("2026-01-01T01:00:00Z");
		const driftGate = vi.fn();
		const runtime = new WakeRuntime(
			makeDeps({
				stateStore: state,
				driftGate,
				fetchChannels: async () => ({ alert: [], content: [], context: [] }),
				nowFn: () => now,
			}),
		);

		await runtime.runTick();

		const call = driftGate.mock.calls[0]?.[0] as { context?: string };
		expect(call?.context).toBeUndefined();
		runtime.close();
	});
});
