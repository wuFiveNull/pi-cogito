/**
 * Pairing store for DM sender approval (mirrors nanobot's pairing/store.py).
 *
 * Persistent storage keeps approved senders and pending pairing codes per
 * channel. Designed for private-assistant scale: small JSON file, atomic
 * writes, no external DB.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PairingRecord {
	channel: string;
	senderId: string;
	code: string;
	createdAt: number;
	expiresAt: number;
	approved: boolean;
}

export interface PairingStore {
	isApproved(channel: string, senderId: string): boolean;
	/** Issue (or reuse) a pending code for an unapproved sender. */
	generateCode(channel: string, senderId: string): string;
	approve(channel: string, senderId: string): void;
	deny(channel: string, senderId: string): void;
	list(): PairingRecord[];
}

const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CODE_LENGTH = 8; // e.g. ABCD-EFGH
const TTL_MS = 10 * 60 * 1000; // 10 minutes

export function generatePairingCode(): string {
	const chars = new Array<string>(CODE_LENGTH);
	for (let i = 0; i < CODE_LENGTH; i++) {
		chars[i] = CODE_ALPHABET[randomBytes(1)[0]! % CODE_ALPHABET.length]!;
	}
	return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export function formatPairingReply(code: string, channel: string): string {
	return [
		`[${channel}] 你还没有被授权访问我。`,
		`配对码: ${code}`,
		"请在 10 分钟内通过 WebUI 或管理接口批准该配对码。",
	].join("\n");
}

interface PersistedPairingData {
	approved: Record<string, string[]>;
	pending: Record<string, Record<string, { code: string; createdAt: number; expiresAt: number }>>;
}

export class InMemoryPairingStore implements PairingStore {
	private readonly approved = new Map<string, Set<string>>();
	private readonly pending = new Map<string, Map<string, { code: string; createdAt: number; expiresAt: number }>>();

	isApproved(channel: string, senderId: string): boolean {
		return this.approved.get(channel)?.has(senderId) ?? false;
	}

	generateCode(channel: string, senderId: string): string {
		const pending = this.pending.get(channel) ?? new Map();
		const now = Date.now();
		const existing = pending.get(senderId);
		if (existing && existing.expiresAt > now) return existing.code;
		const code = generatePairingCode();
		pending.set(senderId, { code, createdAt: now, expiresAt: now + TTL_MS });
		this.pending.set(channel, pending);
		return code;
	}

	approve(channel: string, senderId: string): void {
		const approved = this.approved.get(channel) ?? new Set<string>();
		approved.add(senderId);
		this.approved.set(channel, approved);
		this.pending.get(channel)?.delete(senderId);
	}

	deny(channel: string, senderId: string): void {
		this.approved.get(channel)?.delete(senderId);
		this.pending.get(channel)?.delete(senderId);
	}

	list(): PairingRecord[] {
		const records: PairingRecord[] = [];
		for (const [channel, senders] of this.approved) {
			for (const senderId of senders) {
				records.push({
					channel,
					senderId,
					code: "",
					createdAt: 0,
					expiresAt: 0,
					approved: true,
				});
			}
		}
		for (const [channel, pending] of this.pending) {
			for (const [senderId, entry] of pending) {
				records.push({
					channel,
					senderId,
					code: entry.code,
					createdAt: entry.createdAt,
					expiresAt: entry.expiresAt,
					approved: false,
				});
			}
		}
		return records;
	}
}

export class FilePairingStore implements PairingStore {
	private readonly path: string;
	private data: PersistedPairingData;

	constructor(path?: string) {
		this.path = path ?? join(homedir(), ".cogito", "pairing.json");
		this.data = readPersisted(this.path);
	}

	isApproved(channel: string, senderId: string): boolean {
		return (this.data.approved[channel] ?? []).includes(senderId);
	}

	generateCode(channel: string, senderId: string): string {
		const now = Date.now();
		const pending = this.data.pending[channel] ?? {};
		const existing = pending[senderId];
		if (existing && existing.expiresAt > now) return existing.code;
		const code = generatePairingCode();
		pending[senderId] = { code, createdAt: now, expiresAt: now + TTL_MS };
		this.data.pending[channel] = pending;
		this.persist();
		return code;
	}

	approve(channel: string, senderId: string): void {
		const approved = this.data.approved[channel] ?? [];
		if (!approved.includes(senderId)) {
			approved.push(senderId);
			this.data.approved[channel] = approved;
		}
		delete this.data.pending[channel]?.[senderId];
		this.persist();
	}

	deny(channel: string, senderId: string): void {
		const approved = this.data.approved[channel] ?? [];
		this.data.approved[channel] = approved.filter((id) => id !== senderId);
		delete this.data.pending[channel]?.[senderId];
		this.persist();
	}

	list(): PairingRecord[] {
		const records: PairingRecord[] = [];
		for (const [channel, senders] of Object.entries(this.data.approved)) {
			for (const senderId of senders) {
				records.push({ channel, senderId, code: "", createdAt: 0, expiresAt: 0, approved: true });
			}
		}
		for (const [channel, pending] of Object.entries(this.data.pending)) {
			for (const [senderId, entry] of Object.entries(pending)) {
				records.push({
					channel,
					senderId,
					code: entry.code,
					createdAt: entry.createdAt,
					expiresAt: entry.expiresAt,
					approved: false,
				});
			}
		}
		return records;
	}

	private persist(): void {
		mkdirSync(dirnameOf(this.path), { recursive: true });
		const payload: PersistedPairingData = {
			approved: mapValues(this.data.approved, (users) => [...users]),
			pending: this.data.pending,
		};
		writeFileSync(this.path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	}
}

function readPersisted(path: string): PersistedPairingData {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedPairingData>;
		return {
			approved: normalizeApproved(raw.approved),
			pending: typeof raw.pending === "object" && raw.pending !== null ? raw.pending : {},
		};
	} catch {
		return { approved: {}, pending: {} };
	}
}

function normalizeApproved(raw: Partial<PersistedPairingData>["approved"]): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	if (typeof raw !== "object" || raw === null) return result;
	for (const [channel, users] of Object.entries(raw)) {
		result[channel] = Array.isArray(users) ? users.map(String) : [];
	}
	return result;
}

function mapValues<T>(record: Record<string, T[]>, transform: (values: T[]) => T[]): Record<string, T[]> {
	const result: Record<string, T[]> = {};
	for (const [key, value] of Object.entries(record)) {
		result[key] = transform(value);
	}
	return result;
}

function dirnameOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "." : path.slice(0, index);
}
