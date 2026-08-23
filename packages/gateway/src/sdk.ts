import { resolve } from "node:path";
import { MessageBus, type MessageBusOptions, type MessageBusSnapshot } from "./bus.ts";
import type { BaseChannel } from "./channels/base.ts";
import {
	type ChannelContextDependencies,
	type ChannelEventBusLike,
	ChannelEventEmitter,
	type ChannelInterruptControllerLike,
	type ChannelSessionManager,
} from "./channels/context.ts";
import { ChannelInterruptController } from "./channels/interrupt.ts";
import type { ChannelFactory, ChannelPluginDefinition } from "./channels/plugin.ts";
import { ChannelRegistry, type ChannelRegistryOptions, type GatewayConfig } from "./channels/registry.ts";
import {
	type GatewayConfigFile,
	type GatewayConfigWatchOptions,
	loadGatewayConfig,
	watchGatewayConfig,
} from "./config.ts";
import { FileInboundDeadLetterStore, type InboundDeadLetterRecord } from "./inbound-dlq.ts";
import type { GatewayManagement } from "./management.ts";
import {
	type ChannelMessageQuery,
	type ChannelMessageRecord,
	type ChannelMessageStore,
	FileChannelMessageStore,
} from "./messages.ts";
import type { OutboxCleanupOptions, OutboxRecord, OutboxStatus } from "./outbox.ts";
import type { PairingStore } from "./pairing.ts";
import { QuietPushGate } from "./quiet-push.ts";
import { TurnScheduler, type TurnSchedulerOptions } from "./scheduler.ts";
import { FileChannelSessionStore } from "./session.ts";
import { FileChannelOffsetStore, FileInboundHandoffStore, type InboundDedupStore, inboundMessageKey } from "./state.ts";
import {
	type ChannelSendResult,
	createMessageId,
	type DeliveryReceipt,
	type InboundMessage,
	type OutboundDelta,
	type OutboundMessage,
} from "./types.ts";

const SUPPORTED_CHANNELS = [
	"web",
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
] as const;

export interface ChannelSdkRetryOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
}

export interface ChannelSdkReadinessOptions {
	/** Maximum time to wait for every configured channel to become ready. */
	timeoutMs?: number;
	/** Status polling interval while waiting for provider connections. */
	pollIntervalMs?: number;
}

export interface ChannelSdkTransportOptions {
	/** Replace HTTP calls without exposing channel implementations. */
	fetchFn?: typeof fetch;
}

export interface ChannelSdkOptions {
	/** Use an in-memory config. When omitted, load configPath or config.json. */
	config?: GatewayConfig | GatewayConfigFile;
	configPath?: string;
	/** Start only these registered channels. Selected channels are enabled by default. */
	channels?: readonly string[];
	/** Disable the implicit Web channel when config.channels.web is absent. */
	defaultWeb?: boolean;
	/** Keep false for one-way senders such as proactive delivery. Defaults to true. */
	receive?: boolean;
	retry?: ChannelSdkRetryOptions;
	transport?: ChannelSdkTransportOptions;
	/** Queue bounds and inbound duplicate window. */
	bus?: MessageBusOptions;
	/** Shared channel capabilities supplied by the host. */
	context?: ChannelContextDependencies;
	/** Shared interrupt controller, usually owned by the agent runtime. */
	interruptController?: ChannelInterruptControllerLike;
	/** Optional session metadata/admission store. */
	sessionManager?: ChannelSessionManager;
	/** Convenience path for the built-in file-backed session store. */
	sessionStatePath?: string;
	/** Optional pairing store for DM sender approval. */
	pairingStore?: PairingStore;
	/** Convenience path for persistent provider polling cursors. */
	offsetStatePath?: string;
	/** Convenience path for the durable inbound handoff queue. */
	inboundHandoffStatePath?: string;
	/** Convenience path for the durable inbound dead-letter queue. */
	inboundDeadLetterStatePath?: string;
	/** Optional canonical store for complete inbound and outbound messages. */
	messageStore?: ChannelMessageStore;
	/** Convenience path for the built-in file-backed canonical message store. */
	messageStatePath?: string;
	/** Convenience retry policy for inbound application-handler failures. */
	inboundRetry?: MessageBusOptions["inboundRetry"];
	/** Periodically remove terminal outbox records according to this policy. */
	outboxCleanup?: OutboxCleanupOptions & { intervalMs?: number };
	/** Watch configPath and hot-reload changed channels. */
	watchConfig?: boolean | GatewayConfigWatchOptions;
	/** Per-session serialization and concurrency limits for inbound handlers. */
	scheduler?: TurnSchedulerOptions;
	/** 静默时段积压队列文件路径(config.quietHours 启用时用到)。 */
	quietQueuePath?: string;
}

export type ChannelSdkConfigWatchOptions = GatewayConfigWatchOptions;

export interface ChannelSdkStatus {
	name: string;
	displayName: string;
	running: boolean;
	/** True when the channel's transport is usable, not merely started. */
	ready: boolean;
	receives: boolean;
	sends: boolean;
	streaming: boolean;
	/** Set for the HTTP channel after it binds to an ephemeral port. */
	port?: number;
}

export interface ChannelSdkCapabilities {
	receives: boolean;
	sends: boolean;
	streaming: boolean;
	/** Renders reasoning content with a low-emphasis primitive. */
	reasoning: boolean;
	/** Renders structured file-edit events. */
	fileEdits: boolean;
	/** Emits progress/tool-hint messages. */
	progress: boolean;
	/** Renders interactive buttons. */
	buttons: boolean;
}

export type ChannelSendReceipt = DeliveryReceipt;

export type ChannelMessageHandler = (message: InboundMessage) => void | Promise<void>;

/**
 * Public all-channel facade. Callers only deal with normalized messages and
 * channel names; buses, registries, channel classes, and retry details stay
 * behind this object.
 */
export class ChannelSdk {
	private readonly bus: MessageBus;
	private readonly registry = new ChannelRegistry();
	private config: GatewayConfig;
	private readonly selectedChannels: readonly string[] | undefined;
	private readonly configPath: string | undefined;
	private readonly watchConfigSetting: boolean | GatewayConfigWatchOptions | undefined;
	private readonly outboxCleanupSetting: (OutboxCleanupOptions & { intervalMs?: number }) | undefined;
	private readonly receive: boolean;
	private readonly registryOptions: ChannelRegistryOptions;
	private readonly eventBus: ChannelEventBusLike;
	private readonly interruptControllerValue: ChannelInterruptControllerLike;
	private readonly sessionManagerValue: ChannelSessionManager | undefined;
	private readonly maxAttempts: number;
	private readonly baseDelayMs: number;
	private readonly maxDelayMs: number;
	private readonly handlers = new Set<ChannelMessageHandler>();
	private readonly scheduler: TurnScheduler;
	private readonly quietGate: QuietPushGate | undefined;
	private unsubscribeInbound: (() => void) | undefined;
	private configWatcher: ReturnType<typeof watchGatewayConfig> | undefined;
	private outboxCleanupTimer: NodeJS.Timeout | undefined;
	private initialized = false;

	constructor(options: ChannelSdkOptions = {}) {
		this.sessionManagerValue =
			options.sessionManager ??
			options.context?.sessionManager ??
			(options.sessionStatePath ? new FileChannelSessionStore(options.sessionStatePath) : undefined);
		const offsetStore =
			options.context?.offsetStore ??
			(options.offsetStatePath ? new FileChannelOffsetStore(options.offsetStatePath) : undefined);
		const messageStore =
			options.messageStore ??
			(options.messageStatePath ? new FileChannelMessageStore(options.messageStatePath) : undefined);
		const busOptions = { ...options.bus };
		if (!busOptions.inboundHandoffStore && options.inboundHandoffStatePath) {
			busOptions.inboundHandoffStore = new FileInboundHandoffStore(options.inboundHandoffStatePath);
		}
		if (!busOptions.inboundDeadLetterStore && options.inboundDeadLetterStatePath) {
			busOptions.inboundDeadLetterStore = new FileInboundDeadLetterStore(options.inboundDeadLetterStatePath);
		}
		if (!busOptions.inboundRetry && options.inboundRetry) busOptions.inboundRetry = options.inboundRetry;
		if (!busOptions.inboundDedupStore && isInboundDedupStore(this.sessionManagerValue)) {
			busOptions.inboundDedupStore = this.sessionManagerValue;
		}
		if (!busOptions.messageStore && messageStore) busOptions.messageStore = messageStore;
		this.bus = new MessageBus(busOptions);
		this.scheduler = new TurnScheduler(options.scheduler);
		this.eventBus = options.context?.eventBus ?? new ChannelEventEmitter();
		this.interruptControllerValue =
			options.interruptController ?? options.context?.interruptController ?? new ChannelInterruptController();
		const source = options.config ?? loadGatewayConfig(options.configPath);
		const config = normalizeConfig(source);
		this.selectedChannels = options.channels;
		this.configPath = options.configPath ?? (options.config === undefined ? defaultConfigPath() : undefined);
		this.watchConfigSetting = options.watchConfig;
		this.outboxCleanupSetting = options.outboxCleanup;
		this.config = restrictChannels(config, this.selectedChannels);
		const quietHours = this.config.quietHours;
		this.quietGate =
			quietHours?.enabled && options.quietQueuePath
				? new QuietPushGate({
						enabled: true,
						start: quietHours.start,
						end: quietHours.end,
						queuePath: options.quietQueuePath,
						deliver: (message) => this.deliverNow(message),
						log: (message) => console.error(`[gateway] ${message}`),
					})
				: undefined;
		this.receive = options.receive !== false;
		this.maxAttempts = positiveInteger(options.retry?.maxAttempts, 3);
		this.baseDelayMs = nonNegativeNumber(options.retry?.baseDelayMs, 1000);
		this.maxDelayMs = nonNegativeNumber(options.retry?.maxDelayMs, 30_000);
		this.registryOptions = {
			fetchFn: options.transport?.fetchFn,
			startChannels: this.receive,
			context: {
				...options.context,
				sessionManager: this.sessionManagerValue ?? options.context?.sessionManager,
				eventBus: this.eventBus,
				interruptController: this.interruptControllerValue,
				offsetStore,
				pairingStore: options.pairingStore ?? options.context?.pairingStore,
			},
			dispatcher: {
				maxAttempts: this.maxAttempts,
				baseDelayMs: this.baseDelayMs,
				maxDelayMs: this.maxDelayMs,
			},
			management: this.managementCallbacks(),
			defaultWeb: options.defaultWeb,
		};
	}

	/** Start inbound listeners. In send-only mode this only initializes senders. */
	async start(): Promise<void> {
		if (this.initialized) return;
		this.bus.reopen();
		const unsubscribe = this.receive
			? this.bus.onInbound((message) => this.dispatch(message), { consume: true })
			: undefined;
		try {
			await this.registry.startAll(this.config, this.bus, this.registryOptions);
			this.bus.recoverInbound();
			this.startConfigWatcher(this.watchConfigSetting);
			this.startOutboxCleanup();
			this.unsubscribeInbound = unsubscribe;
			this.initialized = true;
		} catch (error) {
			this.configWatcher?.close();
			this.configWatcher = undefined;
			unsubscribe?.();
			await this.registry.stopAll().catch(() => undefined);
			this.bus.close("channel SDK failed to start");
			throw error;
		}
	}

	/** Stop every channel and release all SDK subscriptions. */
	async stop(): Promise<void> {
		this.initialized = false;
		this.configWatcher?.close();
		this.configWatcher = undefined;
		if (this.outboxCleanupTimer) clearInterval(this.outboxCleanupTimer);
		this.outboxCleanupTimer = undefined;
		this.quietGate?.stop();
		this.unsubscribeInbound?.();
		this.unsubscribeInbound = undefined;
		try {
			await this.registry.stopAll();
		} finally {
			this.bus.close("channel SDK stopped");
		}
	}

	/** Subscribe to normalized inbound messages. Returns an unsubscribe function. */
	onMessage(handler: ChannelMessageHandler): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	/** Subscribe to complete outbound delivery results. */
	onDelivery(listener: (receipt: DeliveryReceipt) => void | Promise<void>): () => void {
		return this.bus.onDelivery(listener);
	}

	/** Deliver a complete message through the named channel with bounded retry. */
	async send(message: OutboundMessage): Promise<ChannelSendReceipt> {
		this.assertInitialized();
		const outbound = withMessageId(message);
		if (this.quietGate?.shouldSuppress(outbound)) {
			this.quietGate.suppress(outbound);
			const acceptedAt = Date.now();
			const receipt: DeliveryReceipt = {
				messageId: outbound.messageId!,
				channel: outbound.channel,
				chatId: outbound.chatId,
				status: "success",
				attempts: 1,
				acceptedAt,
				deliveredAt: acceptedAt,
				detail: "queued during quiet hours",
			};
			this.bus.publishDelivery(receipt);
			return receipt;
		}
		const channel = this.requireChannel(outbound.channel);
		this.bus.recordOutbound(outbound);
		const acceptedAt = Date.now();
		const outbox = this.bus.durableOutbound;
		if (outbox && !outbox.enqueue(outbound)) {
			const existing = outbox.get?.(outbound.messageId!);
			if (existing?.receipt) {
				this.bus.publishDelivery(existing.receipt);
				return existing.receipt;
			}
			throw new Error(`outbound message is already pending: ${outbound.messageId}`);
		}
		try {
			const delivery = await this.withRetry(
				() => channel.send(outbound),
				(attempt) => this.bus.markOutboundAttempt(outbound, attempt),
			);
			const receipt = toReceipt(outbound, acceptedAt, delivery.attempts, delivery.value);
			if (receipt.status === "success" || receipt.status === "partial") outbox?.markDelivered(receipt);
			else outbox?.markFailed(receipt);
			this.bus.publishDelivery(receipt);
			// 非静默期的一次发送顺带补发积压队列。
			void this.quietGate?.flush().catch((error) => {
				console.error(`[gateway] quiet push flush failed: ${formatError(error)}`);
			});
			return receipt;
		} catch (error) {
			const receipt: DeliveryReceipt = {
				messageId: outbound.messageId!,
				channel: outbound.channel,
				chatId: outbound.chatId,
				status: "failed",
				attempts: this.maxAttempts,
				acceptedAt,
				detail: formatError(error),
			};
			outbox?.markFailed(receipt);
			this.bus.publishDelivery(receipt);
			throw error;
		}
	}

	/** 静默补发的直接发送(不重入 send,避免递归;best-effort)。 */
	private async deliverNow(message: OutboundMessage): Promise<void> {
		const channel = this.requireChannel(message.channel);
		await this.withRetry(
			() => channel.send(message),
			(attempt) => this.bus.markOutboundAttempt(message, attempt),
		);
	}

	/** Deliver a streaming delta through the named channel with bounded retry. */
	async sendDelta(delta: OutboundDelta): Promise<void> {
		this.assertInitialized();
		const channel = this.requireChannel(delta.channel);
		if (!channel.supportsStreaming) {
			throw new Error(`${delta.channel} channel does not support streaming`);
		}
		await this.withRetry(() => channel.sendDelta(delta));
	}

	/** Inspect durable complete-message records, including failed messages. */
	listOutbox(status?: OutboxStatus): OutboxRecord[] {
		return this.bus.durableOutbound?.list?.(status) ?? [];
	}

	/** List the persistent canonical message history, when configured. */
	listMessages(query?: ChannelMessageQuery): ChannelMessageRecord[] {
		return this.bus.canonicalMessages?.list(query) ?? [];
	}

	/** Whether a persistent canonical message store is configured. */
	hasMessageStore(): boolean {
		return this.bus.canonicalMessages !== undefined;
	}

	/** Requeue a failed/cancelled durable message for bounded delivery retry. */
	async retryDelivery(messageId: string): Promise<boolean> {
		this.assertInitialized();
		const message = this.bus.durableOutbound?.retry?.(messageId);
		if (!message) return false;
		this.bus.recoverOutbound();
		return true;
	}

	/** Remove terminal outbox records older than the requested retention window. */
	cleanupOutbox(options?: OutboxCleanupOptions): number {
		return this.bus.durableOutbound?.cleanup?.(options) ?? 0;
	}

	/** Inspect inbound messages that exhausted automatic application retries. */
	listInboundDeadLetters(): InboundDeadLetterRecord[] {
		return this.bus.listInboundDeadLetters();
	}

	/** Requeue a dead-lettered inbound message by provider message id or state key. */
	async retryInbound(messageId: string): Promise<boolean> {
		this.assertInitialized();
		const record = this.bus
			.listInboundDeadLetters()
			.find(
				(candidate) =>
					candidate.message.messageId === messageId || inboundMessageKey(candidate.message) === messageId,
			);
		return record ? this.bus.retryInbound(record.message) : false;
	}

	/** Apply a config snapshot immediately; file watching calls the same method. */
	async reloadConfig(config?: GatewayConfig | GatewayConfigFile): Promise<void> {
		const next = restrictChannels(
			normalizeConfig(config ?? loadGatewayConfig(this.configPath)),
			this.selectedChannels,
		);
		if (!this.initialized) {
			this.config = next;
			return;
		}
		await this.registry.reconfigure(next);
		this.config = next;
	}

	metrics(): MessageBusSnapshot {
		return this.bus.snapshot();
	}

	get interruptController(): ChannelInterruptControllerLike {
		return this.interruptControllerValue;
	}

	get events(): ChannelEventBusLike {
		return this.eventBus;
	}

	get sessionManager(): ChannelSessionManager | undefined {
		return this.sessionManagerValue;
	}

	/** Access a started channel instance, e.g. to mount host UI routes on the Web channel. */
	getChannel(name: string): BaseChannel | undefined {
		return this.registry.get(name);
	}

	/**
	 * Register a host/third-party channel type (nanobot ChannelPlugin 语义):
	 * 配置键 `channels.<name>.enabled = true` 即被实例化,带校验与 onboarding
	 * 清单。必须在 start() 之前调用。
	 */
	registerChannelType(
		name: string,
		factory: ChannelFactory,
		definition: ChannelPluginDefinition = { name, displayName: name },
	): void {
		this.registry.registerChannelType(name, factory, definition);
	}

	status(): ChannelSdkStatus[] {
		return this.registry.list().map((channel) => ({
			name: channel.name,
			displayName: channel.displayName,
			running: channel.isRunning,
			ready: channel.isReady,
			receives: this.receive,
			sends: true,
			streaming: channel.supportsStreaming,
			port: boundPort(channel),
		}));
	}

	/** Wait until every configured channel reports a usable transport. */
	async waitForReadiness(options: ChannelSdkReadinessOptions = {}): Promise<ChannelSdkStatus[]> {
		this.assertInitialized();
		const timeoutMs = positiveInteger(options.timeoutMs, 30_000);
		const pollIntervalMs = positiveInteger(options.pollIntervalMs, 100);
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const status = this.status();
			if (status.length > 0 && status.every((channel) => channel.ready)) return status;
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				const waiting =
					status
						.filter((channel) => !channel.ready)
						.map((channel) => channel.name)
						.join(",") || "no configured channels";
				throw new Error(`channel readiness timed out after ${timeoutMs}ms: ${waiting}`);
			}
			await wait(Math.min(pollIntervalMs, remainingMs));
		}
	}

	capabilities(): Record<string, ChannelSdkCapabilities>;
	capabilities(name: string): ChannelSdkCapabilities | undefined;
	capabilities(name?: string): Record<string, ChannelSdkCapabilities> | ChannelSdkCapabilities | undefined {
		const result: Record<string, ChannelSdkCapabilities> = {};
		for (const channel of this.registry.list()) {
			const declared = channel.capabilities;
			result[channel.name] = {
				receives: this.receive,
				sends: true,
				streaming: channel.supportsStreaming,
				reasoning: declared.reasoning,
				fileEdits: declared.fileEdits,
				progress: declared.progress,
				buttons: declared.buttons,
			};
		}
		return name === undefined ? result : result[name];
	}

	get isStarted(): boolean {
		return this.initialized;
	}

	private managementCallbacks(): GatewayManagement {
		return {
			status: () => this.status(),
			metrics: () => this.metrics(),
			listOutbox: (status) => this.listOutbox(status),
			listMessages: (query) => (this.hasMessageStore() ? this.listMessages(query) : undefined),
			retryDelivery: (messageId) => this.retryDelivery(messageId),
			cleanupOutbox: (options) => this.cleanupOutbox(options),
			listInboundDeadLetters: () => this.listInboundDeadLetters(),
			retryInbound: (messageId) => this.retryInbound(messageId),
			onDelivery: (listener) => this.onDelivery(listener),
			deliver: (message) => this.send(message),
			channelCatalog: () => this.registry.catalog(),
		};
	}

	private startConfigWatcher(setting: boolean | GatewayConfigWatchOptions | undefined): void {
		if (setting === undefined || setting === false || !this.configPath) return;
		const options = setting === true ? {} : setting;
		this.configWatcher = watchGatewayConfig(this.configPath, (config) => this.reloadConfig(config), {
			...options,
			onError: (error) => {
				console.error(`[gateway] config reload skipped: ${error.message}`);
				options.onError?.(error);
			},
		});
	}

	private startOutboxCleanup(): void {
		const setting = this.outboxCleanupSetting;
		const intervalMs = positiveInteger(setting?.intervalMs, 3_600_000);
		if (!setting || !this.bus.durableOutbound?.cleanup) return;
		this.outboxCleanupTimer = setInterval(() => {
			try {
				this.cleanupOutbox({
					olderThanMs: setting.olderThanMs,
					now: setting.now,
					statuses: setting.statuses,
				});
			} catch (error) {
				console.error(`[gateway] outbox cleanup failed: ${formatError(error)}`);
			}
		}, intervalMs);
		this.outboxCleanupTimer.unref?.();
	}

	private async dispatch(message: InboundMessage): Promise<void> {
		const results = await Promise.allSettled(
			[...this.handlers].map((handler) => this.scheduler.enqueue(message, () => Promise.resolve(handler(message)))),
		);
		const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failures.length > 0) {
			throw new AggregateError(
				failures.map((failure) => failure.reason),
				`message handlers failed for ${message.channel}:${message.chatId}`,
			);
		}
	}

	private requireChannel(name: string): BaseChannel {
		const channel = this.registry.get(name);
		if (!channel) throw new Error(`channel is not enabled: ${name}`);
		return channel;
	}

	private assertInitialized(): void {
		if (!this.initialized) throw new Error("channel SDK is not started");
	}

	private async withRetry<T>(
		operation: () => Promise<T>,
		onAttempt?: (attempt: number) => void,
	): Promise<{ value: T; attempts: number }> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			onAttempt?.(attempt);
			try {
				return { value: await operation(), attempts: attempt };
			} catch (error) {
				lastError = error;
				if (attempt === this.maxAttempts) break;
				const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
				if (delay > 0) await wait(delay);
			}
		}
		throw lastError instanceof Error ? lastError : new Error(formatError(lastError));
	}
}

export function createChannelSdk(options: ChannelSdkOptions = {}): ChannelSdk {
	return new ChannelSdk(options);
}

function normalizeConfig(config: GatewayConfig | GatewayConfigFile): GatewayConfig {
	return {
		...config,
		channels: config.channels as GatewayConfig["channels"],
		web: config.web,
	};
}

function withMessageId(message: OutboundMessage): OutboundMessage {
	return message.messageId ? message : { ...message, messageId: createMessageId("out") };
}

function isInboundDedupStore(
	value: ChannelSessionManager | undefined,
): value is ChannelSessionManager & InboundDedupStore {
	return (
		typeof value === "object" &&
		value !== null &&
		"seenOrRemember" in value &&
		typeof value.seenOrRemember === "function"
	);
}

function toReceipt(
	message: OutboundMessage,
	acceptedAt: number,
	attempts: number,
	// biome-ignore lint/suspicious/noConfusingVoidType: channels may return only a successful void result
	result: void | ChannelSendResult,
): ChannelSendReceipt {
	const status = result?.status ?? "success";
	return {
		messageId: message.messageId!,
		channel: message.channel,
		chatId: message.chatId,
		status,
		attempts,
		acceptedAt,
		deliveredAt: status === "success" || status === "partial" ? Date.now() : undefined,
		providerMessageId: result?.providerMessageId,
		canonicalMedia: result?.canonicalMedia,
		detail: result?.detail,
	};
}

function restrictChannels(config: GatewayConfig, selectedNames: readonly string[] | undefined): GatewayConfig {
	if (selectedNames === undefined) return config;
	const supported = new Set<string>(SUPPORTED_CHANNELS);
	for (const name of selectedNames) {
		// Multi-instance runtimes are selected by their base type.
		if (!supported.has(name.split(".")[0]!)) throw new Error(`unsupported channel: ${name}`);
	}
	const selected = new Set(selectedNames.map((name) => name.split(".")[0]!));
	const channels = { ...config.channels };
	for (const name of SUPPORTED_CHANNELS) {
		const current = channels[name];
		channels[name] = selected.has(name)
			? { ...(current ?? {}), enabled: true }
			: { ...(current ?? {}), enabled: false };
	}
	return { ...config, channels };
}

function boundPort(channel: BaseChannel): number | undefined {
	const candidate = channel as BaseChannel & { port?: unknown };
	return typeof candidate.port === "number" && candidate.port > 0 ? candidate.port : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultConfigPath(): string {
	return resolve(process.env.GATEWAY_CONFIG ?? `${process.cwd()}/config.json`);
}
