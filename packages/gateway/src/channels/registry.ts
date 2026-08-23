/**
 * ChannelRegistry — discover and manage channel instances.
 */

import type { MessageBus } from "../bus.ts";
import type { GatewayManagement } from "../management.ts";
import type { ChannelTlsOptions } from "../tls.ts";
import type { BaseChannel, ChannelConfig } from "./base.ts";
import { ConsoleChannel } from "./console.ts";
import { type ChannelContextDependencies, ChannelContextScope } from "./context.ts";
import { DingtalkChannel } from "./dingtalk.ts";
import { DiscordChannel } from "./discord.ts";
import { OutboundDispatcher, type OutboundDispatcherOptions } from "./dispatcher.ts";
import { EmailChannel } from "./email.ts";
import { FeishuChannel } from "./feishu.ts";
import { MatrixChannel } from "./matrix.ts";
import { MattermostChannel } from "./mattermost.ts";
import { MochatChannel } from "./mochat.ts";
import { MSTeamsChannel } from "./msteams.ts";
import { NapCatChannel, OneBotChannel, QqChannel } from "./onebot.ts";
import {
	type ChannelFactory,
	type ChannelPluginDefinition,
	type ChannelSetupField,
	ChannelValidationError,
	validateChannelConfig,
} from "./plugin.ts";
import { QqOfficialChannel } from "./qq.ts";
import { SignalChannel } from "./signal.ts";
import { SlackChannel } from "./slack.ts";
import { type HttpGet, type HttpPost, TelegramChannel } from "./telegram.ts";
import { WebChannel } from "./web.ts";
import { WebSocketChannel } from "./websocket.ts";
import { WecomChannel } from "./wecom.ts";
import { WeixinChannel } from "./weixin.ts";

export interface GatewayConfig {
	channels?: Record<string, ChannelConfig>;
	web?: { host?: string; port?: number; staticDir?: string; uploadsDir?: string; tls?: ChannelTlsOptions };
	/** Preserved by the SDK for the host agent integration. */
	agent?: Record<string, unknown>;
	/** Preserved by the SDK for proactive integrations. */
	proactive?: Record<string, unknown>;
	/** 静默时段(主动推送积压补发),由 SDK 的 quiet-push 门读取。 */
	quietHours?: { enabled?: boolean; start?: number; end?: number };
}

export interface ChannelRegistryOptions {
	/** Transport override used by tests and embedders. */
	fetchFn?: typeof fetch;
	/** Build channels without opening inbound listeners. */
	startChannels?: boolean;
	/** Shared capabilities exposed to every channel through its context. */
	context?: ChannelContextDependencies;
	/** Bounded retry policy used by the bus dispatcher. */
	dispatcher?: OutboundDispatcherOptions;
	/** Management callbacks exposed by the Web channel. */
	management?: GatewayManagement;
	/** Whether a missing channels.web entry should enable the Web channel. */
	defaultWeb?: boolean;
}

export class ChannelRegistry {
	private readonly channels = new Map<string, BaseChannel>();
	private readonly contexts = new Map<string, ChannelContextScope>();
	private readonly channelConfigs = new Map<string, string>();
	private readonly plugins = new Map<string, { factory: ChannelFactory; definition: ChannelPluginDefinition }>();
	private dispatcher: OutboundDispatcher | undefined;
	private bus: MessageBus | undefined;
	private contextDependencies: ChannelContextDependencies = {};
	private fetchFn: typeof fetch | undefined;
	private management: GatewayManagement | undefined;
	private defaultWeb = true;
	private running = false;

	register(channel: BaseChannel): void {
		if (this.channels.has(channel.name)) throw new Error(`channel already registered: ${channel.name}`);
		this.channels.set(channel.name, channel);
	}

	/**
	 * Register a host/third-party channel type (nanobot ChannelPlugin 语义):
	 * 配置键 `channels.<name>.enabled = true` 即被发现并实例化,与内置通道
	 * 同一套校验/热重配/管理面。
	 */
	registerChannelType(
		name: string,
		factory: ChannelFactory,
		definition: ChannelPluginDefinition = { name, displayName: name },
	): void {
		if (BUILTIN_CHANNELS[name] !== undefined) {
			throw new Error(`channel type already built-in: ${name}`);
		}
		if (this.plugins.has(name)) throw new Error(`channel type already registered: ${name}`);
		this.plugins.set(name, { factory, definition: { ...definition, name } });
	}

	/** 通道目录(onboarding 信息面):内置 + 插件清单。 */
	catalog(): ChannelCatalogEntry[] {
		const entries: ChannelCatalogEntry[] = [];
		for (const [name, displayName] of Object.entries(BUILTIN_CHANNELS)) {
			entries.push({ name, displayName, configured: this.channelConfigs.has(name), plugin: false });
		}
		for (const [name, plugin] of this.plugins) {
			const definition = plugin.definition;
			entries.push({
				name,
				displayName: definition.displayName,
				configured: this.channelConfigs.has(name),
				plugin: true,
				setup: definition.setup,
				defaultConfig: definition.defaultConfig?.() ?? { enabled: false },
			});
		}
		return entries;
	}

	get(name: string): BaseChannel | undefined {
		return this.channels.get(name);
	}

	list(): BaseChannel[] {
		return [...this.channels.values()];
	}

	/** Build channels from config and start them plus the outbound dispatcher. */
	async startAll(
		config: GatewayConfig,
		bus: MessageBus,
		options: ChannelRegistryOptions = {},
	): Promise<BaseChannel[]> {
		this.bus = bus;
		this.contextDependencies = options.context ?? {};
		this.fetchFn = options.fetchFn;
		this.management = options.management;
		this.defaultWeb = options.defaultWeb !== false;
		for (const definition of configuredChannelDefinitions(config, this.defaultWeb, this.pluginNames())) {
			if (this.channels.has(definition.runtimeName)) {
				// Runtime name already claimed (e.g. another channel type): skip
				// with a warning instead of failing startup (nanobot semantics).
				console.warn(`[gateway] channel runtime name already claimed, skipping: ${definition.runtimeName}`);
				continue;
			}
			try {
				this.register(this.createChannel(definition, bus, options));
			} catch (error) {
				if (error instanceof ChannelValidationError) {
					// Invalid plugin configs are skipped with a warning (nanobot
					// validation semantics); other errors still fail startup.
					console.warn(`[gateway] channel ${error.channel} skipped: ${error.message}`);
					continue;
				}
				throw error;
			}
			this.channelConfigs.set(definition.runtimeName, definition.fingerprint);
		}
		const selected = [...this.channels.values()];
		if (options.startChannels === false) return selected;

		const started: BaseChannel[] = [];
		try {
			for (const channel of selected) {
				const context = new ChannelContextScope(bus, options.context);
				channel.bindContext(context);
				this.contexts.set(channel.name, context);
				await channel.start(context);
				started.push(channel);
			}
		} catch (error) {
			for (const channel of [...started].reverse()) {
				await channel.stop().catch(() => undefined);
				await this.closeContext(channel.name);
			}
			for (const [name, context] of this.contexts) {
				await context.close().catch(() => undefined);
				this.contexts.delete(name);
			}
			this.channels.clear();
			this.channelConfigs.clear();
			throw error;
		}
		this.dispatcher = new OutboundDispatcher(bus, this, options.dispatcher);
		this.dispatcher.start();
		this.running = true;
		return started;
	}

	/** Apply a new config while preserving unaffected running channels. */
	async reconfigure(config: GatewayConfig): Promise<void> {
		if (!this.running || !this.bus) throw new Error("channel registry is not running");
		const definitions = configuredChannelDefinitions(config, this.defaultWeb);
		const desired = new Map<string, ConfiguredChannelDefinition>(
			definitions.map((definition) => [definition.runtimeName, definition]),
		);
		const replacements: BaseChannel[] = [];
		for (const [name] of this.channels) {
			const definition = desired.get(name);
			if (!definition || this.channelConfigs.get(name) === definition.fingerprint) continue;
			replacements.push(
				this.createChannel(definition, this.bus, {
					fetchFn: this.fetchFn,
					context: this.contextDependencies,
					management: this.management,
				}),
			);
		}
		if (replacements.length > 0) {
			await this.replaceChannels(replacements);
			for (const replacement of replacements) {
				const definition = desired.get(replacement.name);
				if (definition) this.channelConfigs.set(replacement.name, definition.fingerprint);
			}
		}

		for (const definition of definitions) {
			if (this.channels.has(definition.runtimeName)) continue;
			const channel = this.createChannel(definition, this.bus, {
				fetchFn: this.fetchFn,
				context: this.contextDependencies,
				management: this.management,
			});
			await this.addChannel(channel, definition.fingerprint);
		}

		for (const name of [...this.channels.keys()]) {
			if (desired.has(name)) continue;
			await this.removeChannel(name);
		}
	}

	/** Replace one running channel while preserving the registry dispatcher. */
	async replaceChannel(name: string, replacement: BaseChannel): Promise<void> {
		if (replacement.name !== name) {
			throw new Error(`replacement channel name mismatch: expected ${name}, got ${replacement.name}`);
		}
		await this.replaceChannels([replacement]);
	}

	/** Atomically replace a set of running channels with rollback on startup failure. */
	async replaceChannels(replacements: readonly BaseChannel[]): Promise<void> {
		if (!this.running || !this.bus) throw new Error("channel registry is not running");
		const names = replacements.map((channel) => channel.name);
		if (names.length === 0 || new Set(names).size !== names.length) {
			throw new Error("replacement channels must have unique names");
		}
		const oldChannels = names.map((name) => {
			const channel = this.channels.get(name);
			if (!channel) throw new Error(`channel is not registered: ${name}`);
			return channel;
		});
		const oldContexts = new Map(names.map((name) => [name, this.contexts.get(name)]));
		const newContexts = new Map<string, ChannelContextScope>();

		try {
			for (const channel of [...oldChannels].reverse()) await channel.stop();
		} catch (error) {
			const restoreErrors = await this.restoreChannels(oldChannels, oldContexts);
			if (restoreErrors.length > 0) {
				throw new AggregateError([error, ...restoreErrors], "channel replacement stop/restore failed");
			}
			throw error;
		}

		for (const channel of replacements) {
			const context = new ChannelContextScope(this.bus, this.contextDependencies);
			channel.bindContext(context);
			newContexts.set(channel.name, context);
			this.channels.set(channel.name, channel);
		}

		try {
			for (const channel of replacements) {
				await channel.start(newContexts.get(channel.name));
			}
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			for (const channel of [...replacements].reverse()) {
				try {
					await channel.stop();
				} catch (stopError) {
					cleanupErrors.push(stopError);
				}
			}
			for (const context of [...newContexts.values()].reverse()) {
				try {
					await context.close();
				} catch (closeError) {
					cleanupErrors.push(closeError);
				}
			}
			for (const [name, channel] of oldChannels.map((channel) => [channel.name, channel] as const)) {
				this.channels.set(name, channel);
			}
			const restoreErrors = await this.restoreChannels(oldChannels, oldContexts);
			if (cleanupErrors.length > 0 || restoreErrors.length > 0) {
				throw new AggregateError(
					[error, ...cleanupErrors, ...restoreErrors],
					"channel replacement failed and rollback was incomplete",
				);
			}
			throw error;
		}

		for (const [name, context] of newContexts) this.contexts.set(name, context);
		const closeErrors: unknown[] = [];
		for (const context of [...oldContexts.values()].reverse()) {
			try {
				await context?.close();
			} catch (error) {
				closeErrors.push(error);
			}
		}
		if (closeErrors.length > 0) throw new AggregateError(closeErrors, "old channel context cleanup failed");
	}

	private createChannel(
		definition: ConfiguredChannelDefinition,
		bus: MessageBus,
		options: ChannelRegistryOptions,
	): BaseChannel {
		const config = definition.config;
		let channel: BaseChannel;
		switch (definition.name) {
			case "web":
				channel = new WebChannel(config, bus, definition.web, { management: options.management });
				break;
			case "websocket":
				channel = new WebSocketChannel(config, bus);
				break;
			case "console":
				channel = new ConsoleChannel(config, bus);
				break;
			case "telegram":
				channel = new TelegramChannel(config, bus, { ...telegramHttp(options.fetchFn), fetchFn: options.fetchFn });
				break;
			case "email":
				channel = new EmailChannel(config, bus, { fetchFn: options.fetchFn });
				break;
			case "mattermost":
				channel = new MattermostChannel(config, bus, { fetchFn: options.fetchFn });
				break;
			case "slack":
				channel = new SlackChannel(config, bus, { fetchFn: options.fetchFn });
				break;
			case "discord":
				channel = new DiscordChannel(config, bus, { fetchFn: options.fetchFn });
				break;
			case "matrix":
				channel = new MatrixChannel(config, bus, { fetchFn: options.fetchFn });
				break;
			case "feishu":
				channel = new FeishuChannel(config, bus, { fetchFn: options.fetchFn });
				break;
			case "onebot":
				channel = new OneBotChannel(config, bus);
				break;
			case "qq":
				channel = new QqChannel(config, bus);
				break;
			case "qqofficial":
				channel = new QqOfficialChannel(config, bus, { fetchFn: options.fetchFn });
				break;
			case "napcat":
				channel = new NapCatChannel(config, bus);
				break;
			case "signal":
				channel = new SignalChannel(config, bus, { fetchFn: options.fetchFn });
				break;
			case "msteams":
				channel = new MSTeamsChannel(config, bus, { fetchFn: options.fetchFn });
				break;
			case "dingtalk":
				channel = new DingtalkChannel(config, bus, { fetchFn: options.fetchFn });
				break;
			case "mochat":
				channel = new MochatChannel(config, bus, { fetchFn: options.fetchFn });
				break;
			case "weixin":
				channel = new WeixinChannel(config, bus, { fetchFn: options.fetchFn });
				break;
			case "wecom":
				channel = new WecomChannel(config, bus, { fetchFn: options.fetchFn });
				break;
			default: {
				// Host-registered plugin channel types (nanobot plugin semantics).
				const plugin = this.plugins.get(definition.name);
				if (plugin) {
					validateChannelConfig(definition.name, plugin.definition, config);
					channel = plugin.factory(config, bus);
					break;
				}
				throw new Error(`unknown channel type: ${definition.name}`);
			}
		}
		if (definition.runtimeName !== definition.name && channel.name === definition.name) {
			channel.name = definition.runtimeName;
		}
		return channel;
	}

	private pluginNames(): string[] {
		return [...this.plugins.keys()];
	}

	private async addChannel(channel: BaseChannel, fingerprint: string): Promise<void> {
		if (!this.bus) throw new Error("channel registry is not running");
		const context = new ChannelContextScope(this.bus, this.contextDependencies);
		channel.bindContext(context);
		this.channels.set(channel.name, channel);
		this.contexts.set(channel.name, context);
		try {
			await channel.start(context);
			this.channelConfigs.set(channel.name, fingerprint);
		} catch (error) {
			this.channels.delete(channel.name);
			this.contexts.delete(channel.name);
			await channel.stop().catch(() => undefined);
			await context.close().catch(() => undefined);
			throw error;
		}
	}

	/** Add a channel to an already-running registry and preserve dispatcher state. */
	async add(channel: BaseChannel, fingerprint = "runtime"): Promise<void> {
		if (!this.running) throw new Error("channel registry is not running");
		if (this.channels.has(channel.name)) throw new Error(`channel already registered: ${channel.name}`);
		await this.addChannel(channel, fingerprint);
	}

	private async removeChannel(name: string): Promise<void> {
		const channel = this.channels.get(name);
		if (!channel) return;
		let stopError: unknown;
		try {
			await channel.stop();
		} catch (error) {
			stopError = error;
		}
		try {
			await this.closeContext(name);
		} catch (error) {
			stopError = stopError ? new AggregateError([stopError, error]) : error;
		}
		this.channels.delete(name);
		this.channelConfigs.delete(name);
		if (stopError) throw stopError;
	}

	async stopAll(): Promise<void> {
		this.running = false;
		this.dispatcher?.stop();
		this.dispatcher = undefined;
		const errors: unknown[] = [];
		for (const channel of [...this.channels.values()].reverse()) {
			try {
				await channel.stop();
			} catch (error) {
				errors.push(error);
			}
			try {
				await this.closeContext(channel.name);
			} catch (error) {
				errors.push(error);
			}
		}
		this.channels.clear();
		this.contexts.clear();
		this.channelConfigs.clear();
		this.bus = undefined;
		this.fetchFn = undefined;
		this.management = undefined;
		this.defaultWeb = true;
		if (errors.length > 0) throw new AggregateError(errors, "channel shutdown failed");
	}

	private async closeContext(name: string): Promise<void> {
		const context = this.contexts.get(name);
		this.contexts.delete(name);
		await context?.close();
	}

	private async restoreChannels(
		channels: readonly BaseChannel[],
		contexts: ReadonlyMap<string, ChannelContextScope | undefined>,
	): Promise<unknown[]> {
		const errors: unknown[] = [];
		for (const channel of channels) {
			const context = contexts.get(channel.name);
			if (!context) {
				errors.push(new Error(`channel context is missing during rollback: ${channel.name}`));
				continue;
			}
			try {
				channel.bindContext(context);
				await channel.start(context);
			} catch (error) {
				errors.push(error);
				try {
					await channel.stop();
				} catch (stopError) {
					errors.push(stopError);
				}
			}
		}
		for (const channel of channels) {
			if (!channel.isRunning) continue;
			this.contexts.set(channel.name, contexts.get(channel.name)!);
		}
		return errors;
	}
}

/** 内置通道目录:配置键 -> 展示名(onboarding catalog)。 */
const BUILTIN_CHANNELS: Record<string, string> = {
	web: "Web",
	websocket: "WebSocket",
	console: "Console",
	telegram: "Telegram",
	email: "Email",
	mattermost: "Mattermost",
	slack: "Slack",
	discord: "Discord",
	matrix: "Matrix",
	feishu: "Feishu",
	onebot: "OneBot",
	qq: "QQ (OneBot)",
	napcat: "NapCat",
	signal: "Signal",
	wecom: "WeCom",
	msteams: "Microsoft Teams",
	qqofficial: "QQ Official",
	dingtalk: "DingTalk",
	mochat: "Mochat",
	weixin: "WeChat",
};

/** 通道目录条目(onboarding 信息面)。 */
export interface ChannelCatalogEntry {
	name: string;
	displayName: string;
	/** 当前配置中已启用。 */
	configured: boolean;
	/** 宿主注册的插件通道。 */
	plugin: boolean;
	/** 插件通道的配置字段清单。 */
	setup?: ChannelSetupField[];
	/** 插件通道的 onboarding 默认配置。 */
	defaultConfig?: ChannelConfig;
}

interface ConfiguredChannelDefinition {
	/** Channel type, e.g. "telegram" (builtin or host-registered plugin). */
	name: string;
	/** Unique runtime name, e.g. "telegram" or "telegram.work". */
	runtimeName: string;
	config: ChannelConfig;
	web?: GatewayConfig["web"];
	fingerprint: string;
}

/**
 * Expand channel configs into runtime definitions (nanobot-style
 * multi-instance): a channel with an `instances` array yields one runtime per
 * instance named `${type}.${id}` (id "default" keeps the bare type name).
 */
function configuredChannelDefinitions(
	config: GatewayConfig,
	defaultWeb: boolean,
	pluginNames: string[] = [],
): ConfiguredChannelDefinition[] {
	const channels = config.channels ?? {};
	const definitions: ConfiguredChannelDefinition[] = [];
	const add = (name: string, channelConfig: ChannelConfig | undefined, web?: GatewayConfig["web"]): void => {
		const normalized = channelConfig ?? {};
		const instances = Array.isArray(normalized.instances)
			? (normalized.instances as Array<Record<string, unknown>>)
			: undefined;
		if (instances && instances.length > 0) {
			for (const instance of instances) {
				const instanceId = typeof instance.id === "string" && instance.id.trim() ? instance.id : "default";
				const runtimeName = instanceId === "default" ? name : `${name}.${instanceId}`;
				const instanceConfig: ChannelConfig = {
					...normalized,
					...instance,
					instanceId,
				};
				delete (instanceConfig as Record<string, unknown>).instances;
				definitions.push({
					name,
					runtimeName,
					config: instanceConfig,
					web,
					fingerprint: stableSerialize({ config: instanceConfig, web: name === "web" ? web : undefined }),
				});
			}
			return;
		}
		definitions.push({
			name,
			runtimeName: name,
			config: normalized,
			web,
			fingerprint: stableSerialize({ config: normalized, web: name === "web" ? web : undefined }),
		});
	};

	if (channels.web?.enabled !== false && (defaultWeb || channels.web !== undefined)) {
		add("web", channels.web, config.web);
	}
	for (const name of [
		"websocket",
		"console",
		"telegram",
		"email",
		"mattermost",
		"slack",
		"discord",
		"matrix",
		"feishu",
		"onebot",
		"qq",
		"napcat",
		"signal",
		"wecom",
		"msteams",
		"qqofficial",
		"dingtalk",
		"mochat",
		"weixin",
	] as const) {
		if (channels[name]?.enabled === true) add(name, channels[name]);
	}
	for (const pluginName of pluginNames) {
		if (channels[pluginName]?.enabled === true) add(pluginName, channels[pluginName]);
	}
	return definitions;
}

function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function telegramHttp(fetchFn: typeof fetch | undefined): { get?: HttpGet; post?: HttpPost } {
	if (!fetchFn) return {};
	return {
		get: async (url) => {
			const response = await fetchFn(url);
			return { ok: response.ok, status: response.status, json: () => response.json() };
		},
		post: async (url, body) => {
			const response = await fetchFn(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			return { ok: response.ok, status: response.status, json: () => response.json() };
		},
	};
}
