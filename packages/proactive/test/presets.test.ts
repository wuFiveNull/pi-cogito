/**
 * 预设配置(akashic presets.py 移植)测试。
 */

import { describe, expect, it } from "vitest";
import type { PusherConfig } from "../src/index.ts";
import { applyPreset } from "../src/presets.ts";

describe("applyPreset (akashic presets.py port)", () => {
	it("fills trigger/anyaction/context/safety from the daily preset", () => {
		const config = applyPreset({ preset: "daily" } as PusherConfig);
		expect(config.tick).toMatchObject({ tickS0: 480, tickS1: 240, tickJitter: 0.2 });
		expect(config.gate?.anyaction).toMatchObject({
			enabled: true,
			dailyMaxActions: 48,
			minIntervalSeconds: 180,
			probabilityMin: 0.2,
			probabilityMax: 0.82,
			idleScaleMinutes: 30,
			resetHourLocal: 12,
			timezone: "Asia/Shanghai",
		});
		expect(config.gate?.contextOnly).toMatchObject({ minIntervalHours: 12, dailyMax: 1 });
		expect(config.gate?.judgeSendThreshold).toBe(0.6);
		expect(config.safety).toMatchObject({ deliveryDedupeHours: 10, messageDedupeRecentN: 5 });
	});

	it("fills gate.judgeSendThreshold per preset (akashic presets.py)", () => {
		expect(applyPreset({ preset: "daily" } as PusherConfig).gate?.judgeSendThreshold).toBe(0.6);
		expect(applyPreset({ preset: "dev_verify" } as PusherConfig).gate?.judgeSendThreshold).toBe(0.28);
		expect(applyPreset({ preset: "quiet" } as PusherConfig).gate?.judgeSendThreshold).toBe(0.75);
	});

	it("explicit config overrides preset fields per-key", () => {
		const config = applyPreset({
			preset: "quiet",
			tick: { tickS0: 3600 },
			gate: { anyaction: { enabled: false }, contextOnly: { dailyMax: 3 }, judgeSendThreshold: 0.5 },
			safety: { deliveryDedupeHours: 48 },
		} as PusherConfig);
		// 显式字段覆盖,preset 其余字段保留。
		expect(config.tick).toMatchObject({ tickS0: 3600, tickS1: 900 });
		expect(config.gate?.anyaction).toMatchObject({ enabled: false, probabilityMin: 0.05 });
		expect(config.gate?.contextOnly).toMatchObject({ dailyMax: 3, minIntervalHours: 24 });
		expect(config.gate?.judgeSendThreshold).toBe(0.5);
		expect(config.safety).toMatchObject({ deliveryDedupeHours: 48, messageDedupeRecentN: 8 });
	});

	it("keeps sessionKey and other fields untouched", () => {
		const config = applyPreset({
			preset: "dev_verify",
			sessionKey: "telegram:12345",
			lifecycle: "wake",
		} as PusherConfig);
		expect(config.sessionKey).toBe("telegram:12345");
		expect(config.lifecycle).toBe("wake");
		expect(config.tick).toMatchObject({ tickS0: 60, tickS1: 30, tickJitter: 0 });
	});

	it("ignores unknown presets", () => {
		const config = applyPreset({ preset: "nope", tick: { tickS0: 1 } } as PusherConfig);
		expect(config.tick).toEqual({ tickS0: 1 });
	});

	it("leaves config without preset untouched", () => {
		const config = applyPreset({ tick: { tickS0: 1 } } as PusherConfig);
		expect(config.tick).toEqual({ tickS0: 1 });
		expect(config.gate).toBeUndefined();
	});
});
