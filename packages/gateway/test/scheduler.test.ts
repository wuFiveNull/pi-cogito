import { describe, expect, it } from "vitest";
import { TurnScheduler } from "../src/scheduler.ts";
import type { InboundMessage } from "../src/types.ts";

function message(sessionKey: string, content = "m"): InboundMessage {
	return {
		messageId: `m_${Math.random().toString(36).slice(2)}`,
		channel: "test",
		senderId: "s",
		chatId: sessionKey.split(":")[1] ?? sessionKey,
		content,
		timestamp: Date.now(),
		sessionKey,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("TurnScheduler", () => {
	it("processes one session's messages strictly in order", async () => {
		const scheduler = new TurnScheduler();
		const order: string[] = [];
		await Promise.all([
			scheduler.enqueue(message("s1"), async () => {
				await sleep(30);
				order.push("first");
			}),
			scheduler.enqueue(message("s1"), async () => {
				order.push("second");
			}),
		]);
		expect(order).toEqual(["first", "second"]);
	});

	it("runs distinct sessions concurrently", async () => {
		const scheduler = new TurnScheduler();
		const started: string[] = [];
		const start = Date.now();
		await Promise.all([
			scheduler.enqueue(message("s1"), async () => {
				started.push("s1");
				await sleep(120);
			}),
			scheduler.enqueue(message("s2"), async () => {
				started.push("s2");
				await sleep(120);
			}),
		]);
		expect(started.sort()).toEqual(["s1", "s2"]);
		expect(Date.now() - start).toBeLessThan(240);
	});

	it("caps global concurrency with maxConcurrentTurns", async () => {
		const scheduler = new TurnScheduler({ maxConcurrentTurns: 2 });
		let active = 0;
		let peak = 0;
		const run = async (): Promise<void> => {
			active++;
			peak = Math.max(peak, active);
			await sleep(50);
			active--;
		};
		await Promise.all([
			scheduler.enqueue(message("a"), run),
			scheduler.enqueue(message("b"), run),
			scheduler.enqueue(message("c"), run),
			scheduler.enqueue(message("d"), run),
		]);
		expect(peak).toBeLessThanOrEqual(2);
	});

	it("reports handler failures but keeps the session chain alive", async () => {
		const scheduler = new TurnScheduler();
		const order: string[] = [];
		const first = scheduler.enqueue(message("s1"), async () => {
			order.push("first");
			throw new Error("boom");
		});
		const second = scheduler.enqueue(message("s1"), async () => {
			order.push("second");
		});
		await expect(first).rejects.toThrow("boom");
		await second;
		expect(order).toEqual(["first", "second"]);
	});

	it("runs in parallel when serializeBySession is disabled", async () => {
		const scheduler = new TurnScheduler({ serializeBySession: false });
		const order: string[] = [];
		await Promise.all([
			scheduler.enqueue(message("s1"), async () => {
				await sleep(30);
				order.push("slow");
			}),
			scheduler.enqueue(message("s1"), async () => {
				order.push("fast");
			}),
		]);
		expect(order).toEqual(["fast", "slow"]);
	});
});
