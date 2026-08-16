import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ChannelSdk, createChannelSdk } from "@cogito/gateway";
import { type Clock, SystemClock } from "./clock.ts";
import { type DeliveryOutlet, type DeliverySendReceipt, getDeliverySendStatus } from "./stages/deliver.ts";
import type { DeliveryRecord, DeliveryTargetReceipt, ProactiveStore } from "./store.ts";

export interface FeishuTarget {
	chatId: string;
}

export interface FeishuDeliveryConfig {
	appId: string;
	appSecret: string;
	domain: string;
	targets: readonly FeishuTarget[];
}

export interface FeishuDeliveryLogger {
	info(message: string): void;
	error(message: string): void;
}

export interface FeishuDeliveryOutletOptions {
	replayPending?: boolean;
	maxAttempts?: number;
	retryDelayMs?: number;
	clock?: Clock;
	fetchFn?: typeof fetch;
	logger?: FeishuDeliveryLogger;
}

const DEFAULT_DOMAIN = "https://open.feishu.cn";
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

const defaultLogger: FeishuDeliveryLogger = {
	info: (message) => console.error(message),
	error: (message) => console.error(message),
};

/** Load Feishu credentials and proactive targets from the gateway config. */
export function loadFeishuDeliveryConfig(configPath?: string): FeishuDeliveryConfig {
	const path = configPath ?? process.env.GATEWAY_CONFIG ?? resolve(process.cwd(), "config.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	} catch (error) {
		throw new Error(`failed to load Feishu delivery config ${path}: ${formatError(error)}`);
	}
	const config = parseFeishuDeliveryConfig(parsed);
	if (!config) throw new Error(`invalid Feishu delivery config ${path}: missing enabled Feishu targets`);
	return config;
}

/** Parse the shared root config without exposing or logging the app secret. */
export function parseFeishuDeliveryConfig(root: unknown): FeishuDeliveryConfig | undefined {
	const rootObject = asRecord(root);
	const channels = asRecord(rootObject?.channels);
	const feishu = asRecord(channels?.feishu);
	if (!feishu || feishu.enabled === false) return undefined;

	const appId = nonEmptyString(feishu.appId);
	const appSecret = nonEmptyString(feishu.appSecret);
	const domain = nonEmptyString(feishu.domain) ?? DEFAULT_DOMAIN;
	if (!appId || !appSecret) return undefined;

	const proactive = asRecord(rootObject?.proactive);
	const targetsValue = proactive?.targets;
	if (!Array.isArray(targetsValue)) return undefined;
	const targets = targetsValue.flatMap((value) => {
		const target = asRecord(value);
		if (!target) return [];
		const channel = target.channel;
		if (typeof channel === "string" && channel !== "feishu") return [];
		const chatId = nonEmptyString(target.chatId) ?? nonEmptyString(target.chat_id);
		return chatId ? [{ chatId }] : [];
	});
	if (targets.length === 0) return undefined;

	return { appId, appSecret, domain: domain.replace(/\/$/, ""), targets };
}

/**
 * Feishu delivery outlet for proactive and drift deliveries.
 *
 * The outlet listens to the store's delivery insert event. A row is acked only
 * after every configured Feishu target accepts the message.
 */
export class FeishuDeliveryOutlet implements DeliveryOutlet {
	private readonly store: ProactiveStore;
	private readonly config: FeishuDeliveryConfig;
	private readonly replayPending: boolean;
	private readonly maxAttempts: number;
	private readonly retryDelayMs: number;
	private readonly sdk: ChannelSdk;
	private readonly logger: FeishuDeliveryLogger;
	private readonly clock: Clock;
	private readonly queued = new Map<number, DeliveryRecord>();
	private flushPromise: Promise<void> | undefined;
	private retryTimer: NodeJS.Timeout | undefined;
	private unsubscribe: (() => void) | undefined;
	private started = false;
	private paused = false;
	private stopped = false;

	constructor(store: ProactiveStore, config: FeishuDeliveryConfig, options: FeishuDeliveryOutletOptions = {}) {
		this.store = store;
		this.config = config;
		this.replayPending = options.replayPending ?? false;
		this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
		this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
		this.clock = options.clock ?? SystemClock;
		this.sdk = createChannelSdk({
			config: {
				channels: {
					feishu: {
						enabled: true,
						appId: config.appId,
						appSecret: config.appSecret,
						domain: config.domain,
					},
				},
			},
			channels: ["feishu"],
			receive: false,
			retry: { maxAttempts: 1 },
			transport: { fetchFn: options.fetchFn },
		});
		this.logger = options.logger ?? defaultLogger;
		this.subscribe();
	}

	async start(): Promise<void> {
		if (this.started || this.stopped) return;
		await this.sdk.start();
		this.started = true;
		this.paused = false;
		this.subscribe();
		if (this.replayPending) {
			for (const record of this.store.listPendingDeliveries()) this.enqueue(record);
		}
		await this.flush();
	}

	async pause(): Promise<void> {
		if (this.stopped || this.paused) return;
		this.paused = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		if (!this.started) return;
		await this.flush();
		this.started = false;
		await this.sdk.stop();
	}

	async resume(): Promise<void> {
		if (this.stopped || !this.paused) return;
		await this.sdk.start();
		this.started = true;
		this.paused = false;
		this.subscribe();
		if (this.replayPending) {
			for (const record of this.store.listPendingDeliveries()) this.enqueue(record);
		}
		await this.flush();
	}

	async stop(): Promise<void> {
		if (!this.stopped) {
			this.stopped = true;
			this.unsubscribe?.();
			this.unsubscribe = undefined;
		}
		if (!this.started) return;
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		await this.flush();
		this.started = false;
		await this.sdk.stop();
	}

	enqueue(record: DeliveryRecord): void {
		if (this.stopped || !this.accepts(record)) return;
		this.queued.set(record.id, record);
		if (!this.started || this.paused) return;
		void this.flush().catch((error: unknown) => {
			this.logger.error(`proactive Feishu delivery queue failed: ${formatError(error)}`);
		});
	}

	async send(record: DeliveryRecord): Promise<DeliverySendReceipt> {
		if (!this.accepts(record)) {
			throw new Error(`Feishu outlet does not handle channel ${record.target_channel || "<default>"}`);
		}
		return await this.deliverWithRetry(record);
	}

	private flush(): Promise<void> {
		if (this.flushPromise) return this.flushPromise;
		const current = this.drain().finally(() => {
			if (this.flushPromise === current) this.flushPromise = undefined;
		});
		this.flushPromise = current;
		return current;
	}

	private async drain(): Promise<void> {
		while (this.queued.size > 0) {
			const next = this.queued.entries().next().value as [number, DeliveryRecord] | undefined;
			if (!next) return;
			const [id, record] = next;
			this.queued.delete(id);
			try {
				const receipt = await this.send(record);
				const status = getDeliverySendStatus(receipt);
				this.store.recordDeliveryReceipt(id, {
					providerMessageId: receipt.providerMessageId,
					targetReceipts: receipt.targetReceipts,
				});
				if (status !== "success") {
					this.store.recordDeliveryFailure(id, status, receipt.detail, {
						providerMessageId: receipt.providerMessageId,
						targetReceipts: receipt.targetReceipts,
						detail: receipt.detail,
					});
					this.queued.set(id, record);
					this.scheduleRetry();
					return;
				}
				this.store.ackDeliveries([id]);
			} catch (error) {
				this.store.recordDeliveryFailure(id, "failed", formatError(error));
				this.logger.error(
					`proactive Feishu delivery failed id=${id} attempts=${this.maxAttempts}: ${formatError(error)}`,
				);
				this.queued.set(id, record);
				this.scheduleRetry();
				return;
			}
		}
	}

	private scheduleRetry(): void {
		if (this.stopped || !this.started || this.retryTimer) return;
		this.retryTimer = setTimeout(
			() => {
				this.retryTimer = undefined;
				void this.flush().catch((error: unknown) => {
					this.logger.error(`proactive Feishu retry failed: ${formatError(error)}`);
				});
			},
			Math.max(1, this.retryDelayMs),
		);
	}

	private async deliverWithRetry(record: DeliveryRecord): Promise<DeliverySendReceipt> {
		const current = this.store.getDelivery(record.id) ?? record;
		const receipts = [...current.target_receipts];
		const targets = this.targetsFor(current);
		if (targets.length === 0) return { status: "failed", detail: "no Feishu targets configured" };

		for (const target of targets) {
			const existing = receipts.find((receipt) => receipt.target === target.chatId && receipt.status === "success");
			if (existing) continue;
			const targetReceipt = await this.deliverTargetWithRetry(current, target.chatId);
			const index = receipts.findIndex((receipt) => receipt.target === target.chatId);
			if (index >= 0) receipts[index] = targetReceipt;
			else receipts.push(targetReceipt);
			this.store.recordDeliveryReceipt(current.id, {
				providerMessageId: targetReceipt.providerMessageId,
				targetReceipts: [targetReceipt],
			});
		}

		const failed = receipts.filter((receipt) => receipt.status !== "success");
		return {
			status: failed.length === 0 ? "success" : failed.length < receipts.length ? "partial" : "failed",
			providerMessageId: receipts.find((receipt) => receipt.providerMessageId)?.providerMessageId,
			targetReceipts: receipts,
			detail: failed[0]?.detail,
		};
	}

	private async deliverTargetWithRetry(record: DeliveryRecord, chatId: string): Promise<DeliveryTargetReceipt> {
		let lastError = "delivery failed";
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			try {
				const receipt = await this.sdk.send({
					messageId: targetMessageId(record.idempotency_key, chatId),
					channel: "feishu",
					chatId,
					content: record.message,
					media: record.media.length > 0 ? record.media : undefined,
					attachments: record.attachments.length > 0 ? record.attachments : undefined,
					metadata: { proactiveIdempotencyKey: record.idempotency_key },
				});
				const status = receipt.status;
				if (status === "success" || status === "partial") {
					return {
						target: chatId,
						status,
						attempts: attempt,
						messageId: receipt.messageId,
						providerMessageId: receipt.providerMessageId,
						detail: receipt.detail,
						updatedAt: this.clock.nowMs(),
					};
				}
				lastError = receipt.detail ?? `provider status: ${status}`;
			} catch (error) {
				lastError = formatError(error);
			}
			if (attempt < this.maxAttempts && this.retryDelayMs > 0) await wait(this.retryDelayMs * attempt);
		}
		return {
			target: chatId,
			status: "failed",
			attempts: this.maxAttempts,
			detail: lastError,
			updatedAt: this.clock.nowMs(),
		};
	}

	private accepts(record: DeliveryRecord): boolean {
		const channel = record.target_channel.trim();
		return channel.length === 0 || channel === "feishu";
	}

	private subscribe(): void {
		if (!this.unsubscribe) this.unsubscribe = this.store.onDelivery((record) => this.enqueue(record));
	}

	private targetsFor(record: DeliveryRecord): readonly FeishuTarget[] {
		const chatId = record.target_chat_id.trim();
		return chatId ? [{ chatId }] : this.config.targets;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function targetMessageId(idempotencyKey: string, chatId: string): string {
	return `proactive_${createHash("sha256").update(`${idempotencyKey}\u0000${chatId}`).digest("hex").slice(0, 32)}`;
}
