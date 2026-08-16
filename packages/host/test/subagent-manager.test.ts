/**
 * Unit tests for SubagentManager: admission cap, sync/background execution,
 * timeout, cancellation, failure handling, and resource cleanup.
 */

import { describe, expect, it } from "vitest";
import {
	SubagentCapacityError,
	SubagentManager,
	type SubagentRunner,
	type SubagentRunResult,
} from "../src/core/subagent-manager.ts";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function textRunner(result: SubagentRunResult): SubagentRunner {
	return {
		run: async () => result,
		shutdown: async () => {},
	};
}

/** Runner that stays pending until its signal aborts, then rejects. */
function hangingRunner(): SubagentRunner {
	return {
		run: async (_request, signal) => {
			await new Promise<void>((_resolve, reject) => {
				if (signal.aborted) {
					reject(new DOMException("aborted", "AbortError"));
					return;
				}
				signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			});
			throw new Error("unreachable");
		},
		shutdown: async () => {},
	};
}

async function waitForCompletion(promise: Promise<SubagentRunResult>): Promise<SubagentRunResult> {
	return await Promise.race([
		promise,
		delay(2000).then(() => {
			throw new Error("timed out waiting for background completion");
		}),
	]);
}

describe("SubagentManager", () => {
	it("starts with zero state (no timers, no jobs)", () => {
		const manager = new SubagentManager({
			runner: textRunner({ status: "completed", exitReason: "completed", result: "ok" }),
		});
		expect(manager.getRunningCount()).toBe(0);
		expect(manager.listRunningJobs()).toEqual([]);
	});

	it("rejects spawn beyond the concurrency cap with SubagentCapacityError", () => {
		const manager = new SubagentManager({ runner: hangingRunner(), maxConcurrent: 3 });
		manager.spawn({ task: "one" });
		manager.spawn({ task: "two" });
		manager.spawn({ task: "three" });
		expect(manager.getRunningCount()).toBe(3);
		expect(() => manager.spawn({ task: "four" })).toThrow(SubagentCapacityError);
		try {
			manager.spawn({ task: "five" });
			throw new Error("expected SubagentCapacityError");
		} catch (error) {
			expect(error).toBeInstanceOf(SubagentCapacityError);
			const capacityError = error as SubagentCapacityError;
			expect(capacityError.active).toBe(3);
			expect(capacityError.maximum).toBe(3);
		}
	});

	it("also enforces the cap across sync and background modes combined", async () => {
		const manager = new SubagentManager({ runner: hangingRunner(), maxConcurrent: 2 });
		manager.spawn({ task: "one" });
		manager.spawn({ task: "two" });
		await expect(manager.spawnSync({ task: "three" })).rejects.toThrow(SubagentCapacityError);
		await manager.shutdown();
	});

	it("frees capacity after a background job completes", async () => {
		const runner: SubagentRunner = {
			run: async () => {
				await delay(10);
				return { status: "completed", exitReason: "completed", result: "done" };
			},
			shutdown: async () => {},
		};
		const manager = new SubagentManager({ runner, maxConcurrent: 1 });
		manager.spawn({ task: "first" });
		expect(manager.getRunningCount()).toBe(1);
		await delay(40);
		expect(manager.getRunningCount()).toBe(0);
		expect(manager.listRunningJobs()).toEqual([]);
		// Slot is available again.
		manager.spawn({ task: "second" });
		await manager.shutdown();
	});

	it("rejects an empty task", async () => {
		const manager = new SubagentManager({
			runner: textRunner({ status: "completed", exitReason: "completed", result: "ok" }),
		});
		expect(() => manager.spawn({ task: "   " })).toThrow("must not be empty");
		await expect(manager.spawnSync({ task: "" })).rejects.toThrow("must not be empty");
		expect(manager.getRunningCount()).toBe(0);
	});

	it("spawnSync returns the formatted result with label and status", async () => {
		const manager = new SubagentManager({
			runner: textRunner({ status: "completed", exitReason: "completed", result: "调研结果: 42" }),
		});
		const output = await manager.spawnSync({ task: "帮我调研一下问题", label: "调研" });
		expect(output).toContain("[子任务「调研」结果]");
		expect(output).toContain("状态: completed");
		expect(output).toContain("退出原因: completed");
		expect(output).toContain("调研结果: 42");
	});

	it("spawnSync returns failure text instead of hanging", async () => {
		const manager = new SubagentManager({
			runner: textRunner({ status: "failed", exitReason: "error", result: "模型调用失败: boom" }),
		});
		const output = await manager.spawnSync({ task: "task" });
		expect(output).toContain("状态: failed");
		expect(output).toContain("模型调用失败: boom");
	});

	it("spawnSync converts runner exceptions into failure text", async () => {
		const throwingRunner: SubagentRunner = {
			run: async () => {
				throw new Error("runner exploded");
			},
			shutdown: async () => {},
		};
		const manager = new SubagentManager({ runner: throwingRunner });
		const output = await manager.spawnSync({ task: "task" });
		expect(output).toContain("状态: failed");
		expect(output).toContain("runner exploded");
		expect(manager.getRunningCount()).toBe(0);
	});

	it("truncates sync results at the configured cap", async () => {
		const longResult = "x".repeat(500);
		const manager = new SubagentManager({
			runner: textRunner({ status: "completed", exitReason: "completed", result: longResult }),
			syncResultMaxChars: 100,
		});
		const output = await manager.spawnSync({ task: "task" });
		expect(output).toContain("结果已截断");
		expect(output.length).toBeLessThan(300);
	});

	it("reports background completion via onComplete", async () => {
		const completion = deferred<SubagentRunResult>();
		const manager = new SubagentManager({
			runner: textRunner({ status: "completed", exitReason: "completed", result: "hello" }),
			onComplete: (_jobId, result) => completion.resolve(result),
		});
		const ack = manager.spawn({ task: "background task", label: "bg" });
		expect(ack).toContain("已创建后台子任务「bg」");
		expect(manager.getRunningCount()).toBe(1);
		const result = await waitForCompletion(completion.promise);
		expect(result.status).toBe("completed");
		expect(result.result).toBe("hello");
		expect(manager.getRunningCount()).toBe(0);
	});

	it("times out background jobs and reports timed_out", async () => {
		const completion = deferred<SubagentRunResult>();
		const manager = new SubagentManager({
			runner: hangingRunner(),
			defaultTimeoutMs: 40,
			onComplete: (_jobId, result) => completion.resolve(result),
		});
		manager.spawn({ task: "slow task" });
		const result = await waitForCompletion(completion.promise);
		expect(result.status).toBe("timed_out");
		expect(result.exitReason).toBe("aborted");
		expect(manager.getRunningCount()).toBe(0);
		expect(manager.listRunningJobs()).toEqual([]);
	});

	it("times out sync spawns and reports timed_out", async () => {
		const manager = new SubagentManager({ runner: hangingRunner() });
		const output = await manager.spawnSync({ task: "slow task", timeoutMs: 40 });
		expect(output).toContain("状态: timed_out");
		expect(manager.getRunningCount()).toBe(0);
	});

	it("distinguishes external cancellation from timeout in sync mode", async () => {
		const manager = new SubagentManager({ runner: hangingRunner() });
		const controller = new AbortController();
		const pending = manager.spawnSync({ task: "slow task" }, controller.signal);
		controller.abort();
		const output = await pending;
		expect(output).toContain("状态: cancelled");
		expect(output).not.toContain("timed_out");
	});

	it("cancels background jobs and reports cancelled", async () => {
		const completion = deferred<SubagentRunResult>();
		const manager = new SubagentManager({
			runner: hangingRunner(),
			onComplete: (_jobId, result) => completion.resolve(result),
		});
		const ack = manager.spawn({ task: "cancel me" });
		const jobId = ack.match(/job_id=([a-f0-9]+)/)?.[1];
		expect(jobId).toBeDefined();
		expect(manager.cancel(jobId as string)).toBe(true);
		const result = await waitForCompletion(completion.promise);
		expect(result.status).toBe("cancelled");
		expect(manager.cancel(jobId as string)).toBe(false);
		expect(manager.getRunningCount()).toBe(0);
	});

	it("shutdown cancels running jobs and releases the runner", async () => {
		let shutdownCalls = 0;
		const runner: SubagentRunner = {
			...hangingRunner(),
			shutdown: async () => {
				shutdownCalls++;
			},
		};
		const manager = new SubagentManager({ runner });
		manager.spawn({ task: "one" });
		manager.spawn({ task: "two" });
		await manager.shutdown();
		expect(shutdownCalls).toBe(1);
		expect(manager.getRunningCount()).toBe(0);
		expect(manager.listRunningJobs()).toEqual([]);
	});

	it("does not call onComplete for sync spawns", async () => {
		let onCompleteCalls = 0;
		const manager = new SubagentManager({
			runner: textRunner({ status: "completed", exitReason: "completed", result: "ok" }),
			onComplete: () => {
				onCompleteCalls++;
			},
		});
		await manager.spawnSync({ task: "sync" });
		expect(onCompleteCalls).toBe(0);
	});

	it("keeps no state after jobs finish (resource cleanup)", async () => {
		const manager = new SubagentManager({
			runner: textRunner({ status: "completed", exitReason: "completed", result: "ok" }),
		});
		manager.spawn({ task: "one" });
		await delay(20);
		await manager.spawnSync({ task: "two" });
		expect(manager.getRunningCount()).toBe(0);
		expect(manager.listRunningJobs()).toEqual([]);
	});
});
