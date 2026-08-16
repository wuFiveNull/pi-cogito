/**
 * 多通道投递出口 —— 基于 gateway 投递 SDK(createDeliveryClient)。
 *
 * 通过 gateway 的 /api/deliver(HTTP)复用 gateway 进程持有的通道连接,
 * 把 deliveries 记录投递到 config.json proactive.targets 配置的全部目标
 * (feishu / qq / onebot / napcat)。生命周期(队列/重试/暂停恢复)与
 * FeishuDeliveryOutlet 一致。
 */

import { createHash } from "node:crypto";
import { createDeliveryClient, type DeliveryClient, type DeliveryTarget, loadDeliveryTargets } from "@cogito/gateway";
import { type Clock, SystemClock } from "./clock.ts";
import { type DeliveryOutlet, type DeliverySendReceipt, getDeliverySendStatus } from "./stages/deliver.ts";
import type { DeliveryRecord, DeliveryTargetReceipt, ProactiveStore } from "./store.ts";

export interface GatewayDeliveryLogger {
	info(message: string): void;
	error(message: string): void;
}

export interface GatewayDeliveryOutletOptions {
	/** 根配置路径(默认 GATEWAY_CONFIG 或 cwd/config.json)。 */
	configPath?: string;
	/** 直接传入根配置对象(测试用),优先于 configPath。 */
	config?: unknown;
	/** 注入投递客户端(测试用);缺省 createDeliveryClient(configPath)。 */
	client?: DeliveryClient;
	replayPending?: boolean;
	maxAttempts?: number;
	retryDelayMs?: number;
	clock?: Clock;
	fetchFn?: typeof fetch;
	logger?: GatewayDeliveryLogger;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

const defaultLogger: GatewayDeliveryLogger = {
	info: (message) => console.error(message),
	error: (message) => console.error(message),
};

/** 从根配置读取投递目标(proactive.targets),并检查是否至少启用了一个投递通道。 */
export function loadGatewayDeliveryConfig(options: GatewayDeliveryOutletOptions = {}): {
	targets: DeliveryTarget[];
	configPath: string | undefined;
} {
	const config = options.config !== undefined ? options.config : undefined;
	const targets = loadDeliveryTargets({
		...(config !== undefined ? { config } : {}),
		configPath: options.configPath,
		fetchFn: options.fetchFn,
	});
	return { targets, configPath: options.configPath };
}

/**
 * 多通道投递出口。投递到 config.json proactive.targets 里配置的全部目标
 * (feishu / qq / onebot / napcat);记录带 target_channel/target_chat_id 时
 * 走显式路由,否则投递到默认目标。
 */
export class GatewayDeliveryOutlet implements DeliveryOutlet {
	private readonly store: ProactiveStore;
	private readonly client: DeliveryClient;
	private readonly targets: DeliveryTarget[];
	private readonly replayPending: boolean;
	private readonly maxAttempts: number;
	private readonly retryDelayMs: number;
	private readonly clock: Clock;
	private readonly logger: GatewayDeliveryLogger;
	private readonly queued = new Map<number, DeliveryRecord>();
	private flushPromise: Promise<void> | undefined;
	private retryTimer: NodeJS.Timeout | undefined;
	private unsubscribe: (() => void) | undefined;
	private started = false;
	private paused = false;
	private stopped = false;

	constructor(store: ProactiveStore, options: GatewayDeliveryOutletOptions = {}) {
		this.store = store;
		this.replayPending = options.replayPending ?? false;
		this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
		this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
		this.clock = options.clock ?? SystemClock;
		this.logger = options.logger ?? defaultLogger;
		const { targets } = loadGatewayDeliveryConfig(options);
		this.targets = targets;
		this.client =
			options.client ??
			createDeliveryClient({
				...(options.config !== undefined ? { config: options.config } : {}),
				configPath: options.configPath,
				fetchFn: options.fetchFn,
			});
		this.subscribe();
	}

	get enabledTargets(): readonly DeliveryTarget[] {
		return this.targets;
	}

	async start(): Promise<void> {
		if (this.started || this.stopped) return;
		await this.client.start();
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
		await this.client.stop();
	}

	async resume(): Promise<void> {
		if (this.stopped || !this.paused) return;
		await this.client.start();
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
		await this.client.stop();
	}

	enqueue(record: DeliveryRecord): void {
		if (this.stopped || !this.accepts(record)) return;
		this.queued.set(record.id, record);
		if (!this.started || this.paused) return;
		void this.flush().catch((error: unknown) => {
			this.logger.error(`proactive gateway delivery queue failed: ${formatError(error)}`);
		});
	}

	async send(record: DeliveryRecord): Promise<DeliverySendReceipt> {
		if (!this.accepts(record)) {
			throw new Error(`Gateway outlet does not handle channel ${record.target_channel || "<default>"}`);
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
					this.store.recordDeliveryFailure(id, status, receipt.detail);
					this.queued.set(id, record);
					this.scheduleRetry();
					return;
				}
				this.store.ackDeliveries([id]);
			} catch (error) {
				this.store.recordDeliveryFailure(id, "failed", formatError(error));
				this.logger.error(
					`proactive gateway delivery failed id=${id} attempts=${this.maxAttempts}: ${formatError(error)}`,
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
					this.logger.error(`proactive gateway retry failed: ${formatError(error)}`);
				});
			},
			Math.max(1, this.retryDelayMs),
		);
	}

	private async deliverWithRetry(record: DeliveryRecord): Promise<DeliverySendReceipt> {
		const current = this.store.getDelivery(record.id) ?? record;
		const receipts = [...current.target_receipts];
		const targets = this.targetsFor(current);
		if (targets.length === 0) return { status: "failed", detail: "no delivery targets configured" };

		for (const target of targets) {
			const existing = receipts.find((receipt) => receipt.target === target.chatId && receipt.status === "success");
			if (existing) continue;
			const targetReceipt = await this.deliverTargetWithRetry(current, target);
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

	private async deliverTargetWithRetry(
		record: DeliveryRecord,
		target: DeliveryTarget,
	): Promise<DeliveryTargetReceipt> {
		let lastError = "delivery failed";
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			try {
				const receipt = await this.client.send({
					messageId: targetMessageId(record.idempotency_key, target.chatId),
					channel: target.channel,
					chatId: target.chatId,
					content: record.message,
					media: record.media.length > 0 ? record.media : undefined,
					attachments: record.attachments.length > 0 ? record.attachments : undefined,
					metadata: { proactiveIdempotencyKey: record.idempotency_key },
				});
				const status = receipt.status;
				if (status === "success" || status === "partial") {
					return {
						target: target.chatId,
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
			target: target.chatId,
			status: "failed",
			attempts: this.maxAttempts,
			detail: lastError,
			updatedAt: this.clock.nowMs(),
		};
	}

	private accepts(record: DeliveryRecord): boolean {
		const channel = record.target_channel.trim();
		return channel.length === 0 || this.targets.some((target) => target.channel === channel);
	}

	private subscribe(): void {
		if (!this.unsubscribe) this.unsubscribe = this.store.onDelivery((record) => this.enqueue(record));
	}

	private targetsFor(record: DeliveryRecord): readonly DeliveryTarget[] {
		const channel = record.target_channel.trim();
		const chatId = record.target_chat_id.trim();
		if (channel && chatId) {
			return this.targets.some((target) => target.channel === channel) ? [{ channel, chatId }] : [];
		}
		if (chatId) {
			// 只指定了 chatId 时,投递到所有默认目标里 channel 匹配的记录通道。
			const defaultChannel = this.targets[0]?.channel;
			return defaultChannel ? [{ channel: defaultChannel, chatId }] : [];
		}
		return this.targets;
	}
}

/** 便捷工厂:创建并返回多通道投递出口(与 buildPusher 的 outlet 注入点对接)。 */
export function createGatewayDeliveryOutlet(
	store: ProactiveStore,
	options: GatewayDeliveryOutletOptions = {},
): GatewayDeliveryOutlet {
	return new GatewayDeliveryOutlet(store, options);
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
