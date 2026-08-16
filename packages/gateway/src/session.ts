import type { ChannelSessionManager } from "./channels/context.ts";
import { atomicWriteJson, readRegularFile, withFileStateLock } from "./file-state.ts";
import type { InboundDedupStore } from "./state.ts";
import type { InboundMessage } from "./types.ts";

export interface ChannelSessionRecord {
	sessionKey: string;
	channel: string;
	chatId: string;
	createdAt: number;
	updatedAt: number;
	lastInboundMessageId?: string;
	lastClientMessageId?: string;
	activeTurnId?: string;
	activeTurnStartedAt?: number;
	lastTurnStatus?: "completed" | "failed" | "interrupted";
	/** Persisted coding-agent transcript associated with this channel conversation. */
	agentSessionFile?: string;
	agentSessionId?: string;
}

interface PersistedSessions {
	sessions: Record<string, ChannelSessionRecord>;
	dedupKeys: string[];
}

/** File-backed session metadata, turn admission, and inbound idempotency. */
export class FileChannelSessionStore implements ChannelSessionManager, InboundDedupStore {
	private readonly filePath: string;
	private readonly maxDedupKeys: number;
	private readonly sessions = new Map<string, ChannelSessionRecord>();
	private readonly dedupKeys = new Set<string>();
	private readonly dedupOrder: string[] = [];

	constructor(filePath: string, options: { maxDedupKeys?: number } = {}) {
		this.filePath = filePath;
		this.maxDedupKeys = positiveLimit(options.maxDedupKeys, 4096);
		this.load();
	}

	has(key: string): boolean {
		return this.dedupKeys.has(key);
	}

	seenOrRemember(key: string): boolean {
		return withFileStateLock(this.filePath, () => {
			const state = this.readState();
			if (state.dedupKeys.includes(key)) {
				this.applyState(state);
				return true;
			}
			state.dedupKeys.push(key);
			if (state.dedupKeys.length > this.maxDedupKeys) {
				state.dedupKeys.splice(0, state.dedupKeys.length - this.maxDedupKeys);
			}
			this.writeState(state);
			this.applyState(state);
			return false;
		});
	}

	getSession(sessionKey: string): ChannelSessionRecord | undefined {
		this.load();
		const session = this.sessions.get(sessionKey);
		return session ? { ...session } : undefined;
	}

	/** Associate a channel conversation with a durable coding-agent session file. */
	setAgentSession(sessionKey: string, session: { file: string; id: string }): void {
		this.transact((state) => {
			const existing = state.sessions[sessionKey];
			const now = Date.now();
			state.sessions[sessionKey] = {
				...(existing ?? sessionRecordFromKey(sessionKey, now)),
				agentSessionFile: session.file,
				agentSessionId: session.id,
				updatedAt: now,
			};
		});
	}

	recordInbound(message: InboundMessage): void {
		this.transact((state) => {
			const existing = state.sessions[message.sessionKey];
			const now = Date.now();
			const session: ChannelSessionRecord = existing
				? { ...existing, updatedAt: now }
				: {
						sessionKey: message.sessionKey,
						channel: message.channel,
						chatId: message.chatId,
						createdAt: now,
						updatedAt: now,
					};
			session.lastInboundMessageId = message.messageId;
			session.lastClientMessageId = message.clientMessageId;
			state.sessions[message.sessionKey] = session;
		});
	}

	beginTurn(sessionKey: string, turnId: string): boolean {
		return withFileStateLock(this.filePath, () => {
			const state = this.readState();
			const session = state.sessions[sessionKey];
			if (session?.activeTurnId && session.activeTurnId !== turnId) return false;
			const now = Date.now();
			const next: ChannelSessionRecord = session
				? { ...session, activeTurnId: turnId, activeTurnStartedAt: now, updatedAt: now }
				: { ...sessionRecordFromKey(sessionKey, now), activeTurnId: turnId, activeTurnStartedAt: now };
			state.sessions[sessionKey] = next;
			this.writeState(state);
			this.applyState(state);
			return true;
		});
	}

	completeTurn(sessionKey: string, turnId: string, status: "completed" | "failed" | "interrupted"): void {
		this.transact((state) => {
			const session = state.sessions[sessionKey];
			if (!session || session.activeTurnId !== turnId) return;
			state.sessions[sessionKey] = {
				...session,
				activeTurnId: undefined,
				activeTurnStartedAt: undefined,
				lastTurnStatus: status,
				updatedAt: Date.now(),
			};
		});
	}

	private load(): void {
		this.applyState(this.readState());
	}

	private transact(operation: (state: PersistedSessions) => void): void {
		withFileStateLock(this.filePath, () => {
			const state = this.readState();
			operation(state);
			this.writeState(state);
			this.applyState(state);
		});
	}

	private readState(): PersistedSessions {
		const raw = readRegularFile(this.filePath, "session state");
		if (raw === undefined) return { sessions: {}, dedupKeys: [] };
		const parsed = JSON.parse(raw) as Partial<PersistedSessions>;
		const sessions: Record<string, ChannelSessionRecord> = {};
		for (const [key, value] of Object.entries(parsed.sessions ?? {})) {
			if (value && typeof value === "object") sessions[key] = value;
		}
		const dedupKeys = (parsed.dedupKeys ?? []).filter(
			(key): key is string => typeof key === "string" && key.length > 0,
		);
		return { sessions, dedupKeys };
	}

	private writeState(state: PersistedSessions): void {
		atomicWriteJson(this.filePath, state, "session state");
	}

	private applyState(state: PersistedSessions): void {
		this.sessions.clear();
		for (const [key, value] of Object.entries(state.sessions)) this.sessions.set(key, value);
		this.dedupKeys.clear();
		this.dedupOrder.length = 0;
		for (const key of state.dedupKeys) {
			if (this.dedupKeys.has(key)) continue;
			this.dedupKeys.add(key);
			this.dedupOrder.push(key);
		}
		while (this.dedupOrder.length > this.maxDedupKeys) {
			const oldest = this.dedupOrder.shift();
			if (oldest !== undefined) this.dedupKeys.delete(oldest);
		}
	}
}

function sessionRecordFromKey(sessionKey: string, now: number): ChannelSessionRecord {
	return {
		sessionKey,
		channel: sessionKey.split(":", 1)[0] ?? "unknown",
		chatId: sessionKey.slice(sessionKey.indexOf(":") + 1),
		createdAt: now,
		updatedAt: now,
	};
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}
