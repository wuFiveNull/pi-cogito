/**
 * ChatSessionPool — one AgentSession per chat conversation.
 *
 * Sessions are created lazily per sessionKey, persisted through the channel
 * session store, and recycled: idle sessions are disposed after maxIdleMinutes
 * and re-created from their persisted transcript on the next message, and the
 * pool is capped at maxSessions (LRU eviction of idle sessions).
 */

import { existsSync } from "node:fs";
import type { ThinkingLevel } from "@cogito/agent-core";
import type { Model } from "@cogito/ai";
import type { FileChannelSessionStore } from "@cogito/gateway";
import {
	createAgentSession,
	type ExtensionSqlite,
	type ResourceLoader,
	SessionManager,
	type SettingsManager,
	type ToolDefinition,
} from "@cogito/host";

export type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export interface ChatSessionScope {
	sessionKey: string;
	channel: string;
	chatId: string;
}

export interface ChatSessionPoolOptions {
	projectDir: string;
	agentDir: string;
	agentSessionDir: string;
	channelSessionStore: FileChannelSessionStore;
	extensionSqlite: ExtensionSqlite;
	settingsManager: SettingsManager;
	/** Per-session resource loader (chat inline extensions capture the scope). */
	createResourceLoader: (scope: ChatSessionScope) => Promise<ResourceLoader>;
	/** Model reference for new sessions. */
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	/** Tool allowlist (only these are exposed and active). */
	allowedToolNames?: string[];
	/** Tool denylist. */
	excludedToolNames?: string[];
	/** Tools registered on every session (extension tools are registered separately). */
	customTools?: ToolDefinition[];
	maxSessions?: number;
	maxIdleMinutes?: number;
	log?: (message: string) => void;
}

export class ChatSessionPool {
	private readonly sessionsByKey = new Map<string, Promise<AgentSession>>();
	private readonly sessions = new Set<AgentSession>();
	private readonly lastUsedAt = new Map<string, number>();
	private readonly options: ChatSessionPoolOptions;
	private readonly maxSessions: number;
	private readonly maxIdleMs: number;
	private reaper: NodeJS.Timeout | undefined;

	constructor(options: ChatSessionPoolOptions) {
		this.options = options;
		this.maxSessions = Math.max(1, options.maxSessions ?? 50);
		this.maxIdleMs = Math.max(1, options.maxIdleMinutes ?? 30) * 60_000;
	}

	/** Resolve (or create) the session for a conversation. */
	getOrCreate(scope: ChatSessionScope): Promise<AgentSession> {
		const existing = this.sessionsByKey.get(scope.sessionKey);
		if (existing) {
			this.lastUsedAt.set(scope.sessionKey, Date.now());
			return existing;
		}
		const created = this.create(scope);
		this.sessionsByKey.set(scope.sessionKey, created);
		void created.catch(() => {
			if (this.sessionsByKey.get(scope.sessionKey) === created) {
				this.sessionsByKey.delete(scope.sessionKey);
			}
		});
		return created;
	}

	/** Whether a session is currently resident for the key. */
	has(scope: ChatSessionScope): boolean {
		return this.sessionsByKey.has(scope.sessionKey);
	}

	/** Number of resident sessions. */
	get size(): number {
		return this.sessions.size;
	}

	/** Start the idle reaper. */
	start(): void {
		if (this.reaper) return;
		this.reaper = setInterval(() => this.reapIdle(), 60_000);
		this.reaper.unref?.();
	}

	/** Stop the idle reaper. */
	stop(): void {
		if (this.reaper) clearInterval(this.reaper);
		this.reaper = undefined;
	}

	/** Dispose every resident session. */
	disposeAll(): void {
		this.stop();
		const sessions = [...this.sessions];
		this.sessions.clear();
		this.sessionsByKey.clear();
		this.lastUsedAt.clear();
		for (const session of sessions) session.dispose();
	}

	private async create(scope: ChatSessionScope): Promise<AgentSession> {
		this.evictIfNeeded();
		const persisted = this.options.channelSessionStore.getSession(scope.sessionKey);
		const sessionManager =
			persisted?.agentSessionFile && existsSync(persisted.agentSessionFile)
				? SessionManager.open(persisted.agentSessionFile, this.options.agentSessionDir, this.options.projectDir)
				: SessionManager.create(this.options.projectDir, this.options.agentSessionDir);
		const resourceLoader = await this.options.createResourceLoader(scope);
		const created = createAgentSession({
			cwd: this.options.projectDir,
			extensionSqlite: this.options.extensionSqlite,
			sessionManager,
			resourceLoader,
			settingsManager: this.options.settingsManager,
			model: this.options.model,
			thinkingLevel: this.options.thinkingLevel,
			tools: this.options.allowedToolNames,
			excludeTools: this.options.excludedToolNames,
			customTools: this.options.customTools,
		}).then(({ session, modelFallbackMessage, extensionsResult }) => {
			if (modelFallbackMessage) this.options.log?.(modelFallbackMessage);
			if (extensionsResult.errors.length > 0) {
				this.options.log?.(`extension errors: ${JSON.stringify(extensionsResult.errors)}`);
			}
			if (session.sessionFile) {
				this.options.channelSessionStore.setAgentSession(scope.sessionKey, {
					file: session.sessionFile,
					id: session.sessionId,
				});
			}
			this.sessions.add(session);
			this.lastUsedAt.set(scope.sessionKey, Date.now());
			return session;
		});
		return created;
	}

	/** Enforce maxSessions by evicting the least recently used idle session. */
	private evictIfNeeded(): void {
		if (this.sessions.size < this.maxSessions) return;
		const idle = [...this.sessionsByKey.entries()].filter(([key]) => this.lastUsedAt.get(key) !== undefined);
		idle.sort((a, b) => (this.lastUsedAt.get(a[0]) ?? 0) - (this.lastUsedAt.get(b[0]) ?? 0));
		for (const [key, promise] of idle) {
			void promise.then((session) => {
				if (!session.isIdle) return;
				this.dispose(key, session);
			});
			if (this.sessions.size < this.maxSessions) break;
		}
	}

	private reapIdle(): void {
		const now = Date.now();
		for (const [key, promise] of this.sessionsByKey) {
			const lastUsed = this.lastUsedAt.get(key) ?? 0;
			if (now - lastUsed < this.maxIdleMs) continue;
			void promise.then((session) => {
				if (!session.isIdle) return;
				this.options.log?.(`session ${key} idle for >${this.maxIdleMs / 60000}min, disposing`);
				this.dispose(key, session);
			});
		}
	}

	private dispose(key: string, session: AgentSession): void {
		if (!this.sessions.has(session)) return;
		this.sessions.delete(session);
		this.sessionsByKey.delete(key);
		this.lastUsedAt.delete(key);
		session.dispose();
	}
}
