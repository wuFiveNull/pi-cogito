import type { DriftEvent } from "@cogito/gate";
import { describe, expect, it } from "vitest";
import { DriftEventObserved, EventBus } from "../src/bus.ts";
import { createDriftEventSink } from "../src/index.ts";

describe("Drift EventBus bridge", () => {
	it("publishes Drift lifecycle events as typed host events", async () => {
		const bus = new EventBus();
		const observed: DriftEventObserved[] = [];
		bus.on(DriftEventObserved, (event) => {
			observed.push(event);
		});
		const sink = createDriftEventSink(bus);
		const event: DriftEvent = {
			type: "drift_started",
			sessionKey: "local",
			at: 123,
			skillCount: 2,
		};

		await sink.emit(event);

		expect(observed).toHaveLength(1);
		expect(observed[0]?.event).toEqual(event);
	});
});
