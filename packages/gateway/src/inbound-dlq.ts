import { atomicWriteJson, readRegularFile, withFileStateLock } from "./file-state.ts";
import { inboundMessageKey } from "./state.ts";
import type { InboundMessage } from "./types.ts";

/** A durable record for an inbound message that exhausted automatic retries. */
export interface InboundDeadLetterRecord {
	message: InboundMessage;
	attempts: number;
	firstFailedAt: number;
	failedAt: number;
	lastError: string;
}

/** Store used by the bus to retain inbound messages that need operator action. */
export interface InboundDeadLetterStore {
	get(key: string): InboundDeadLetterRecord | undefined;
	list(): InboundDeadLetterRecord[];
	enqueue(record: InboundDeadLetterRecord): void;
	remove(key: string): void;
}

/** Process-local fallback used when a host does not configure a state path. */
export class InMemoryInboundDeadLetterStore implements InboundDeadLetterStore {
	private readonly records = new Map<string, InboundDeadLetterRecord>();
	private readonly maxRecords: number;

	constructor(maxRecords = 4096) {
		this.maxRecords = positiveLimit(maxRecords, 4096);
	}

	get(key: string): InboundDeadLetterRecord | undefined {
		return cloneRecord(this.records.get(key));
	}

	list(): InboundDeadLetterRecord[] {
		return [...this.records.values()]
			.sort((left, right) => right.failedAt - left.failedAt)
			.map((record) => cloneRecord(record)!);
	}

	enqueue(record: InboundDeadLetterRecord): void {
		this.records.set(inboundMessageKey(record.message), cloneRecord(record)!);
		while (this.records.size > this.maxRecords) {
			const oldest = [...this.records.entries()].sort(([, left], [, right]) => left.failedAt - right.failedAt)[0];
			if (!oldest) return;
			this.records.delete(oldest[0]);
		}
	}

	remove(key: string): void {
		this.records.delete(key);
	}
}

/** File-backed inbound dead-letter queue with atomic, lock-protected writes. */
export class FileInboundDeadLetterStore implements InboundDeadLetterStore {
	private readonly filePath: string;
	private readonly maxRecords: number;

	constructor(filePath: string, options: { maxRecords?: number } = {}) {
		this.filePath = filePath;
		this.maxRecords = positiveLimit(options.maxRecords, 4096);
		this.readRecords();
	}

	get(key: string): InboundDeadLetterRecord | undefined {
		return cloneRecord(this.readRecords()[key]);
	}

	list(): InboundDeadLetterRecord[] {
		return Object.values(this.readRecords())
			.sort((left, right) => right.failedAt - left.failedAt)
			.map((record) => cloneRecord(record)!);
	}

	enqueue(record: InboundDeadLetterRecord): void {
		const key = inboundMessageKey(record.message);
		withFileStateLock(this.filePath, () => {
			const records = this.readRecords();
			records[key] = cloneRecord(record)!;
			pruneRecords(records, this.maxRecords);
			this.writeRecords(records);
		});
	}

	remove(key: string): void {
		withFileStateLock(this.filePath, () => {
			const records = this.readRecords();
			if (!records[key]) return;
			delete records[key];
			this.writeRecords(records);
		});
	}

	private readRecords(): Record<string, InboundDeadLetterRecord> {
		const raw = readRegularFile(this.filePath, "inbound dead-letter state");
		if (raw === undefined) return {};
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed) || (parsed.records !== undefined && !isRecord(parsed.records))) {
			throw new Error(`inbound dead-letter state file is invalid: ${this.filePath}`);
		}
		const records: Record<string, InboundDeadLetterRecord> = {};
		for (const [key, value] of Object.entries(parsed.records ?? {})) {
			const record = parseRecord(value);
			if (record && inboundMessageKey(record.message) === key) records[key] = record;
		}
		return records;
	}

	private writeRecords(records: Record<string, InboundDeadLetterRecord>): void {
		atomicWriteJson(this.filePath, { records }, "inbound dead-letter state");
	}
}

function parseRecord(value: unknown): InboundDeadLetterRecord | undefined {
	if (!isRecord(value) || !isInboundMessage(value.message)) return undefined;
	if (
		typeof value.attempts !== "number" ||
		typeof value.firstFailedAt !== "number" ||
		typeof value.failedAt !== "number" ||
		typeof value.lastError !== "string"
	) {
		return undefined;
	}
	return value as unknown as InboundDeadLetterRecord;
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

function cloneRecord(record: InboundDeadLetterRecord | undefined): InboundDeadLetterRecord | undefined {
	return record ? { ...record, message: { ...record.message } } : undefined;
}

function pruneRecords(records: Record<string, InboundDeadLetterRecord>, maxRecords: number): void {
	const entries = Object.entries(records).sort(([, left], [, right]) => left.failedAt - right.failedAt);
	while (entries.length > maxRecords) {
		const oldest = entries.shift();
		if (oldest) delete records[oldest[0]];
	}
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
