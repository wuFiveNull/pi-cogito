import type { MessageBus } from "../bus.ts";
import type { PairingStore } from "../pairing.ts";
import type { ChannelOffsetStore } from "../state.ts";
import type { InboundMessage } from "../types.ts";

export type ChannelCleanup = () => void | Promise<void>;
export type ChannelEventHandler<T> = (event: T) => void | Promise<void>;

export interface ChannelLogger {
	debug(message: string, ...parameters: unknown[]): void;
	info(message: string, ...parameters: unknown[]): void;
	warn(message: string, ...parameters: unknown[]): void;
	error(message: string, ...parameters: unknown[]): void;
}

export interface ChannelEventBusLike {
	on<T>(eventName: string, handler: ChannelEventHandler<T>): () => void;
	emit<T>(eventName: string, event: T): void;
}

export interface ChannelSessionManager {
	getSession?(sessionKey: string): unknown | Promise<unknown>;
	recordInbound?(message: InboundMessage): void | Promise<void>;
	completeInbound?(message: InboundMessage, status: "completed" | "failed"): void | Promise<void>;
	beginTurn?(sessionKey: string, turnId: string): boolean | Promise<boolean>;
	completeTurn?(
		sessionKey: string,
		turnId: string,
		status: "completed" | "failed" | "interrupted",
	): void | Promise<void>;
}

export interface ChannelPushTool {
	// biome-ignore lint/suspicious/noConfusingVoidType: channel registration may not need cleanup
	registerChannel(channel: string, senders: Record<string, unknown>): ChannelCleanup | void;
}

export interface ChannelStoredAttachment {
	id: string;
	path: string;
	filename: string;
	mimeType?: string;
	sizeBytes: number;
}

export interface ChannelAttachmentStore {
	save(
		data: Uint8Array,
		options: { filename: string; mimeType?: string },
	): ChannelStoredAttachment | Promise<ChannelStoredAttachment>;
	resolve?(id: string): string | undefined;
}

export interface ChannelHttpResources {
	fetch?: typeof fetch;
}

/** Optional host-provided audio transcription (e.g. Whisper via the agent). */
export type ChannelAudioTranscriber = (data: Uint8Array, mimeType: string) => string | Promise<string>;

export interface ChannelInterruptRequest {
	sessionKey: string;
	senderId?: string;
	reason?: string;
}

export type ChannelInterruptStatus = "interrupted" | "not_found" | "already_interrupted";

export interface ChannelInterruptResult {
	status: ChannelInterruptStatus;
	sessionKey: string;
	message: string;
}

export interface ChannelInterruptControllerLike {
	register(sessionKey: string, controller: AbortController): () => void;
	requestInterrupt(request: ChannelInterruptRequest): ChannelInterruptResult;
}

export interface ChannelContextDependencies {
	sessionManager?: ChannelSessionManager;
	eventBus?: ChannelEventBusLike;
	pushTool?: ChannelPushTool;
	attachmentStore?: ChannelAttachmentStore;
	httpResources?: ChannelHttpResources;
	/** Optional audio transcription for inbound voice/audio messages. */
	transcriber?: ChannelAudioTranscriber;
	/** Optional pairing store for DM sender approval. */
	pairingStore?: PairingStore;
	offsetStore?: ChannelOffsetStore;
	interruptController?: ChannelInterruptControllerLike;
	logger?: ChannelLogger;
}

export interface ChannelContext extends ChannelContextDependencies {
	readonly bus: MessageBus;
	registerCleanup(cleanup: ChannelCleanup): () => void;
}

/** Per-channel dependency scope. Registrations are released in reverse order. */
export class ChannelContextScope implements ChannelContext {
	readonly bus: MessageBus;
	readonly sessionManager: ChannelSessionManager | undefined;
	readonly eventBus: ChannelEventBusLike | undefined;
	readonly pushTool: ChannelPushTool | undefined;
	readonly attachmentStore: ChannelAttachmentStore | undefined;
	readonly httpResources: ChannelHttpResources | undefined;
	readonly transcriber: ChannelAudioTranscriber | undefined;
	readonly pairingStore: PairingStore | undefined;
	readonly offsetStore: ChannelOffsetStore | undefined;
	readonly interruptController: ChannelInterruptControllerLike | undefined;
	readonly logger: ChannelLogger;
	private readonly cleanups = new Set<ChannelCleanup>();
	private closed = false;

	constructor(bus: MessageBus, dependencies: ChannelContextDependencies = {}) {
		this.bus = bus;
		this.sessionManager = dependencies.sessionManager;
		this.eventBus = dependencies.eventBus;
		this.pushTool = dependencies.pushTool;
		this.attachmentStore = dependencies.attachmentStore;
		this.httpResources = dependencies.httpResources;
		this.transcriber = dependencies.transcriber;
		this.pairingStore = dependencies.pairingStore;
		this.offsetStore = dependencies.offsetStore;
		this.interruptController = dependencies.interruptController;
		this.logger = dependencies.logger ?? consoleLogger;
	}

	registerCleanup(cleanup: ChannelCleanup): () => void {
		if (this.closed) throw new Error("channel context is closed");
		this.cleanups.add(cleanup);
		return () => this.cleanups.delete(cleanup);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const errors: unknown[] = [];
		for (const cleanup of [...this.cleanups].reverse()) {
			try {
				await cleanup();
			} catch (error) {
				errors.push(error);
			}
		}
		this.cleanups.clear();
		if (errors.length > 0) throw new AggregateError(errors, "channel context cleanup failed");
	}
}

/** Small in-process event bus suitable as the gateway default. */
export class ChannelEventEmitter implements ChannelEventBusLike {
	private readonly handlers = new Map<string, Set<(event: unknown) => void | Promise<void>>>();

	on<T>(eventName: string, handler: ChannelEventHandler<T>): () => void {
		const listener = (event: unknown): void | Promise<void> => handler(event as T);
		const handlers = this.handlers.get(eventName) ?? new Set<(event: unknown) => void | Promise<void>>();
		handlers.add(listener);
		this.handlers.set(eventName, handlers);
		return () => {
			handlers.delete(listener);
			if (handlers.size === 0) this.handlers.delete(eventName);
		};
	}

	emit<T>(eventName: string, event: T): void {
		for (const handler of this.handlers.get(eventName) ?? []) {
			try {
				void Promise.resolve(handler(event)).catch((error: unknown) => {
					console.error(`[gateway] event handler failed (${eventName}): ${formatError(error)}`);
				});
			} catch (error) {
				console.error(`[gateway] event handler failed (${eventName}): ${formatError(error)}`);
			}
		}
	}
}

const consoleLogger: ChannelLogger = {
	debug: (message, ...parameters) => console.debug(message, ...parameters),
	info: (message, ...parameters) => console.info(message, ...parameters),
	warn: (message, ...parameters) => console.warn(message, ...parameters),
	error: (message, ...parameters) => console.error(message, ...parameters),
};

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
