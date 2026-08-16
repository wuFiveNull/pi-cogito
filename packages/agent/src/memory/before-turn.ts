import type { AgentEvent, AgentLifecycleModule, AgentMessage } from "../types.ts";
import {
	type ConsolidationConfig,
	consolidateMessages,
	type SessionCursorStore,
	type SessionMessageLike,
} from "./extract.ts";
import type { MarkdownMemoryStore } from "./markdown-store.ts";
import type { MemoryLlm } from "./optimizer.ts";

class InMemoryCursorStore implements SessionCursorStore {
	private readonly cursors = new Map<string, number>();

	getCursor(sessionFile: string): number {
		return this.cursors.get(sessionFile) ?? 0;
	}

	setCursor(sessionFile: string, cursor: number): void {
		this.cursors.set(sessionFile, cursor);
	}
}

export interface MemoryBeforeTurnOptions {
	store: MarkdownMemoryStore;
	llm: MemoryLlm;
	/** Stable agent/session id; different conversations keep independent cursors. */
	sessionId: string;
	cursorStore?: SessionCursorStore;
	config?: ConsolidationConfig;
	/** Called when event-driven extraction fails; the agent turn is not blocked. */
	onError?: (error: unknown) => void;
}

export interface MemoryBeforeTurnGuardOptions extends MemoryBeforeTurnOptions {
	/** Abort an overloaded turn when consolidation cannot make progress. Default: true. */
	blockOnError?: boolean;
}

/**
 * Creates an Agent.subscribe-compatible before_turn listener.
 *
 * The first turn only establishes the conversation. Each later before_turn
 * consolidates the messages completed since the previous event, while the
 * existing directory loop remains as a recovery path for a run that ends
 * without another turn.
 */
export function createMemoryBeforeTurnListener(options: MemoryBeforeTurnOptions): (event: AgentEvent) => Promise<void> {
	const cursorStore = options.cursorStore ?? new InMemoryCursorStore();
	const sessionKey = `agent:${options.sessionId}`;
	let running: Promise<void> | undefined;

	return async (event) => {
		if (event.type !== "before_turn" || event.turnIndex === 0) return;
		if (running) return running;
		const task = consolidateMessages({
			store: options.store,
			llm: options.llm,
			sessionKey,
			messages: event.context.messages.flatMap(toSessionMessage),
			cursorStore,
			config: { ...options.config, force: options.config?.force ?? true, minNewMessages: 1 },
		})
			.then(() => undefined)
			.catch((error: unknown) => {
				options.onError?.(error);
			});
		running = task;
		try {
			await task;
		} finally {
			if (running === task) running = undefined;
		}
	};
}

/**
 * Creates a lifecycle module that consolidates memory before a provider call.
 *
 * Unlike the compatibility event listener, a failed consolidation can block
 * the next request once history has crossed the configured consolidation
 * threshold. The directory polling loop remains the recovery path.
 */
export function createMemoryBeforeTurnModule(options: MemoryBeforeTurnGuardOptions): AgentLifecycleModule {
	const cursorStore = options.cursorStore ?? new InMemoryCursorStore();
	const sessionKey = `agent:${options.sessionId}`;
	let running: Promise<boolean> | undefined;

	return {
		phase: "before_turn",
		slot: "memory.consolidate",
		async run(frame) {
			if (frame.context.turnIndex === 0) return;
			let task = running;
			if (!task) {
				task = consolidateMessages({
					store: options.store,
					llm: options.llm,
					sessionKey,
					messages: frame.context.agentContext.messages.flatMap(toSessionMessage),
					cursorStore,
					config: options.config,
				})
					.then(() => true)
					.catch((error: unknown) => {
						options.onError?.(error);
						return false;
					});
				running = task;
			}
			try {
				const consolidated = await task;
				frame.set("memory.consolidated", consolidated);
				if (!consolidated && (options.blockOnError ?? true)) {
					frame.context.abort = {
						reason: "Memory consolidation failed before this turn. Resolve the memory backlog and retry.",
					};
				}
			} finally {
				if (running === task) running = undefined;
			}
		},
	};
}

function toSessionMessage(message: AgentMessage): SessionMessageLike[] {
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return [];
	const timestamp = "timestamp" in message ? String(message.timestamp) : new Date().toISOString();
	return [
		{
			id: message.role === "toolResult" ? message.toolCallId : undefined,
			role: message.role,
			content: message.content,
			timestamp,
		},
	];
}
