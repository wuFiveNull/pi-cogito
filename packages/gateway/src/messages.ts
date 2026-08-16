import { atomicWriteJson, readRegularFile, withFileStateLock } from "./file-state.ts";
import type { DeliveryReceipt, DeliveryStatus, InboundMessage, OutboundMessage } from "./types.ts";

export type ChannelMessageDirection = "inbound" | "outbound";

export type InboundMessageRecordStatus = "received" | "processing" | "retrying" | "completed" | "dead-letter";

export type OutboundMessageRecordStatus = "accepted" | "delivering" | DeliveryStatus;

export type ChannelMessageStatus = InboundMessageRecordStatus | OutboundMessageRecordStatus;

export interface InboundMessageRecord {
	recordId: string;
	direction: "inbound";
	message: InboundMessage;
	status: InboundMessageRecordStatus;
	attempts: number;
	createdAt: number;
	updatedAt: number;
	lastError?: string;
}

export interface OutboundMessageRecord {
	recordId: string;
	direction: "outbound";
	message: OutboundMessage;
	status: OutboundMessageRecordStatus;
	attempts: number;
	createdAt: number;
	updatedAt: number;
	lastError?: string;
	receipt?: DeliveryReceipt;
}

export type ChannelMessageRecord = InboundMessageRecord | OutboundMessageRecord;

export interface ChannelMessageQuery {
	direction?: ChannelMessageDirection;
	channel?: string;
	chatId?: string;
	sessionKey?: string;
	status?: ChannelMessageStatus;
	after?: number;
	before?: number;
	/** Return the newest matching records, in chronological order. Defaults to 100. */
	limit?: number;
}

export interface ChannelMessageStore {
	recordInbound(message: InboundMessage): void;
	markInboundProcessing(message: InboundMessage, attempt: number): void;
	markInboundRetry(message: InboundMessage, attempt: number, error: string): void;
	markInboundRequeued(message: InboundMessage): void;
	markInboundCompleted(message: InboundMessage): void;
	markInboundDeadLetter(message: InboundMessage, attempt: number, error: string): void;
	recordOutbound(message: OutboundMessage): void;
	markOutboundAttempt(message: OutboundMessage, attempt: number): void;
	recordDelivery(receipt: DeliveryReceipt): void;
	get(recordId: string): ChannelMessageRecord | undefined;
	list(query?: ChannelMessageQuery): ChannelMessageRecord[];
}

export interface FileChannelMessageStoreOptions {
	/** Optional retention cap. Without it, records are retained until manually removed. */
	maxRecords?: number;
}

interface PersistedMessages {
	version: 1;
	order: string[];
	records: Record<string, ChannelMessageRecord>;
}

const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 1000;

/**
 * File-backed canonical message history.
 *
 * Unlike the inbound handoff and outbound outbox, records remain after a
 * successful delivery. The store uses the same lock-protected atomic JSON
 * state as the other gateway persistence primitives and is intentionally
 * dependency-free.
 */
export class FileChannelMessageStore implements ChannelMessageStore {
	private readonly filePath: string;
	private readonly maxRecords: number | undefined;

	constructor(filePath: string, options: FileChannelMessageStoreOptions = {}) {
		this.filePath = filePath;
		this.maxRecords = optionalPositiveLimit(options.maxRecords);
		this.readState();
	}

	recordInbound(message: InboundMessage): void {
		this.transact((state) => {
			const recordId = messageRecordId("inbound", message.messageId);
			if (state.records[recordId]) return;
			const now = Date.now();
			state.records[recordId] = {
				recordId,
				direction: "inbound",
				message: structuredClone(message),
				status: "received",
				attempts: 0,
				createdAt: now,
				updatedAt: now,
			};
			state.order.push(recordId);
			this.prune(state);
		});
	}

	markInboundProcessing(message: InboundMessage, attempt: number): void {
		this.updateInbound(message, (record) => {
			record.status = "processing";
			record.attempts = Math.max(record.attempts, positiveAttempt(attempt));
			record.updatedAt = Date.now();
			record.lastError = undefined;
		});
	}

	markInboundRetry(message: InboundMessage, attempt: number, error: string): void {
		this.updateInbound(message, (record) => {
			record.status = "retrying";
			record.attempts = Math.max(record.attempts, positiveAttempt(attempt));
			record.updatedAt = Date.now();
			record.lastError = error;
		});
	}

	markInboundRequeued(message: InboundMessage): void {
		this.updateInbound(message, (record) => {
			record.status = "received";
			record.updatedAt = Date.now();
			record.lastError = undefined;
		});
	}

	markInboundCompleted(message: InboundMessage): void {
		this.updateInbound(message, (record) => {
			record.status = "completed";
			record.updatedAt = Date.now();
			record.lastError = undefined;
		});
	}

	markInboundDeadLetter(message: InboundMessage, attempt: number, error: string): void {
		this.updateInbound(message, (record) => {
			record.status = "dead-letter";
			record.attempts = Math.max(record.attempts, positiveAttempt(attempt));
			record.updatedAt = Date.now();
			record.lastError = error;
		});
	}

	recordOutbound(message: OutboundMessage): void {
		if (!message.messageId) throw new Error("canonical outbound message requires messageId");
		this.transact((state) => {
			const recordId = messageRecordId("outbound", message.messageId!);
			const existing = state.records[recordId];
			if (existing) return;
			const now = Date.now();
			state.records[recordId] = {
				recordId,
				direction: "outbound",
				message: structuredClone(message),
				status: "accepted",
				attempts: 0,
				createdAt: now,
				updatedAt: now,
			};
			state.order.push(recordId);
			this.prune(state);
		});
	}

	markOutboundAttempt(message: OutboundMessage, attempt: number): void {
		if (!message.messageId) return;
		this.transact((state) => {
			const record = state.records[messageRecordId("outbound", message.messageId!)];
			if (!record || record.direction !== "outbound") return;
			record.status = "delivering";
			record.attempts = Math.max(record.attempts, positiveAttempt(attempt));
			record.updatedAt = Date.now();
		});
	}

	recordDelivery(receipt: DeliveryReceipt): void {
		this.transact((state) => {
			const record = state.records[messageRecordId("outbound", receipt.messageId)];
			if (!record || record.direction !== "outbound") return;
			record.status = receipt.status;
			record.attempts = Math.max(record.attempts, positiveAttempt(receipt.attempts));
			record.updatedAt = Date.now();
			record.lastError = receipt.detail;
			record.receipt = structuredClone(receipt);
		});
	}

	get(recordId: string): ChannelMessageRecord | undefined {
		const record = this.readState().records[recordId];
		return record ? structuredClone(record) : undefined;
	}

	list(query: ChannelMessageQuery = {}): ChannelMessageRecord[] {
		const state = this.readState();
		const records = state.order
			.map((recordId) => state.records[recordId])
			.filter((record): record is ChannelMessageRecord => record !== undefined)
			.filter((record) => matchesQuery(record, query));
		const limit = queryLimit(query.limit);
		return records.slice(-limit).map((record) => structuredClone(record));
	}

	private updateInbound(message: InboundMessage, operation: (record: InboundMessageRecord) => void): void {
		this.transact((state) => {
			const record = state.records[messageRecordId("inbound", message.messageId)];
			if (!record || record.direction !== "inbound") return;
			operation(record);
		});
	}

	private transact(operation: (state: PersistedMessages) => void): void {
		withFileStateLock(this.filePath, () => {
			const state = this.readState();
			operation(state);
			this.writeState(state);
		});
	}

	private prune(state: PersistedMessages): void {
		if (this.maxRecords === undefined) return;
		while (state.order.length > this.maxRecords) {
			const oldest = state.order.shift();
			if (oldest !== undefined) delete state.records[oldest];
		}
	}

	private readState(): PersistedMessages {
		const raw = readRegularFile(this.filePath, "message history");
		if (raw === undefined) return { version: 1, order: [], records: {} };
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) throw new Error(`message history file is invalid: ${this.filePath}`);
		const records: Record<string, ChannelMessageRecord> = {};
		if (isRecord(parsed.records)) {
			for (const [recordId, value] of Object.entries(parsed.records)) {
				const record = parseRecord(value);
				if (record && record.recordId === recordId) records[recordId] = record;
			}
		}
		const order = Array.isArray(parsed.order)
			? parsed.order.filter(
					(recordId): recordId is string => typeof recordId === "string" && records[recordId] !== undefined,
				)
			: [];
		for (const recordId of Object.keys(records)) {
			if (!order.includes(recordId)) order.push(recordId);
		}
		return { version: 1, order, records };
	}

	private writeState(state: PersistedMessages): void {
		atomicWriteJson(this.filePath, state, "message history");
	}
}

export function messageRecordId(direction: ChannelMessageDirection, messageId: string): string {
	return `${direction}:${messageId}`;
}

function matchesQuery(record: ChannelMessageRecord, query: ChannelMessageQuery): boolean {
	if (query.direction !== undefined && record.direction !== query.direction) return false;
	if (query.channel !== undefined && record.message.channel !== query.channel) return false;
	if (query.chatId !== undefined && record.message.chatId !== query.chatId) return false;
	if (
		query.sessionKey !== undefined &&
		(record.direction !== "inbound" || record.message.sessionKey !== query.sessionKey)
	) {
		return false;
	}
	if (query.status !== undefined && record.status !== query.status) return false;
	if (query.after !== undefined && record.createdAt <= query.after) return false;
	if (query.before !== undefined && record.createdAt >= query.before) return false;
	return true;
}

function parseRecord(value: unknown): ChannelMessageRecord | undefined {
	if (!isRecord(value) || typeof value.recordId !== "string" || typeof value.direction !== "string") return undefined;
	if (!isRecord(value.message)) return undefined;
	if (
		typeof value.message.messageId !== "string" ||
		typeof value.message.channel !== "string" ||
		typeof value.message.chatId !== "string" ||
		typeof value.message.content !== "string" ||
		typeof value.status !== "string" ||
		typeof value.attempts !== "number" ||
		typeof value.createdAt !== "number" ||
		typeof value.updatedAt !== "number"
	) {
		return undefined;
	}
	if (value.direction === "inbound" && isInboundStatus(value.status) && isInboundMessage(value.message)) {
		return value as unknown as InboundMessageRecord;
	}
	if (value.direction === "outbound" && isOutboundStatus(value.status)) {
		return value as unknown as OutboundMessageRecord;
	}
	return undefined;
}

function isInboundMessage(value: Record<string, unknown>): boolean {
	return (
		typeof value.senderId === "string" && typeof value.timestamp === "number" && typeof value.sessionKey === "string"
	);
}

function isInboundStatus(value: string): value is InboundMessageRecordStatus {
	return ["received", "processing", "retrying", "completed", "dead-letter"].includes(value);
}

function isOutboundStatus(value: string): value is OutboundMessageRecordStatus {
	return ["accepted", "delivering", "success", "partial", "failed", "cancelled"].includes(value);
}

function queryLimit(value: number | undefined): number {
	if (value === undefined) return DEFAULT_QUERY_LIMIT;
	if (!Number.isFinite(value) || value < 1) throw new Error("message query limit must be a positive number");
	return Math.min(Math.floor(value), MAX_QUERY_LIMIT);
}

function positiveAttempt(value: number): number {
	return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

function optionalPositiveLimit(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 1) throw new Error("message store maxRecords must be a positive number");
	return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
