import { describe, expect, it } from "vitest";
import { advanceDriftDrive, sampleDriftDelayHours } from "../src/drive.ts";

describe("wake drift drive (akashic drift_drive.py port)", () => {
	it("rate rises with idle time and decays the hazard", () => {
		const now = new Date("2026-01-02T00:00:00Z");
		const idle = advanceDriftDrive({
			now,
			hazard: 0,
			threshold: 0.05,
			updatedAt: new Date(now.getTime() - 24 * 3600_000),
			lastUserAt: new Date(now.getTime() - 6 * 3600_000),
			lastDriftAt: null,
			contentEvidence: 0,
		});
		expect(idle.rate).toBeGreaterThan(0.05);
		expect(idle.decision).toBe("attempt");
		const busy = advanceDriftDrive({
			now,
			hazard: 0,
			threshold: 0.05,
			updatedAt: now,
			lastUserAt: now,
			lastDriftAt: null,
			contentEvidence: 0,
		});
		expect(busy.rate).toBeLessThan(0.05);
	});

	it("samples a finite drift delay monotonically", () => {
		const delay = sampleDriftDelayHours({
			randomDraw: 0.5,
			idleHours: 2,
			recentDriftSuppression: 0,
			repetitionSuppression: 0,
		});
		expect(delay).toBeGreaterThan(0);
		expect(delay).toBeLessThan(100);
	});
});
