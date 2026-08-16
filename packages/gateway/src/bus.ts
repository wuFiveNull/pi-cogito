/**
 * MessageBus — bounded asynchronous queues between channels and the agent.
 *
 * The bus deliberately remains in-process, but it now has explicit lifecycle
 * and backpressure semantics. A host can add durable persistence around the
 * publish/consume boundary without changing channel implementations.
 */

import {
	type InboundDeadLetterRecord,
	type InboundDeadLetterStore,
	InMemoryInboundDeadLetterStore,
} from "./inbound-dlq.ts";
import type { ChannelMessageStore } from "./messages.ts";
import type { OutboundOutbox } from "./outbox.ts";
import {
	type InboundDedupStore,
	type InboundHandoffStore,
	InMemoryInboundDedupStore,
	inboundMessageKey,
} from "./state.ts";
import {
	createMessageId,
	type DeliveryReceipt,
	type InboundMessage,
	type OutboundDelta,
	type OutboundMessage,
} from "./types.ts";

interface Waiter<T> {
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export type InboundListener = (message: InboundMessage) => void | Promise<void>;
export type DeliveryListener = (receipt: DeliveryReceipt) => void | Promise<void>;

export interface MessageBusSnapshot {
	inboundQueued: number;
	outboundQueued: number;
	deltaQueued: number;
	inboundAccepted: number;
	inboundDuplicates: number;
	outboundAccepted: number;
	deltaAccepted: number;
	deliveryEvents: number;
	inboundRetries: number;
	inboundFailures: number;
	inboundDeadLetters: number;
	inboundDeadLetterQueued: number;
	inboundHandoffPending: number;
	inboundHandoffDelivering: number;
	outboxPending: number;
	outboxDelivering: number;
	outboxDelivered: number;
	outboxFailed: number;
	outboxCancelled: number;
}

export interface InboundRetryOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
}

export interface MessageBusOptions {
	/** Maximum queued inbound messages. Defaults to 1000. */
	maxInbound?: number;
	/** Maximum queued complete outbound messages. Defaults to 1000. */
	maxOutbound?: number;
	/** Maximum queued streaming deltas. Defaults to 2000. */
	maxDelta?: number;
	/** Number of inbound event ids retained for duplicate suppression. */
	inboundDedupeSize?: number;
	/** Optional store for duplicate suppression across gateway instances/restarts. */
	inboundDedupStore?: InboundDedupStore;
	/** Optional durable inbound handoff queue. It also provides deduplication. */
	inboundHandoffStore?: InboundHandoffStore;
	/** Optional durable logical-message store for complete outbound messages. */
	outboundOutbox?: OutboundOutbox;
	/** Optional canonical store for complete inbound and outbound messages. */
	messageStore?: ChannelMessageStore;
	/** Automatic retry policy for failures reported by consuming inbound handlers. */
	inboundRetry?: InboundRetryOptions;
	/** Store for inbound messages that exhaust the retry policy. */
	inboundDeadLetterStore?: InboundDeadLetterStore;
}

export class MessageBusClosedError extends Error {
	readonly code = "MESSAGE_BUS_CLOSED";

	constructor(message = "message bus is closed") {
		super(message);
		this.name = "MessageBusClosedError";
	}
}

export class MessageBusConsumerAbortedError extends Error {
	readonly code = "MESSAGE_BUS_CONSUMER_ABORTED";

	constructor() {
		super("message bus consumer was aborted");
		this.name = "MessageBusConsumerAbortedError";
	}
}

export class MessageBusOverflowError extends Error {
	readonly code = "MESSAGE_BUS_OVERFLOW";
	readonly queue: "inbound" | "outbound" | "delta";
	readonly limit: number;

	constructor(queue: "inbound" | "outbound" | "delta", limit: number) {
		super(`${queue} message queue is full (limit=${limit})`);
		this.name = "MessageBusOverflowError";
		this.queue = queue;
		this.limit = limit;
	}
}

export class MessageBus {
	private inboundQueue: InboundMessage[] = [];
	private outboundQueue: OutboundMessage[] = [];
	private deltaQueue: OutboundDelta[] = [];
	private inboundWaiters: Waiter<InboundMessage>[] = [];
	private outboundWaiters: Waiter<OutboundMessage>[] = [];
	private deltaWaiters: Waiter<OutboundDelta>[] = [];
	private readonly inboundListeners = new Set<InboundListener>();
	private readonly inboundDrainers = new Set<InboundListener>();
	private readonly deliveryListeners = new Set<DeliveryListener>();
	private readonly maxInbound: number;
	private readonly maxOutbound: number;
	private readonly maxDelta: number;
	private readonly inboundDeduper: InboundDedupStore;
	private readonly inboundHandoffStore: InboundHandoffStore | undefined;
	private readonly outboundOutbox: OutboundOutbox | undefined;
	private readonly messageStore: ChannelMessageStore | undefined;
	private readonly inboundDeadLetterStore: InboundDeadLetterStore;
	private readonly inboundMaxAttempts: number;
	private readonly inboundBaseDelayMs: number;
	private readonly inboundMaxDelayMs: number;
	private readonly inboundAttempts = new Map<string, number>();
	private readonly inboundDelivering = new Set<string>();
	private readonly inboundRetryTimers = new Map<string, NodeJS.Timeout>();
	private readonly inboundFirstFailureAt = new Map<string, number>();
	private inboundRecoveryTimer: NodeJS.Timeout | undefined;
	private inboundAccepted = 0;
	private inboundDuplicates = 0;
	private outboundAccepted = 0;
	private deltaAccepted = 0;
	private deliveryEvents = 0;
	private inboundRetries = 0;
	private inboundFailures = 0;
	private inboundDeadLetters = 0;
	private closed = false;

	constructor(options: MessageBusOptions = {}) {
		this.maxInbound = positiveLimit(options.maxInbound, 1000);
		this.maxOutbound = positiveLimit(options.maxOutbound, 1000);
		this.maxDelta = positiveLimit(options.maxDelta, 2000);
		this.inboundHandoffStore = options.inboundHandoffStore;
		this.inboundDeduper =
			this.inboundHandoffStore ??
			options.inboundDedupStore ??
			new InMemoryInboundDedupStore(options.inboundDedupeSize ?? 4096);
		this.outboundOutbox = options.outboundOutbox;
		this.messageStore = options.messageStore;
		this.inboundDeadLetterStore = options.inboundDeadLetterStore ?? new InMemoryInboundDeadLetterStore();
		this.inboundMaxAttempts = positiveLimit(options.inboundRetry?.maxAttempts, 3);
		this.inboundBaseDelayMs = nonNegativeNumber(options.inboundRetry?.baseDelayMs, 1000);
		this.inboundMaxDelayMs = nonNegativeNumber(options.inboundRetry?.maxDelayMs, 30_000);
	}

	// ------------------------------------------------------------------
	// Inbound (channels -> agent)
	// ------------------------------------------------------------------

	/**
	 * Publish an inbound message. Returns false when the stable event id was
	 * already accepted by this bus; overflow and lifecycle errors are explicit.
	 */
	publishInbound(message: InboundMessage): boolean {
		this.assertOpen();
		const key = inboundMessageKey(message);
		if (this.inboundDeduper.has?.(key)) {
			this.inboundDuplicates++;
			return false;
		}
		if (this.inboundWaiters.length === 0 && this.inboundDrainers.size === 0) {
			this.assertCapacity(this.inboundQueue, this.inboundWaiters, "inbound", this.maxInbound);
		}
		this.messageStore?.recordInbound(message);
		const accepted = this.inboundHandoffStore
			? this.inboundHandoffStore.accept(message)
			: !this.inboundDeduper.seenOrRemember(key);
		if (!accepted) {
			this.inboundDuplicates++;
			return false;
		}
		this.inboundAccepted++;
		if (this.inboundWaiters.length > 0) {
			this.enqueue(this.inboundQueue, this.inboundWaiters, message);
		} else if (this.inboundDrainers.size === 0) {
			this.inboundQueue.push(message);
		}
		if (this.inboundDrainers.size > 0) this.deliverInbound(message);
		else this.notifyInbound(message);
		return true;
	}

	/** Subscribe to inbound messages without removing them from the queue. */
	onInbound(listener: InboundListener, options: { consume?: boolean } = {}): () => void {
		this.inboundListeners.add(listener);
		if (options.consume) this.inboundDrainers.add(listener);
		return () => {
			this.inboundListeners.delete(listener);
			this.inboundDrainers.delete(listener);
		};
	}

	/** Resolves with the next inbound message; rejects on close or abort. */
	consumeInbound(signal?: AbortSignal): Promise<InboundMessage> {
		return this.consume(this.inboundQueue, this.inboundWaiters, signal).then((message) => {
			const attempt =
				this.inboundHandoffStore?.markDelivering(message) ??
				(this.inboundAttempts.get(inboundMessageKey(message)) ?? 0) + 1;
			this.inboundAttempts.set(inboundMessageKey(message), attempt);
			this.persistMessageStore("inbound processing", () =>
				this.messageStore?.markInboundProcessing(message, attempt),
			);
			return message;
		});
	}

	/** Requeue durable messages left pending by a previous process. */
	recoverInbound(): void {
		if (!this.inboundHandoffStore || this.closed) return;
		for (const message of this.inboundHandoffStore.recoverPending()) {
			const key = inboundMessageKey(message);
			if (this.inboundQueue.some((queued) => inboundMessageKey(queued) === key)) continue;
			if (this.inboundDrainers.size > 0) {
				this.deliverInbound(message);
				continue;
			}
			if (this.inboundQueue.length >= this.maxInbound) break;
			this.inboundQueue.push(message);
		}
		this.schedulePersistedInboundRecovery();
	}

	/** Acknowledge an inbound message after the application has accepted it. */
	ackInbound(message: InboundMessage): void {
		this.inboundHandoffStore?.markDelivered(message);
		this.persistMessageStore("inbound completion", () => this.messageStore?.markInboundCompleted(message));
		const key = inboundMessageKey(message);
		this.inboundAttempts.delete(key);
		this.inboundFirstFailureAt.delete(key);
	}

	/** List messages that exhausted automatic inbound delivery retries. */
	listInboundDeadLetters(): InboundDeadLetterRecord[] {
		return this.inboundDeadLetterStore.list();
	}

	/** Requeue an inbound dead letter for another application attempt. */
	retryInbound(message: InboundMessage): boolean {
		const key = inboundMessageKey(message);
		if (!this.inboundDeadLetterStore.get(key)) return false;
		if (this.inboundDrainers.size === 0 && this.inboundWaiters.length === 0) {
			this.assertCapacity(this.inboundQueue, this.inboundWaiters, "inbound", this.maxInbound);
		}
		this.inboundHandoffStore?.requeue(message);
		this.inboundDeadLetterStore.remove(key);
		this.persistMessageStore("inbound requeue", () => this.messageStore?.markInboundRequeued(message));
		this.inboundAttempts.delete(key);
		this.inboundAccepted++;
		if (this.inboundDrainers.size > 0) this.deliverInbound(message);
		else this.enqueue(this.inboundQueue, this.inboundWaiters, message);
		return true;
	}

	// ------------------------------------------------------------------
	// Outbound (agent -> channels)
	// ------------------------------------------------------------------

	recordOutbound(message: OutboundMessage): void {
		if (!message.messageId) message.messageId = createMessageId("out");
		this.messageStore?.recordOutbound(message);
	}

	publishOutbound(message: OutboundMessage): void {
		this.assertOpen();
		this.assertCapacity(this.outboundQueue, this.outboundWaiters, "outbound", this.maxOutbound);
		this.recordOutbound(message);
		if (this.outboundOutbox && !this.outboundOutbox.enqueue(message)) return;
		this.outboundAccepted++;
		this.enqueue(this.outboundQueue, this.outboundWaiters, message);
	}

	/** Requeue durable messages left pending by a previous process. */
	recoverOutbound(): void {
		if (!this.outboundOutbox || this.closed) return;
		for (const message of this.outboundOutbox.recoverPending()) {
			this.messageStore?.recordOutbound(message);
			if (this.outboundQueue.length >= this.maxOutbound && this.outboundWaiters.length === 0) return;
			if (this.outboundQueue.some((queued) => queued.messageId === message.messageId)) continue;
			this.enqueue(this.outboundQueue, this.outboundWaiters, message);
		}
	}

	get durableOutbound(): OutboundOutbox | undefined {
		return this.outboundOutbox;
	}

	get canonicalMessages(): ChannelMessageStore | undefined {
		return this.messageStore;
	}

	markOutboundAttempt(message: OutboundMessage, attempt: number): void {
		this.outboundOutbox?.markAttempt(message.messageId!, attempt);
		this.persistMessageStore("outbound attempt", () => this.messageStore?.markOutboundAttempt(message, attempt));
	}

	consumeOutbound(signal?: AbortSignal): Promise<OutboundMessage> {
		return this.consume(this.outboundQueue, this.outboundWaiters, signal);
	}

	publishDelta(delta: OutboundDelta): void {
		this.assertOpen();
		this.assertCapacity(this.deltaQueue, this.deltaWaiters, "delta", this.maxDelta);
		this.deltaAccepted++;
		this.enqueue(this.deltaQueue, this.deltaWaiters, delta);
	}

	consumeDelta(signal?: AbortSignal): Promise<OutboundDelta> {
		return this.consume(this.deltaQueue, this.deltaWaiters, signal);
	}

	/** Non-blocking delta dequeue for dispatcher-side coalescing. */
	tryConsumeDelta(): OutboundDelta | undefined {
		if (this.closed || this.deltaQueue.length === 0) return undefined;
		return this.deltaQueue.shift();
	}

	// ------------------------------------------------------------------
	// Delivery events
	// ------------------------------------------------------------------

	onDelivery(listener: DeliveryListener): () => void {
		this.deliveryListeners.add(listener);
		return () => this.deliveryListeners.delete(listener);
	}

	publishDelivery(receipt: DeliveryReceipt): void {
		this.deliveryEvents++;
		this.persistMessageStore("outbound delivery", () => this.messageStore?.recordDelivery(receipt));
		for (const listener of this.deliveryListeners) {
			try {
				void Promise.resolve(listener(receipt)).catch((error: unknown) => {
					console.error(`[gateway] delivery listener failed: ${formatError(error)}`);
				});
			} catch (error) {
				console.error(`[gateway] delivery listener failed: ${formatError(error)}`);
			}
		}
	}

	// ------------------------------------------------------------------
	// Lifecycle
	// ------------------------------------------------------------------

	/** Reject pending consumers and prevent further publishes. */
	close(reason?: string): void {
		if (this.closed) return;
		this.closed = true;
		this.inboundQueue = [];
		this.outboundQueue = [];
		this.deltaQueue = [];
		if (this.inboundRecoveryTimer) clearTimeout(this.inboundRecoveryTimer);
		this.inboundRecoveryTimer = undefined;
		for (const timer of this.inboundRetryTimers.values()) clearTimeout(timer);
		this.inboundRetryTimers.clear();
		this.inboundDelivering.clear();
		this.inboundFirstFailureAt.clear();
		this.rejectWaiters(this.inboundWaiters, new MessageBusClosedError(reason));
		this.rejectWaiters(this.outboundWaiters, new MessageBusClosedError(reason));
		this.rejectWaiters(this.deltaWaiters, new MessageBusClosedError(reason));
	}

	/** Reopen a previously closed bus for a fresh gateway lifecycle. */
	reopen(): void {
		this.closed = false;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	get inboundSize(): number {
		return this.inboundQueue.length;
	}

	get outboundSize(): number {
		return this.outboundQueue.length;
	}

	get deltaSize(): number {
		return this.deltaQueue.length;
	}

	snapshot(): MessageBusSnapshot {
		return {
			inboundQueued: this.inboundQueue.length,
			outboundQueued: this.outboundQueue.length,
			deltaQueued: this.deltaQueue.length,
			inboundAccepted: this.inboundAccepted,
			inboundDuplicates: this.inboundDuplicates,
			outboundAccepted: this.outboundAccepted,
			deltaAccepted: this.deltaAccepted,
			deliveryEvents: this.deliveryEvents,
			inboundRetries: this.inboundRetries,
			inboundFailures: this.inboundFailures,
			inboundDeadLetters: this.inboundDeadLetters,
			inboundDeadLetterQueued: this.inboundDeadLetterStore.list().length,
			inboundHandoffPending:
				this.inboundHandoffStore?.list?.().filter((record) => record.status === "pending").length ?? 0,
			inboundHandoffDelivering:
				this.inboundHandoffStore?.list?.().filter((record) => record.status === "delivering").length ?? 0,
			outboxPending: this.outboundOutbox?.list?.("pending").length ?? 0,
			outboxDelivering: this.outboundOutbox?.list?.("delivering").length ?? 0,
			outboxDelivered: this.outboundOutbox?.list?.("delivered").length ?? 0,
			outboxFailed: this.outboundOutbox?.list?.("failed").length ?? 0,
			outboxCancelled: this.outboundOutbox?.list?.("cancelled").length ?? 0,
		};
	}

	private enqueue<T>(queue: T[], waiters: Waiter<T>[], value: T): void {
		const waiter = waiters.shift();
		if (waiter) {
			this.detachAbort(waiter);
			waiter.resolve(value);
			return;
		}
		queue.push(value);
	}

	private deliverInbound(message: InboundMessage): void {
		const key = inboundMessageKey(message);
		if (this.inboundDelivering.has(key)) return;
		this.inboundDelivering.add(key);
		const attempt = this.inboundHandoffStore?.markDelivering(message) ?? (this.inboundAttempts.get(key) ?? 0) + 1;
		this.inboundAttempts.set(key, attempt);
		this.persistMessageStore("inbound processing", () => this.messageStore?.markInboundProcessing(message, attempt));
		this.notifyInbound(message);
	}

	private notifyInbound(message: InboundMessage): void {
		const drainPromises: Promise<void>[] = [];
		for (const listener of this.inboundListeners) {
			const task = Promise.resolve().then(() => listener(message));
			if (this.inboundDrainers.has(listener)) drainPromises.push(task);
			void task.catch((error: unknown) => {
				console.error(`[gateway] inbound listener failed: ${formatError(error)}`);
			});
		}
		if (drainPromises.length === 0) return;
		void Promise.all(drainPromises).then(
			() => {
				this.inboundDelivering.delete(inboundMessageKey(message));
				this.ackInbound(message);
			},
			(error: unknown) => this.handleInboundFailure(message, error),
		);
	}

	private handleInboundFailure(message: InboundMessage, error: unknown): void {
		const key = inboundMessageKey(message);
		this.inboundDelivering.delete(key);
		this.inboundFailures++;
		const attempt = this.inboundAttempts.get(key) ?? 1;
		const detail = formatError(error);
		const firstFailedAt = this.inboundFirstFailureAt.get(key) ?? Date.now();
		this.inboundFirstFailureAt.set(key, firstFailedAt);
		if (attempt < this.inboundMaxAttempts) {
			this.inboundRetries++;
			const nextAttemptAt = Date.now() + retryDelay(attempt, this.inboundBaseDelayMs, this.inboundMaxDelayMs);
			this.persistMessageStore("inbound retry", () => this.messageStore?.markInboundRetry(message, attempt, detail));
			if (this.inboundHandoffStore) {
				try {
					this.inboundHandoffStore.markRetry(message, detail, nextAttemptAt);
					this.schedulePersistedInboundRecovery();
				} catch (storeError) {
					console.error(`[gateway] inbound retry state persistence failed: ${formatError(storeError)}`);
					this.scheduleInboundRetry(message, nextAttemptAt);
				}
			} else {
				this.scheduleInboundRetry(message, nextAttemptAt);
			}
			return;
		}

		try {
			this.inboundDeadLetterStore.enqueue({
				message: { ...message },
				attempts: attempt,
				firstFailedAt,
				failedAt: Date.now(),
				lastError: detail,
			});
			this.inboundHandoffStore?.markDeadLetter(message);
			this.persistMessageStore("inbound dead letter", () =>
				this.messageStore?.markInboundDeadLetter(message, attempt, detail),
			);
			this.inboundDeadLetters++;
			this.inboundAttempts.delete(key);
			this.inboundFirstFailureAt.delete(key);
		} catch (storeError) {
			console.error(`[gateway] inbound dead-letter persistence failed: ${formatError(storeError)}`);
			const nextAttemptAt = Date.now() + retryDelay(attempt, this.inboundBaseDelayMs, this.inboundMaxDelayMs);
			if (this.inboundHandoffStore) {
				try {
					this.inboundHandoffStore.markRetry(message, detail, nextAttemptAt);
				} catch (retryError) {
					console.error(`[gateway] inbound retry state persistence failed: ${formatError(retryError)}`);
				}
			}
			this.scheduleInboundRetry(message, nextAttemptAt);
		}
	}

	private scheduleInboundRetry(message: InboundMessage, nextAttemptAt: number): void {
		const key = inboundMessageKey(message);
		const previous = this.inboundRetryTimers.get(key);
		if (previous) clearTimeout(previous);
		const timer = setTimeout(
			() => {
				this.inboundRetryTimers.delete(key);
				if (this.closed) return;
				this.deliverInbound(message);
			},
			Math.max(1, nextAttemptAt - Date.now()),
		);
		timer.unref?.();
		this.inboundRetryTimers.set(key, timer);
	}

	private schedulePersistedInboundRecovery(): void {
		if (!this.inboundHandoffStore?.nextPendingAt || this.closed) return;
		const nextAttemptAt = this.inboundHandoffStore.nextPendingAt();
		if (nextAttemptAt === undefined) return;
		if (this.inboundRecoveryTimer) clearTimeout(this.inboundRecoveryTimer);
		this.inboundRecoveryTimer = setTimeout(
			() => {
				this.inboundRecoveryTimer = undefined;
				if (this.closed) return;
				this.recoverInbound();
			},
			Math.max(1, nextAttemptAt - Date.now()),
		);
		this.inboundRecoveryTimer.unref?.();
	}

	private persistMessageStore(label: string, operation: () => void): void {
		try {
			operation();
		} catch (error) {
			console.error(`[gateway] ${label} persistence failed: ${formatError(error)}`);
		}
	}

	private consume<T>(queue: T[], waiters: Waiter<T>[], signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) return Promise.reject(new MessageBusConsumerAbortedError());
		if (queue.length > 0) return Promise.resolve(queue.shift()!);
		if (this.closed) return Promise.reject(new MessageBusClosedError());

		return new Promise<T>((resolve, reject) => {
			const waiter: Waiter<T> = { resolve, reject, signal };
			const onAbort = (): void => {
				const index = waiters.indexOf(waiter);
				if (index === -1) return;
				waiters.splice(index, 1);
				this.detachAbort(waiter);
				reject(new MessageBusConsumerAbortedError());
			};
			waiter.onAbort = onAbort;
			signal?.addEventListener("abort", onAbort, { once: true });
			waiters.push(waiter);
		});
	}

	private assertOpen(): void {
		if (this.closed) throw new MessageBusClosedError();
	}

	private assertCapacity<T>(
		queue: T[],
		waiters: Waiter<T>[],
		name: "inbound" | "outbound" | "delta",
		limit: number,
	): void {
		if (waiters.length === 0 && queue.length >= limit) throw new MessageBusOverflowError(name, limit);
	}

	private rejectWaiters<T>(waiters: Waiter<T>[], error: Error): void {
		for (const waiter of waiters.splice(0)) {
			this.detachAbort(waiter);
			waiter.reject(error);
		}
	}

	private detachAbort<T>(waiter: Waiter<T>): void {
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
	}
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function retryDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
	return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
