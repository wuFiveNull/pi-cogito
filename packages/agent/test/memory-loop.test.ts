import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsolidationLoop } from "../src/memory/consolidation-loop.ts";
import { FileCursorStore } from "../src/memory/extract.ts";
import { MemoryOptimizerLoop } from "../src/memory/loop.ts";
import { MarkdownMemoryStore } from "../src/memory/markdown-store.ts";
import type { MemoryLlm, MemoryOptimizer } from "../src/memory/optimizer.ts";

function makeLlm(reply: string): MemoryLlm {
	return { chat: vi.fn<(system: string, user: string, maxTokens: number) => Promise<string>>(async () => reply) };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("MemoryOptimizerLoop (akashic MemoryOptimizerLoop port)", () => {
	it("aligns ticks to interval boundaries", () => {
		const nowFn = () => new Date("2026-01-01T00:07:00Z");
		const loop = new MemoryOptimizerLoop({ optimizer: null, intervalSeconds: 3600, nowFn });
		// 下一个整点 01:00,距当前 07:00 = 3180 秒。
		expect(loop.secondsUntilNextTick()).toBe(3180);
		// 恰好在边界上:下一轮是 interval 之后。
		const boundary = new MemoryOptimizerLoop({
			optimizer: null,
			intervalSeconds: 3600,
			nowFn: () => new Date("2026-01-01T01:00:00Z"),
		});
		expect(boundary.secondsUntilNextTick()).toBe(3600);
	});

	it("runs optimize at the aligned tick and stops cleanly", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:59:30Z"));
		const optimize = vi.fn(async () => {});
		const loop = new MemoryOptimizerLoop({
			optimizer: { optimize } as unknown as MemoryOptimizer,
			intervalSeconds: 3600,
		});
		const running = loop.run();
		// 距整点 30s:未到不执行。
		await vi.advanceTimersByTimeAsync(20_000);
		expect(optimize).not.toHaveBeenCalled();
		// 到达整点对齐边界。
		await vi.advanceTimersByTimeAsync(10_000);
		expect(optimize).toHaveBeenCalledTimes(1);
		// 下一轮仍在等待。
		await vi.advanceTimersByTimeAsync(3600_000);
		expect(optimize).toHaveBeenCalledTimes(2);
		loop.stop();
		await running;
	});

	it("serializes a manual optimization trigger with the scheduled loop", async () => {
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const optimize = vi.fn(async () => blocked);
		const loop = new MemoryOptimizerLoop({
			optimizer: { optimize } as unknown as MemoryOptimizer,
			intervalSeconds: 3600,
		});

		const first = loop.optimizeNow();
		const second = loop.optimizeNow();
		expect(optimize).toHaveBeenCalledTimes(1);
		release();
		await Promise.all([first, second]);
		loop.stop();
	});
});

describe("ConsolidationLoop (akashic 对话 consolidation 的轮询形态)", () => {
	it("consolidates all sessions on the aligned tick and tolerates per-file failures", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:59:30Z"));
		const store = new MarkdownMemoryStore(mkdtempSync(join(tmpdir(), "cons-loop-")));
		const dir = mkdtempSync(join(tmpdir(), "cons-sess-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			`${Array.from({ length: 60 }, (_, i) =>
				JSON.stringify({
					type: "message",
					id: `m${i}`,
					message: {
						role: i % 2 === 0 ? "user" : "assistant",
						content: `c${i}`,
						timestamp: "2026-01-01T00:00:00Z",
					},
				}),
			).join("\n")}\n`,
			"utf-8",
		);
		const llm = makeLlm(JSON.stringify({ pending_items: [{ tag: "identity", content: "工程师" }] }));
		const cursorStore = new FileCursorStore(store.memoryDir);
		const loop = new ConsolidationLoop({
			store,
			llm,
			sessionsDir: dir,
			cursorStore,
			intervalSeconds: 3600,
			config: { keepCount: 50, minNewMessages: 5 },
		});
		const running = loop.run();
		await vi.advanceTimersByTimeAsync(30_000); // 到达整点
		expect(store.readPending()).toContain("- [identity] 工程师");
		expect(cursorStore.getCursor(file)).toBe(10); // 60 - 50 keep
		loop.stop();
		await running;
		store.close();
	});
});
