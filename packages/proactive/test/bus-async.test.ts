import { describe, expect, it } from "vitest";
import { EventBus } from "../src/bus.ts";

class TestEvent {
	readonly value: string;

	constructor(value: string) {
		this.value = value;
	}
}

describe("EventBus delivery modes", () => {
	it("chains ordered emit handlers and returns the transformed event", async () => {
		const bus = new EventBus();
		const seen: string[] = [];
		bus.on(TestEvent, (event) => new TestEvent(`${event.value}:intercepted`));
		bus.on(TestEvent, (event) => {
			seen.push(event.value);
		});

		const result = await bus.emit(new TestEvent("input"));

		expect(result.value).toBe("input:intercepted");
		expect(seen).toEqual(["input:intercepted"]);
	});

	it("isolates observer failures and reports them without stopping later observers", async () => {
		const errors: unknown[] = [];
		const bus = new EventBus({
			onHandlerError: (error) => {
				errors.push(error);
			},
		});
		const seen: string[] = [];
		bus.on(TestEvent, () => {
			throw new Error("observer failed");
		});
		bus.on(TestEvent, (event) => {
			seen.push(event.value);
		});

		await bus.observe(new TestEvent("observed"));

		expect(errors).toHaveLength(1);
		expect(seen).toEqual(["observed"]);
	});

	it("fans out observers concurrently", async () => {
		const bus = new EventBus();
		let releaseFirst = () => {};
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let secondStarted = false;
		bus.on(TestEvent, async () => {
			await first;
		});
		bus.on(TestEvent, () => {
			secondStarted = true;
		});

		const dispatched = bus.fanout(new TestEvent("parallel"));
		await Promise.resolve();

		expect(secondStarted).toBe(true);
		releaseFirst();
		await dispatched;
	});

	it("queues observer work, drains it, and releases scoped subscriptions", async () => {
		const bus = new EventBus();
		const scope = bus.scope("session-a");
		const seen: string[] = [];
		scope.on(TestEvent, (event) => {
			seen.push(event.value);
		});
		bus.enqueue(new TestEvent("queued"), { scope: "session-a" });
		await bus.drain();
		expect(seen).toEqual(["queued"]);

		scope.close();
		await bus.emit(new TestEvent("after-close"), { scope: "session-a" });
		expect(seen).toEqual(["queued"]);
	});
});
