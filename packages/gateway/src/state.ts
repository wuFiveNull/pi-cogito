import { atomicWriteJson, readRegularFile, withFileStateLock } from "./file-state.ts";
import type { InboundMessage } from "./types.ts";

/** Pluggable idempotency store used by MessageBus for inbound events. */
export interface InboundDedupStore {
	/** Optional fast duplicate lookup used before a bounded queue check. */
	has?(key: string): boolean;
	/** Returns true when the key was already accepted, and remembers new keys. */
	seenOrRemember(key: string): boolean;
}

/** Process-local bounded idempotency store. */
export class InMemoryInboundDedupStore implements InboundDedupStore {
	private readonly maxSize: number;
	private readonly keys = new Set<string>();
	private readonly order: string[] = [];

	constructor(maxSize = 4096) {
		this.maxSize = positiveLimit(maxSize);
	}

	seenOrRemember(key: string): boolean {
		if (this.keys.has(key)) return true;
		this.keys.add(key);
		this.order.push(key);
		while (this.order.length > this.maxSize) {
			const oldest = this.order.shift();
			if (oldest !== undefined) this.keys.delete(oldest);
		}
		return false;
	}

	has(key: string): boolean {
		return this.keys.has(key);
	}

	snapshot(): string[] {
		return [...this.order];
	}

	replace(keys: readonly string[]): void {
		this.keys.clear();
		this.order.length = 0;
		for (const key of keys) {
			if (typeof key === "string" && key.length > 0) this.seenOrRemember(key);
		}
	}
}

/**
 * Small atomic JSON-backed idempotency store. It intentionally stores only
 * bounded event keys; message payload persistence belongs to the host session
 * store and can be added through the same interface.
 */
export class FileInboundDedupStore implements InboundDedupStore {
	private readonly filePath: string;
	private readonly maxSize: number;
	private readonly memory: InMemoryInboundDedupStore;

	constructor(filePath: string, maxSize = 4096) {
		this.filePath = filePath;
		this.maxSize = positiveLimit(maxSize);
		this.memory = new InMemoryInboundDedupStore(this.maxSize);
		this.load();
	}

	seenOrRemember(key: string): boolean {
		return withFileStateLock(this.filePath, () => {
			const current = this.readKeys();
			const store = new InMemoryInboundDedupStore(this.maxSize);
			store.replace(current);
			const duplicate = store.seenOrRemember(key);
			if (!duplicate) atomicWriteJson(this.filePath, store.snapshot(), "dedup state");
			this.memory.replace(store.snapshot());
			return duplicate;
		});
	}

	has(key: string): boolean {
		return this.memory.has(key);
	}

	private load(): void {
		this.memory.replace(this.readKeys());
	}

	private readKeys(): string[] {
		const raw = readRegularFile(this.filePath, "dedup state");
		if (raw === undefined) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) throw new Error(`dedup state file must contain an array: ${this.filePath}`);
		return parsed.filter((key): key is string => typeof key === "string" && key.length > 0);
	}
}

export interface InboundHandoffStore extends InboundDedupStore {
	/** Atomically deduplicate and persist an inbound message before acceptance. */
	accept(message: InboundMessage): boolean;
	/** Recover messages that were pending or in-flight before a process stopped. */
	recoverPending(now?: number): InboundMessage[];
	/** Return the persisted attempt number for this delivery. */
	markDelivering(message: InboundMessage): number;
	/** Put a failed message back into the pending state for a later attempt. */
	markRetry(message: InboundMessage, error: string, nextAttemptAt: number): void;
	/** Remove a message after it has been copied to the dead-letter store. */
	markDeadLetter(message: InboundMessage): void;
	/** Requeue a message removed to the dead-letter store. */
	requeue(message: InboundMessage): void;
	/** Return the next delayed attempt, if one exists. */
	nextPendingAt?(): number | undefined;
	/** Inspect current persisted handoff records for management/health views. */
	list?(): InboundHandoffRecord[];
	/** Remove a message after the application has successfully accepted it. */
	markDelivered(message: InboundMessage): void;
}

interface InboundHandoffRecord {
	message: InboundMessage;
	status: "pending" | "delivering";
	attempts: number;
	createdAt: number;
	updatedAt: number;
	nextAttemptAt?: number;
	lastError?: string;
}

/** File-backed inbound handoff queue with crash recovery and deduplication. */
export class FileInboundHandoffStore implements InboundHandoffStore {
	private readonly filePath: string;
	private readonly maxRecords: number;
	private readonly maxDedupKeys: number;
	private readonly memory: InMemoryInboundDedupStore;

	constructor(filePath: string, options: { maxRecords?: number; maxDedupKeys?: number } = {}) {
		this.filePath = filePath;
		this.maxRecords = positiveLimit(options.maxRecords ?? 4096);
		this.maxDedupKeys = positiveLimit(options.maxDedupKeys ?? 4096);
		this.memory = new InMemoryInboundDedupStore(this.maxDedupKeys);
		this.applyState(this.readState());
	}

	has(key: string): boolean {
		return this.memory.has(key);
	}

	seenOrRemember(key: string): boolean {
		return withFileStateLock(this.filePath, () => {
			const state = this.readState();
			if (state.dedupKeys.includes(key)) {
				this.applyState(state);
				return true;
			}
			state.dedupKeys.push(key);
			trimDedupKeys(state, this.maxDedupKeys);
			this.writeState(state);
			this.applyState(state);
			return false;
		});
	}

	accept(message: InboundMessage): boolean {
		return withFileStateLock(this.filePath, () => {
			const state = this.readState();
			const key = inboundMessageKey(message);
			if (state.dedupKeys.includes(key) || state.records[key]) {
				this.applyState(state);
				return false;
			}
			if (Object.keys(state.records).length >= this.maxRecords) {
				throw new Error(`inbound handoff queue is full (limit=${this.maxRecords})`);
			}
			const now = Date.now();
			state.dedupKeys.push(key);
			state.records[key] = {
				message: { ...message },
				status: "pending",
				attempts: 0,
				createdAt: now,
				updatedAt: now,
			};
			trimDedupKeys(state, this.maxDedupKeys);
			this.writeState(state);
			this.applyState(state);
			return true;
		});
	}

	recoverPending(now = Date.now()): InboundMessage[] {
		return withFileStateLock(this.filePath, () => {
			const state = this.readState();
			let changed = false;
			const messages: InboundMessage[] = [];
			for (const record of Object.values(state.records)) {
				if (record.status === "delivering") {
					record.status = "pending";
					record.updatedAt = Date.now();
					record.nextAttemptAt = undefined;
					changed = true;
				}
				if (record.status === "pending" && (!record.nextAttemptAt || record.nextAttemptAt <= now)) {
					messages.push({ ...record.message });
				}
			}
			if (changed) this.writeState(state);
			this.applyState(state);
			return messages;
		});
	}

	markDelivering(message: InboundMessage): number {
		return (
			this.update(message, (record) => {
				if (record.status !== "pending") return record.attempts;
				record.status = "delivering";
				record.attempts++;
				record.updatedAt = Date.now();
				record.nextAttemptAt = undefined;
				return record.attempts;
			}) ?? 0
		);
	}

	markRetry(message: InboundMessage, error: string, nextAttemptAt: number): void {
		this.update(message, (record) => {
			record.status = "pending";
			record.updatedAt = Date.now();
			record.nextAttemptAt = nextAttemptAt;
			record.lastError = error;
		});
	}

	markDeadLetter(message: InboundMessage): void {
		withFileStateLock(this.filePath, () => {
			const state = this.readState();
			const key = inboundMessageKey(message);
			if (!state.records[key]) return;
			delete state.records[key];
			this.writeState(state);
			this.applyState(state);
		});
	}

	requeue(message: InboundMessage): void {
		withFileStateLock(this.filePath, () => {
			const state = this.readState();
			const key = inboundMessageKey(message);
			const existing = state.records[key];
			if (existing) {
				existing.status = "pending";
				existing.attempts = 0;
				existing.updatedAt = Date.now();
				existing.nextAttemptAt = undefined;
				existing.lastError = undefined;
			} else {
				if (Object.keys(state.records).length >= this.maxRecords) {
					throw new Error(`inbound handoff queue is full (limit=${this.maxRecords})`);
				}
				const now = Date.now();
				state.dedupKeys.push(key);
				state.records[key] = {
					message: { ...message },
					status: "pending",
					attempts: 0,
					createdAt: now,
					updatedAt: now,
				};
			}
			trimDedupKeys(state, this.maxDedupKeys);
			this.writeState(state);
			this.applyState(state);
		});
	}

	nextPendingAt(): number | undefined {
		return withFileStateLock(this.filePath, () => {
			const values = Object.values(this.readState().records)
				.filter((record) => record.status === "pending" && record.nextAttemptAt !== undefined)
				.map((record) => record.nextAttemptAt!);
			return values.length > 0 ? Math.min(...values) : undefined;
		});
	}

	list(): InboundHandoffRecord[] {
		return withFileStateLock(this.filePath, () =>
			Object.values(this.readState().records).map((record) => ({
				...record,
				message: { ...record.message },
			})),
		);
	}

	markDelivered(message: InboundMessage): void {
		withFileStateLock(this.filePath, () => {
			const state = this.readState();
			const key = inboundMessageKey(message);
			if (!state.records[key]) return;
			delete state.records[key];
			this.writeState(state);
			this.applyState(state);
		});
	}

	private update<T>(message: InboundMessage, operation: (record: InboundHandoffRecord) => T): T | undefined {
		return withFileStateLock(this.filePath, () => {
			const state = this.readState();
			const record = state.records[inboundMessageKey(message)];
			if (!record) return undefined;
			const result = operation(record);
			this.writeState(state);
			this.applyState(state);
			return result;
		});
	}

	private readState(): { dedupKeys: string[]; records: Record<string, InboundHandoffRecord> } {
		const raw = readRegularFile(this.filePath, "inbound handoff state");
		if (raw === undefined) return { dedupKeys: [], records: {} };
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) throw new Error(`inbound handoff state file is invalid: ${this.filePath}`);
		const dedupKeys = Array.isArray(parsed.dedupKeys)
			? parsed.dedupKeys.filter((key): key is string => typeof key === "string" && key.length > 0)
			: [];
		const records: Record<string, InboundHandoffRecord> = {};
		if (isRecord(parsed.records)) {
			for (const [key, value] of Object.entries(parsed.records)) {
				const record = parseHandoffRecord(value);
				if (record && inboundMessageKey(record.message) === key) records[key] = record;
			}
		}
		return { dedupKeys, records };
	}

	private writeState(state: { dedupKeys: string[]; records: Record<string, InboundHandoffRecord> }): void {
		atomicWriteJson(this.filePath, state, "inbound handoff state");
	}

	private applyState(state: { dedupKeys: string[]; records: Record<string, InboundHandoffRecord> }): void {
		this.memory.replace(state.dedupKeys);
	}
}

export function inboundMessageKey(message: Pick<InboundMessage, "channel" | "chatId" | "messageId">): string {
	return `${message.channel}:${message.chatId}:${message.messageId}`;
}

function parseHandoffRecord(value: unknown): InboundHandoffRecord | undefined {
	if (!isRecord(value) || (value.status !== "pending" && value.status !== "delivering")) return undefined;
	if (typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") return undefined;
	if (!isInboundMessage(value.message)) return undefined;
	return {
		message: value.message,
		status: value.status,
		attempts: typeof value.attempts === "number" && value.attempts >= 0 ? Math.floor(value.attempts) : 0,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		nextAttemptAt: typeof value.nextAttemptAt === "number" ? value.nextAttemptAt : undefined,
		lastError: typeof value.lastError === "string" ? value.lastError : undefined,
	};
}

function isInboundMessage(value: unknown): value is InboundMessage {
	if (!isRecord(value)) return false;
	return (
		typeof value.messageId === "string" &&
		typeof value.channel === "string" &&
		typeof value.senderId === "string" &&
		typeof value.chatId === "string" &&
		typeof value.content === "string" &&
		typeof value.timestamp === "number" &&
		typeof value.sessionKey === "string"
	);
}

function trimDedupKeys(
	state: { dedupKeys: string[]; records: Record<string, InboundHandoffRecord> },
	maxKeys: number,
): void {
	while (state.dedupKeys.length > maxKeys) {
		const index = state.dedupKeys.findIndex((key) => !state.records[key]);
		if (index === -1) return;
		state.dedupKeys.splice(index, 1);
	}
}

/** Persistent cursor store for polling or sync-based providers. */
export interface ChannelOffsetStore {
	get(channel: string, key: string): string | undefined;
	set(channel: string, key: string, value: string): void;
	delete?(channel: string, key: string): void;
}

export class FileChannelOffsetStore implements ChannelOffsetStore {
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
		this.readOffsets();
	}

	get(channel: string, key: string): string | undefined {
		return this.readOffsets()[channel]?.[key];
	}

	set(channel: string, key: string, value: string): void {
		withFileStateLock(this.filePath, () => {
			const offsets = this.readOffsets();
			const channelOffsets = offsets[channel] ?? {};
			channelOffsets[key] = value;
			offsets[channel] = channelOffsets;
			atomicWriteJson(this.filePath, { offsets }, "channel offset state");
		});
	}

	delete(channel: string, key: string): void {
		withFileStateLock(this.filePath, () => {
			const offsets = this.readOffsets();
			const channelOffsets = offsets[channel];
			if (!channelOffsets || channelOffsets[key] === undefined) return;
			delete channelOffsets[key];
			if (Object.keys(channelOffsets).length === 0) delete offsets[channel];
			atomicWriteJson(this.filePath, { offsets }, "channel offset state");
		});
	}

	private readOffsets(): Record<string, Record<string, string>> {
		const raw = readRegularFile(this.filePath, "channel offset state");
		if (raw === undefined) return {};
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed) || (parsed.offsets !== undefined && !isRecord(parsed.offsets))) {
			throw new Error(`channel offset state file is invalid: ${this.filePath}`);
		}
		const offsets: Record<string, Record<string, string>> = {};
		for (const [channel, value] of Object.entries(parsed.offsets ?? {})) {
			if (!isRecord(value)) continue;
			const channelOffsets: Record<string, string> = {};
			for (const [key, offset] of Object.entries(value)) {
				if (typeof offset === "string") channelOffsets[key] = offset;
			}
			offsets[channel] = channelOffsets;
		}
		return offsets;
	}
}

function positiveLimit(value: number): number {
	return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
