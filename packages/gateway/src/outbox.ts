import { atomicWriteJson, readRegularFile, withFileStateLock } from "./file-state.ts";
import { createMessageId, type DeliveryReceipt, type OutboundMessage } from "./types.ts";

export type OutboxStatus = "pending" | "delivering" | "delivered" | "failed" | "cancelled";

export interface OutboxRecord {
	message: OutboundMessage;
	status: OutboxStatus;
	attempts: number;
	acceptedAt: number;
	updatedAt: number;
	nextAttemptAt?: number;
	lastError?: string;
	receipt?: DeliveryReceipt;
}

export interface OutboxCleanupOptions {
	/** Remove terminal records older than this duration. */
	olderThanMs?: number;
	/** Override the clock in deterministic tests. */
	now?: number;
	/** Terminal states eligible for removal. Defaults to all terminal states. */
	statuses?: readonly OutboxStatus[];
}

/** Durable logical-message boundary used by MessageBus and OutboundDispatcher. */
export interface OutboundOutbox {
	/** Returns false when the message id is already known and must not be queued again. */
	enqueue(message: OutboundMessage): boolean;
	get?(messageId: string): OutboxRecord | undefined;
	list?(status?: OutboxStatus): OutboxRecord[];
	cleanup?(options?: OutboxCleanupOptions): number;
	retry?(messageId: string): OutboundMessage | undefined;
	recoverPending(now?: number): OutboundMessage[];
	markAttempt(messageId: string, attempt: number): void;
	markDelivered(receipt: DeliveryReceipt): void;
	markFailed(receipt: DeliveryReceipt): void;
	markCancelled(receipt: DeliveryReceipt): void;
}

/** File-backed outbox with atomic writes and recovery of interrupted attempts. */
export class FileOutboundOutbox implements OutboundOutbox {
	private readonly filePath: string;
	private readonly maxRecords: number;
	private readonly retentionMs: number | undefined;

	constructor(filePath: string, options: { maxRecords?: number; retentionMs?: number } = {}) {
		this.filePath = filePath;
		this.maxRecords = positiveLimit(options.maxRecords, 4096);
		this.retentionMs = positiveDuration(options.retentionMs);
		this.readRecords();
	}

	get(messageId: string): OutboxRecord | undefined {
		return cloneRecord(this.readRecords()[messageId]);
	}

	list(status?: OutboxStatus): OutboxRecord[] {
		return Object.values(this.readRecords())
			.filter((record) => status === undefined || record.status === status)
			.map((record) => cloneRecord(record)!);
	}

	retry(messageId: string): OutboundMessage | undefined {
		return withFileStateLock(this.filePath, () => {
			const records = this.readRecords();
			const record = records[messageId];
			if (!record || (record.status !== "failed" && record.status !== "cancelled")) return undefined;
			record.status = "pending";
			record.attempts = 0;
			record.updatedAt = Date.now();
			record.lastError = undefined;
			record.receipt = undefined;
			record.nextAttemptAt = undefined;
			this.writeRecords(records);
			return { ...record.message };
		});
	}

	enqueue(message: OutboundMessage): boolean {
		if (!message.messageId) message.messageId = createMessageId("out");
		return withFileStateLock(this.filePath, () => {
			const records = this.readRecords();
			if (this.retentionMs !== undefined) removeExpired(records, Date.now() - this.retentionMs, TERMINAL_STATUSES);
			if (records[message.messageId!]) return false;
			pruneRecords(records, this.maxRecords);
			if (Object.keys(records).length >= this.maxRecords) {
				throw new Error(`outbound outbox is full (limit=${this.maxRecords})`);
			}
			const now = Date.now();
			records[message.messageId!] = {
				message: { ...message },
				status: "pending",
				attempts: 0,
				acceptedAt: now,
				updatedAt: now,
			};
			this.writeRecords(records);
			return true;
		});
	}

	cleanup(options: OutboxCleanupOptions = {}): number {
		return withFileStateLock(this.filePath, () => {
			const records = this.readRecords();
			const olderThanMs = positiveDuration(options.olderThanMs);
			if (olderThanMs === undefined && options.statuses === undefined) return 0;
			const statuses = options.statuses ?? TERMINAL_STATUSES;
			const cutoff = (options.now ?? Date.now()) - (olderThanMs ?? 0);
			const removed = removeExpired(records, cutoff, statuses);
			if (removed > 0) this.writeRecords(records);
			return removed;
		});
	}

	recoverPending(now = Date.now()): OutboundMessage[] {
		return withFileStateLock(this.filePath, () => {
			const records = this.readRecords();
			let changed = false;
			const pending: OutboundMessage[] = [];
			for (const record of Object.values(records)) {
				if (record.status === "delivering") {
					record.status = "pending";
					record.updatedAt = now;
					changed = true;
				}
				if (record.status === "pending" && (!record.nextAttemptAt || record.nextAttemptAt <= now)) {
					pending.push({ ...record.message });
				}
			}
			if (changed) this.writeRecords(records);
			return pending;
		});
	}

	markAttempt(messageId: string, attempt: number): void {
		this.update(messageId, (record) => {
			record.status = "delivering";
			record.attempts = Math.max(record.attempts, attempt);
			record.updatedAt = Date.now();
		});
	}

	markDelivered(receipt: DeliveryReceipt): void {
		this.finish(receipt, "delivered");
	}

	markFailed(receipt: DeliveryReceipt): void {
		this.finish(receipt, "failed");
	}

	markCancelled(receipt: DeliveryReceipt): void {
		this.finish(receipt, "cancelled");
	}

	private finish(receipt: DeliveryReceipt, status: OutboxStatus): void {
		this.update(receipt.messageId, (record) => {
			record.status = status;
			record.attempts = Math.max(record.attempts, receipt.attempts);
			record.updatedAt = Date.now();
			record.lastError = receipt.detail;
			record.receipt = receipt;
		});
	}

	private update(messageId: string, operation: (record: OutboxRecord) => void): void {
		withFileStateLock(this.filePath, () => {
			const records = this.readRecords();
			const record = records[messageId];
			if (!record) return;
			operation(record);
			this.writeRecords(records);
		});
	}

	private readRecords(): Record<string, OutboxRecord> {
		const raw = readRegularFile(this.filePath, "outbound outbox");
		if (raw === undefined) return {};
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed) || (parsed.records !== undefined && !isRecord(parsed.records))) {
			throw new Error(`outbound outbox file is invalid: ${this.filePath}`);
		}
		const records: Record<string, OutboxRecord> = {};
		for (const [messageId, value] of Object.entries(parsed.records ?? {})) {
			const record = parseRecord(value);
			if (record && record.message.messageId === messageId) records[messageId] = record;
		}
		return records;
	}

	private writeRecords(records: Record<string, OutboxRecord>): void {
		atomicWriteJson(this.filePath, { records }, "outbound outbox");
	}
}

function parseRecord(value: unknown): OutboxRecord | undefined {
	if (!isRecord(value) || !isRecord(value.message)) return undefined;
	const message = value.message;
	if (
		typeof message.messageId !== "string" ||
		typeof message.channel !== "string" ||
		typeof message.chatId !== "string" ||
		typeof message.content !== "string"
	) {
		return undefined;
	}
	const statuses: OutboxStatus[] = ["pending", "delivering", "delivered", "failed", "cancelled"];
	if (typeof value.status !== "string" || !statuses.includes(value.status as OutboxStatus)) return undefined;
	if (
		typeof value.attempts !== "number" ||
		typeof value.acceptedAt !== "number" ||
		typeof value.updatedAt !== "number"
	) {
		return undefined;
	}
	return value as unknown as OutboxRecord;
}

function cloneRecord(record: OutboxRecord | undefined): OutboxRecord | undefined {
	return record
		? {
				...record,
				message: { ...record.message },
				receipt: record.receipt ? { ...record.receipt } : undefined,
			}
		: undefined;
}

function pruneRecords(records: Record<string, OutboxRecord>, maxRecords: number): void {
	const removable = Object.entries(records)
		.filter(
			([, record]) => record.status === "delivered" || record.status === "failed" || record.status === "cancelled",
		)
		.sort(([, left], [, right]) => left.updatedAt - right.updatedAt);
	while (Object.keys(records).length >= maxRecords && removable.length > 0) {
		const item = removable.shift();
		if (item) delete records[item[0]];
	}
}

const TERMINAL_STATUSES: readonly OutboxStatus[] = ["delivered", "failed", "cancelled"];

function removeExpired(
	records: Record<string, OutboxRecord>,
	cutoff: number,
	statuses: readonly OutboxStatus[],
): number {
	const allowed = new Set(statuses);
	let removed = 0;
	for (const [messageId, record] of Object.entries(records)) {
		if (allowed.has(record.status) && record.updatedAt < cutoff) {
			delete records[messageId];
			removed++;
		}
	}
	return removed;
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function positiveDuration(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
