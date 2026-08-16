/**
 * Host-facing ports for the proactive engine.
 *
 * The engine owns scheduling, judgement, reservoir state and delivery audit
 * state. A host owns authoritative sessions, memory, presence, channels and
 * source acknowledgement. Keeping those boundaries explicit lets the same
 * lifecycle run inside pi-cogito or as a standalone package.
 */

import { formatPreferenceBlock, type RecalledPreference, recallPreferences } from "@cogito/gate";
import { DEFAULT_SESSION_KEY, scanSessionsDir } from "../stages/sense.ts";
import type { DeliveryTargetReceipt, ProactiveStore } from "../store.ts";

export type MaybePromise<T> = T | Promise<T>;

export interface ProactiveSessionMessage {
	role: "user" | "assistant" | "system";
	content: string;
	timestamp?: number;
	proactive?: boolean;
}

export interface ProactiveSessionTurnPair {
	user: string;
	assistant: string;
}

export interface ProactiveSessionPort {
	recentMessages?(input: {
		sessionKey: string;
		limit: number;
		now: Date;
	}): MaybePromise<readonly ProactiveSessionMessage[]>;
	turnPairs?(input: {
		sessionKey: string;
		limit: number;
		now: Date;
	}): MaybePromise<readonly ProactiveSessionTurnPair[]>;
	signature?(sessionKey: string): MaybePromise<string>;
	appendAssistantMessage?(input: {
		sessionKey: string;
		content: string;
		timestamp: number;
		proactive: true;
	}): MaybePromise<void>;
}

export interface ProactivePresenceSnapshot {
	lastUserAt: number | null;
	lastProactiveAt: number | null;
}

export interface ProactivePresencePort {
	refresh?(input: { sessionKey: string; now: number }): ProactivePresenceSnapshot;
	get?(sessionKey: string): ProactivePresenceSnapshot;
	recordUserMessage?(input: { sessionKey: string; timestamp: number }): void;
	recordProactiveSent?(input: { sessionKey: string; timestamp: number }): void;
}

export interface ProactiveBusyPort {
	isBusy(sessionKey: string, now: Date): boolean;
}

export interface ProactiveMemoryContext {
	sessionKey: string;
	now: Date;
}

export interface ProactiveMemoryPort {
	preferenceBlock?(context: ProactiveMemoryContext): MaybePromise<string>;
	memoryText?(context: ProactiveMemoryContext): MaybePromise<string>;
	recall?(
		context: ProactiveMemoryContext & { query: string; limit: number },
	): MaybePromise<readonly RecalledPreference[]>;
	beforeTurn?(context: ProactiveMemoryContext): MaybePromise<void>;
	recordEvent?(input: { sessionKey: string; event: Record<string, unknown>; now: number }): MaybePromise<void>;
}

export type ProactiveDeliveryStatus = "success" | "partial" | "failed" | "cancelled";

export interface ProactiveOutboundMessage {
	sessionKey: string;
	message: string;
	sourceRefs: readonly Record<string, unknown>[];
	deliveryKey?: string;
}

export interface ProactiveOutboundReceipt {
	status: ProactiveDeliveryStatus;
	providerMessageId?: string;
	detail?: string;
	targetReceipts?: readonly DeliveryTargetReceipt[];
}

export interface ProactiveOutboundPort {
	send(message: ProactiveOutboundMessage): Promise<ProactiveOutboundReceipt>;
}

export interface ProactiveSourceAckPort {
	acknowledge(sourceId: string, eventIds: readonly string[]): Promise<void>;
}

export interface ProactiveRuntimePorts {
	session?: ProactiveSessionPort;
	presence?: ProactivePresencePort;
	busy?: ProactiveBusyPort;
	memory?: ProactiveMemoryPort;
	outbound?: ProactiveOutboundPort;
	sourceAck?: ProactiveSourceAckPort;
}

export interface StandaloneRuntimeAdapterOptions {
	store: ProactiveStore;
	memoryDbPath?: string;
	/** Session jsonl directory; presence refresh scans it for user activity. */
	sessionsDir?: string;
	/** Target session key (default "local"). */
	sessionKey?: string;
}

/**
 * Minimal adapter used when no host runtime is supplied. It keeps local
 * presence and preference recall working while leaving session/channel
 * authority to the existing standalone implementations.
 */
export class StandaloneRuntimeAdapter {
	readonly ports: ProactiveRuntimePorts;

	constructor(options: StandaloneRuntimeAdapterOptions) {
		const { store, memoryDbPath, sessionsDir, sessionKey = DEFAULT_SESSION_KEY } = options;
		this.ports = {
			presence: {
				refresh: ({ sessionKey: key }) => {
					const target = key ?? sessionKey;
					const stored = readPresence(store, target);
					// Scan session files for user activity; never shadow the scan
					// with a store read (the store only has scan/gateway writes).
					const scanned = scanSessionsDir(sessionsDir);
					const lastUserAt = Math.max(scanned ?? 0, stored.lastUserAt ?? 0) || null;
					if (lastUserAt !== null && lastUserAt !== stored.lastUserAt) {
						store.updatePresence(target, { last_user_at: lastUserAt });
					}
					return { lastUserAt, lastProactiveAt: stored.lastProactiveAt };
				},
				get: (key) => readPresence(store, key ?? sessionKey),
				recordUserMessage: ({ sessionKey: key, timestamp }) => {
					store.updatePresence(key ?? sessionKey, { last_user_at: timestamp });
				},
				recordProactiveSent: ({ sessionKey: key, timestamp }) => {
					store.updatePresence(key ?? sessionKey, { last_proactive_at: timestamp });
				},
			},
			memory: memoryDbPath
				? {
						preferenceBlock: () => formatPreferenceBlock(recallPreferences(memoryDbPath)),
						recall: ({ query, limit }) => recallPreferences(memoryDbPath, query, limit),
					}
				: undefined,
		};
	}
}

export function mergeRuntimePorts(
	base: ProactiveRuntimePorts,
	overrides: ProactiveRuntimePorts | undefined,
): ProactiveRuntimePorts {
	if (!overrides) return base;
	return {
		...base,
		...overrides,
		session: mergePort(base.session, overrides.session),
		presence: mergePort(base.presence, overrides.presence),
		busy: mergePort(base.busy, overrides.busy),
		memory: mergePort(base.memory, overrides.memory),
		outbound: mergePort(base.outbound, overrides.outbound),
		sourceAck: mergePort(base.sourceAck, overrides.sourceAck),
	};
}

function mergePort<T extends object>(base: T | undefined, override: T | undefined): T | undefined {
	if (!base) return override;
	if (!override) return base;
	return { ...base, ...override };
}

function readPresence(store: ProactiveStore, sessionKey: string): ProactivePresenceSnapshot {
	const presence = store.getPresence(sessionKey);
	return {
		lastUserAt: presence.last_user_at,
		lastProactiveAt: presence.last_proactive_at,
	};
}
