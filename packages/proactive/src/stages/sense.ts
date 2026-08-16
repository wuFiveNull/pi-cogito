/**
 * Presence — per-session user heartbeat (akashic presence.py port).
 *
 * Unlike the old mtime-based heuristic, presence is persisted in
 * proactive.sqlite (last_user_at / last_proactive_at). The pusher refreshes
 * last_user_at by scanning session jsonl files for the timestamp of the most
 * recent user message (exact, not file mtime); the delivery path records
 * last_proactive_at. Both timestamps drive the energy model.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Clock, SystemClock } from "../clock.ts";
import type { ProactivePresencePort } from "../runtime/ports.ts";
import type { ProactiveStore } from "../store.ts";

/** The local terminal user's presence key (single-user, no IM channels yet). */
export const DEFAULT_SESSION_KEY = "local";

export interface PresenceConfig {
	/** Directory containing session .jsonl files (one level of subdirectories). */
	sessionsDir?: string;
	/** 目标会话 key(akashic channel:chat_id;默认 local)。 */
	sessionKey?: string;
	/** 可注入时钟。 */
	clock?: Clock;
}

interface JsonlMessage {
	type?: string;
	message?: { role?: string; content?: unknown; timestamp?: string | number };
}

/** Extract the newest user-message timestamp (ms) from a session jsonl file. */
function newestUserMessageAt(file: string): number | undefined {
	let latest: number | undefined;
	let lines: string[];
	try {
		lines = readFileSync(file, "utf-8").split("\n");
	} catch {
		return undefined;
	}
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: JsonlMessage;
		try {
			entry = JSON.parse(line) as JsonlMessage;
		} catch {
			continue;
		}
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const raw = entry.message.timestamp;
		// Session writers store either an ISO string or an epoch-ms number.
		const parsed =
			typeof raw === "string" ? Date.parse(raw) : typeof raw === "number" && Number.isFinite(raw) ? raw : Number.NaN;
		if (Number.isFinite(parsed) && (latest === undefined || parsed > latest)) {
			latest = parsed;
		}
	}
	return latest;
}

/**
 * Scan a sessions directory (jsonl files, one level of subdirectories) for the
 * newest user-message timestamp. Shared by Presence.scanChanged and the
 * standalone runtime port (which must not shadow the scan with a store read).
 */
export function scanSessionsDir(sessionsDir: string | undefined): number | null {
	if (!sessionsDir) return null;
	let files: string[];
	try {
		files = readdirSync(sessionsDir);
	} catch {
		return null;
	}
	let latest: number | null = null;
	const scanFile = (file: string): void => {
		const ts = newestUserMessageAt(file);
		if (ts !== undefined && (latest === null || ts > latest)) latest = ts;
	};
	for (const name of files) {
		const full = join(sessionsDir, name);
		if (name.endsWith(".jsonl")) {
			scanFile(full);
			continue;
		}
		try {
			if (statSync(full).isDirectory()) {
				for (const inner of readdirSync(full)) {
					if (inner.endsWith(".jsonl")) scanFile(join(full, inner));
				}
			}
		} catch {
			// Not a directory; skip.
		}
	}
	return latest;
}

/** 单个文件的扫描缓存:mtime/size 未变则跳过重读。 */
interface FileScanState {
	mtimeMs: number;
	size: number;
	latestTs: number;
}

export class Presence {
	private readonly store: ProactiveStore;
	private readonly config: PresenceConfig;
	private readonly sessionKey: string;
	private readonly clock: Clock;
	private readonly runtimePort: ProactivePresencePort | undefined;
	/** 每文件扫描缓存(akashic sessions.db 直接读的 pi 形态:只重读变化文件)。 */
	private readonly fileCache = new Map<string, FileScanState>();
	/** 显式记录的最后用户消息时间(akashic record_user_message);与扫描结果取 max。 */
	private recordedUserAt: number | null = null;

	constructor(store: ProactiveStore, config: PresenceConfig = {}, runtimePort?: ProactivePresencePort) {
		this.store = store;
		this.config = config;
		this.sessionKey = config.sessionKey ?? DEFAULT_SESSION_KEY;
		this.clock = config.clock ?? SystemClock;
		this.runtimePort = runtimePort;
	}

	private sessionFiles(): string[] {
		const dir = this.config.sessionsDir;
		if (!dir) return [];
		const files: string[] = [];
		try {
			for (const name of readdirSync(dir)) {
				const full = join(dir, name);
				if (name.endsWith(".jsonl")) {
					files.push(full);
				} else {
					try {
						if (statSync(full).isDirectory()) {
							for (const inner of readdirSync(full)) {
								if (inner.endsWith(".jsonl")) files.push(join(full, inner));
							}
						}
					} catch {
						// Not a directory; skip.
					}
				}
			}
		} catch {
			return [];
		}
		return files;
	}

	/**
	 * 增量扫描:只重读 mtime/size 变化的文件,未变文件直接取缓存值。
	 * 返回本次可见的最新用户消息时间(所有文件,含缓存)。
	 */
	private scanChanged(): number | null {
		let latest: number | null = null;
		for (const file of this.sessionFiles()) {
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(file);
			} catch {
				continue;
			}
			const cached = this.fileCache.get(file);
			if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
				if (cached.latestTs > (latest ?? 0)) latest = cached.latestTs;
				continue;
			}
			const ts = newestUserMessageAt(file);
			const state: FileScanState = { mtimeMs: stat.mtimeMs, size: stat.size, latestTs: ts ?? 0 };
			this.fileCache.set(file, state);
			if (ts !== undefined && ts > (latest ?? 0)) latest = ts;
		}
		return latest;
	}

	/** Latest user-message timestamp across all session files (ms), or undefined. */
	lastInteractionAt(): number | undefined {
		let latest: number | undefined;
		for (const file of this.sessionFiles()) {
			const ts = newestUserMessageAt(file);
			if (ts !== undefined && (latest === undefined || ts > latest)) latest = ts;
		}
		return latest;
	}

	/**
	 * 显式记录一条用户消息(akashic PresenceStore.record_user_message 的 pi 形态):
	 * 会话写入方可直接调用,presence 不依赖 tick 扫描即可实时更新。
	 */
	recordUserMessage(timestampMs: number): void {
		if (!Number.isFinite(timestampMs)) return;
		if (this.recordedUserAt !== null && timestampMs <= this.recordedUserAt) return;
		this.recordedUserAt = timestampMs;
		this.runtimePort?.recordUserMessage?.({ sessionKey: this.sessionKey, timestamp: timestampMs });
		const stored = this.store.getPresence(this.sessionKey).last_user_at;
		if (stored === null || timestampMs > stored) {
			this.store.updatePresence(this.sessionKey, { last_user_at: timestampMs });
		}
	}

	/**
	 * Refresh persisted presence from the session files, then return the
	 * store's authoritative last_user_at. Called once per tick; only changed
	 * files are re-read (incremental scan, akashic record-on-write 的近似),
	 * and explicitly recorded timestamps take precedence over stale scans.
	 */
	refresh(): number | null {
		const runtimePresence = this.runtimePort?.refresh?.({ sessionKey: this.sessionKey, now: this.clock.nowMs() });
		if (runtimePresence) {
			if (runtimePresence.lastUserAt !== null) {
				this.store.updatePresence(this.sessionKey, { last_user_at: runtimePresence.lastUserAt });
			}
			if (runtimePresence.lastProactiveAt !== null) {
				this.store.updatePresence(this.sessionKey, { last_proactive_at: runtimePresence.lastProactiveAt });
			}
			return runtimePresence.lastUserAt;
		}
		const scanned = this.scanChanged();
		const stored = this.store.getPresence(this.sessionKey).last_user_at;
		const candidates = [scanned, this.recordedUserAt, stored].filter((value): value is number => value !== null);
		const effective = candidates.length > 0 ? Math.max(...candidates) : null;
		if (effective !== null && effective !== stored) {
			this.store.updatePresence(this.sessionKey, { last_user_at: effective });
		}
		return effective;
	}

	getLastUserAt(): number | null {
		return this.store.getPresence(this.sessionKey).last_user_at;
	}

	getLastProactiveAt(): number | null {
		const runtimePresence = this.runtimePort?.get?.(this.sessionKey);
		if (runtimePresence) return runtimePresence.lastProactiveAt;
		return this.store.getPresence(this.sessionKey).last_proactive_at;
	}

	recordProactiveSent(now?: number): void {
		const timestamp = now ?? this.clock.nowMs();
		this.runtimePort?.recordProactiveSent?.({ sessionKey: this.sessionKey, timestamp });
		this.store.updatePresence(this.sessionKey, { last_proactive_at: timestamp });
	}
}

// ------------------------------------------------------------------
// 感知策略(默认:jsonl 会话扫描)
// ------------------------------------------------------------------
import { computeEnergy, dEnergy } from "./schedule.ts";
import type { PresenceStrategy, SenseState } from "./types.ts";

export class JsonlPresenceStrategy implements PresenceStrategy {
	readonly id = "jsonl-presence";
	private readonly presence: Presence;
	private readonly scoreWeightEnergy: number;
	private readonly clock: Clock;

	constructor(presence: Presence, scoreWeightEnergy = 0.4, clock: Clock = SystemClock) {
		this.presence = presence;
		this.scoreWeightEnergy = scoreWeightEnergy;
		this.clock = clock;
	}

	async sense(): Promise<SenseState> {
		const lastUserAt = this.presence.refresh();
		const lastProactiveAt = this.presence.getLastProactiveAt();
		const energy = computeEnergy(lastUserAt, this.clock.nowMs());
		const baseScore = dEnergy(energy) * this.scoreWeightEnergy;
		return { lastUserAt, lastProactiveAt, energy, baseScore };
	}

	/** 投递成功后记录主动消息时间(由引擎在 deliver 成功后调用)。 */
	recordProactiveSent(now?: number): void {
		this.presence.recordProactiveSent(now ?? this.clock.nowMs());
	}

	getLastUserAt(): number | null {
		return this.presence.getLastUserAt();
	}
}
