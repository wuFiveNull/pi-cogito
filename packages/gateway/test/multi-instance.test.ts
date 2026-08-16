import { describe, expect, it, vi } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { ChannelRegistry } from "../src/channels/registry.ts";

/** fetch mock: all outbound HTTP fails fast so polling channels stay quiet. */
function failingFetch() {
	return vi.fn().mockResolvedValue({
		ok: false,
		status: 404,
		json: async () => ({}),
		text: async () => "",
	});
}

describe("channel multi-instance", () => {
	it("expands instances into runtime names", async () => {
		const registry = new ChannelRegistry();
		const bus = new MessageBus();
		const started = await registry.startAll(
			{
				channels: {
					telegram: {
						enabled: true,
						instances: [
							{ id: "work", token: "t1" },
							{ id: "home", token: "t2" },
						],
					},
					console: { enabled: true },
				},
			},
			bus,
			{ startChannels: false, defaultWeb: false },
		);
		const names = started.map((channel) => channel.name).sort();
		expect(names).toEqual(["console", "telegram.home", "telegram.work"]);
		expect((registry.get("telegram.work") as unknown as { config: Record<string, unknown> }).config).toMatchObject({
			token: "t1",
			instanceId: "work",
		});
		expect((registry.get("telegram.home") as unknown as { config: Record<string, unknown> }).config).toMatchObject({
			token: "t2",
			instanceId: "home",
		});
	});

	it("keeps the bare name for the default instance", async () => {
		const registry = new ChannelRegistry();
		const bus = new MessageBus();
		const started = await registry.startAll(
			{
				channels: {
					telegram: {
						enabled: true,
						instances: [{ id: "default", token: "t0" }],
					},
				},
			},
			bus,
			{ startChannels: false, defaultWeb: false },
		);
		expect(started.map((channel) => channel.name)).toEqual(["telegram"]);
	});

	it("skips duplicate instance ids in one config", async () => {
		const registry = new ChannelRegistry();
		const bus = new MessageBus();
		await registry.startAll(
			{
				channels: {
					telegram: {
						enabled: true,
						instances: [
							{ id: "work", token: "t1" },
							{ id: "work", token: "t2" },
						],
					},
				},
			},
			bus,
			{ startChannels: false, defaultWeb: false },
		);
		expect(registry.list()).toHaveLength(1);
		expect((registry.get("telegram.work") as unknown as { config: Record<string, unknown> }).config).toMatchObject({
			token: "t1",
		});
	});

	it("reconfigures instances individually", async () => {
		const registry = new ChannelRegistry();
		const bus = new MessageBus();
		await registry.startAll(
			{
				channels: {
					web: { enabled: true },
					telegram: {
						enabled: true,
						instances: [{ id: "work", token: "t1" }],
					},
				},
			},
			bus,
			{ fetchFn: failingFetch() as unknown as typeof fetch },
		);
		await registry.reconfigure({
			channels: {
				web: { enabled: true },
				telegram: {
					enabled: true,
					instances: [
						{ id: "work", token: "t1-changed" },
						{ id: "home", token: "t2" },
					],
				},
			},
		});
		expect((registry.get("telegram.work") as unknown as { config: Record<string, unknown> }).config).toMatchObject({
			token: "t1-changed",
		});
		expect((registry.get("telegram.home") as unknown as { config: Record<string, unknown> }).config).toMatchObject({
			token: "t2",
		});
		await registry.stopAll();
	});
});
