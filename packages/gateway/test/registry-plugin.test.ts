import { describe, expect, it } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { BaseChannel } from "../src/channels/base.ts";
import { ChannelValidationError, validateChannelConfig } from "../src/channels/plugin.ts";
import { type ChannelCatalogEntry, ChannelRegistry } from "../src/channels/registry.ts";
import type { OutboundMessage } from "../src/types.ts";

class PluginChannel extends BaseChannel {
	name = "mybot";
	displayName = "My Bot";
	started = false;

	async start(): Promise<void> {
		this.started = true;
		this.running = true;
	}
	async stop(): Promise<void> {
		this.running = false;
	}

	async send(_message: OutboundMessage): Promise<void> {}
}

function pluginFactory(): (config: Record<string, unknown>, bus: MessageBus) => PluginChannel {
	return (config, bus) => new PluginChannel(config, bus);
}

describe("W2-M6 channel plugin mechanism", () => {
	it("registers a host channel type and instantiates it from config", async () => {
		const registry = new ChannelRegistry();
		registry.registerChannelType("mybot", pluginFactory(), {
			name: "mybot",
			displayName: "My Bot",
			setup: [
				{ name: "token", kind: "secret", required: true },
				{ name: "pollIntervalMs", kind: "int", default: 5000 },
			],
		});
		const bus = new MessageBus();
		const channels = await registry.startAll({ channels: { mybot: { enabled: true, token: "t" } } }, bus, {
			startChannels: true,
			defaultWeb: false,
		});
		expect(channels).toHaveLength(1);
		expect(channels[0]!.name).toBe("mybot");
		expect(channels[0]!.isRunning).toBe(true);
		expect(registry.get("mybot")).toBeInstanceOf(PluginChannel);
		await registry.stopAll();
	});

	it("skips plugin channels whose config fails validation", async () => {
		const registry = new ChannelRegistry();
		registry.registerChannelType("mybot", pluginFactory(), {
			name: "mybot",
			displayName: "My Bot",
			setup: [{ name: "token", kind: "secret", required: true }],
		});
		const bus = new MessageBus();
		const channels = await registry.startAll(
			{ channels: { mybot: { enabled: true } } }, // Missing required token.
			bus,
			{ startChannels: true, defaultWeb: false },
		);
		expect(channels).toHaveLength(0);
		expect(registry.get("mybot")).toBeUndefined();
	});

	it("rejects registering a channel type that shadows a builtin", () => {
		const registry = new ChannelRegistry();
		expect(() => registry.registerChannelType("telegram", pluginFactory())).toThrow(/already built-in/);
	});

	it("exposes a catalog with builtin and plugin entries", async () => {
		const registry = new ChannelRegistry();
		registry.registerChannelType("mybot", pluginFactory(), {
			name: "mybot",
			displayName: "My Bot",
			setup: [{ name: "token", kind: "secret", required: true }],
			defaultConfig: () => ({ enabled: false, pollIntervalMs: 5000 }),
		});
		const bus = new MessageBus();
		await registry.startAll({ channels: { mybot: { enabled: true, token: "t" } } }, bus, {
			startChannels: false,
		});
		const catalog: ChannelCatalogEntry[] = registry.catalog();
		const builtin = catalog.find((entry) => entry.name === "telegram");
		expect(builtin).toMatchObject({ name: "telegram", displayName: "Telegram", plugin: false });
		const plugin = catalog.find((entry) => entry.name === "mybot");
		expect(plugin).toMatchObject({ name: "mybot", displayName: "My Bot", plugin: true, configured: true });
		expect(plugin!.setup).toEqual([{ name: "token", kind: "secret", required: true }]);
		expect(plugin!.defaultConfig).toMatchObject({ pollIntervalMs: 5000 });
	});

	it("validates required fields and custom validate hooks", () => {
		expect(() =>
			validateChannelConfig(
				"mybot",
				{ name: "mybot", displayName: "X", setup: [{ name: "token", required: true }] },
				{},
			),
		).toThrow(ChannelValidationError);
		expect(() =>
			validateChannelConfig(
				"mybot",
				{
					name: "mybot",
					displayName: "X",
					validate: (config) => {
						if (config.port !== 8080) throw new ChannelValidationError("mybot", "port must be 8080");
					},
				},
				{ port: 9999 },
			),
		).toThrow(/port must be 8080/);
		// Valid configs pass.
		expect(() =>
			validateChannelConfig(
				"mybot",
				{ name: "mybot", displayName: "X", setup: [{ name: "token", required: true }] },
				{ token: "t" },
			),
		).not.toThrow();
	});
});
