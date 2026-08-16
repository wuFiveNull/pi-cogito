import { describe, expect, it } from "vitest";
import { ProactiveTickResult } from "../src/ext/frame.ts";
import { ProactiveKernel } from "../src/ext/kernel.ts";
import { ProactiveLifecycleSpec } from "../src/ext/lifecycle.ts";
import { ProactiveLoop } from "../src/ext/loop.ts";

describe("ProactiveLoop error handling", () => {
	it("notifies the kernel error handler before retrying", async () => {
		const kernel = new ProactiveKernel(
			[
				{
					slot: "proactive.failure",
					run: () => {
						throw new Error("tick failed");
					},
				},
			],
			{ lifecycle: new ProactiveLifecycleSpec("wake") },
		);
		const errors: unknown[] = [];
		const loop = new ProactiveLoop(kernel);
		kernel.onTickError = (error) => {
			errors.push(error);
			loop.stop();
		};

		await loop.run();

		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(Error);
	});

	it("uses the lifecycle scheduling hook after the first immediate tick", async () => {
		const kernel = new ProactiveKernel(
			[
				{
					slot: "proactive.success",
					run: (frame) => {
						frame.output = new ProactiveTickResult(0.7, 2);
						return frame;
					},
				},
			],
			{ lifecycle: new ProactiveLifecycleSpec("wake") },
		);
		let loop: ProactiveLoop;
		const intervals: number[] = [];
		loop = new ProactiveLoop(kernel, "local", undefined, {
			intervalFor: (result) => {
				intervals.push(result?.nextIntervalSeconds ?? -1);
				loop.stop();
				return 0;
			},
		});

		await loop.run();

		expect(intervals).toEqual([2]);
	});
});
