/**
 * ChannelAgentRuntime — connect a normalized channel SDK to an agent handler.
 *
 * The runtime owns delivery ordering per chat while allowing different chats
 * and channels to proceed independently. The gateway package stays agnostic of
 * the concrete agent implementation; callers provide the reply handler.
 */

import type { ChannelInterruptControllerLike } from "./channels/context.ts";
import type { ChannelSdk } from "./sdk.ts";
import { createMessageId, type InboundMessage, type OutboundMessage } from "./types.ts";

export type ChannelReply = string | OutboundMessage | undefined;

export type ChannelReplyHandler = (message: InboundMessage, signal?: AbortSignal) => Promise<ChannelReply>;

export type ChannelAgentErrorHandler = (message: InboundMessage, error: unknown) => void | Promise<void>;

export interface ChannelAgentRuntimeOptions {
	sdk: ChannelSdk;
	handleMessage: ChannelReplyHandler;
	onError?: ChannelAgentErrorHandler;
	interruptController?: ChannelInterruptControllerLike;
	/**
	 * Turn-boundary merging, enabled when > 0 (the value is a boolean switch):
	 * the first message of a burst is processed immediately; messages that
	 * arrive while a turn is in flight are queued and merged into ONE turn as
	 * soon as the current turn finishes (before the second message would start
	 * on its own). 0 disables merging (each message gets its own turn).
	 */
	mergeWindowMs?: number;
}

export class ChannelAgentRuntime {
	private readonly sdk: ChannelSdk;
	private readonly handleMessage: ChannelReplyHandler;
	private readonly onError: ChannelAgentErrorHandler | undefined;
	private readonly interruptController: ChannelInterruptControllerLike;
	private readonly mergeEnabled: boolean;
	private readonly pending = new Map<string, Promise<void>>();
	/** Per-session backlog of messages waiting behind the active turn. */
	private readonly sessionQueues = new Map<string, InboundMessage[]>();
	private readonly sessionBusy = new Set<string>();
	private readonly activeControllers = new Set<AbortController>();
	private unsubscribe: (() => void) | undefined;
	private started = false;

	constructor(options: ChannelAgentRuntimeOptions) {
		this.sdk = options.sdk;
		this.handleMessage = options.handleMessage;
		this.onError = options.onError;
		this.interruptController = options.interruptController ?? options.sdk.interruptController;
		this.mergeEnabled = (options.mergeWindowMs ?? 0) > 0;
	}

	async start(): Promise<void> {
		if (this.started) return;
		const unsubscribe = this.sdk.onMessage((message) => {
			return this.enqueue(message);
		});
		try {
			await this.sdk.start();
			this.unsubscribe = unsubscribe;
			this.started = true;
		} catch (error) {
			unsubscribe();
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (!this.started && !this.unsubscribe) return;
		this.started = false;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		for (const controller of this.activeControllers) controller.abort("channel runtime stopping");
		await this.sdk.stop();
		this.sessionQueues.clear();
		this.sessionBusy.clear();
		const pending = [...this.pending.values()];
		await Promise.allSettled(pending);
		this.pending.clear();
	}

	get isStarted(): boolean {
		return this.started;
	}

	private enqueue(message: InboundMessage): Promise<void> {
		if (!this.mergeEnabled) return this.enqueueDirect(message);
		const sessionKey = message.sessionKey;
		const queue = this.sessionQueues.get(sessionKey) ?? [];
		queue.push(message);
		this.sessionQueues.set(sessionKey, queue);
		if (!this.sessionBusy.has(sessionKey)) {
			this.sessionBusy.add(sessionKey);
			void this.drain(sessionKey);
		}
		return Promise.resolve();
	}

	/**
	 * Process a session's backlog turn by turn. The first message of a burst
	 * starts immediately; once the active turn finishes, everything that piled
	 * up behind it is merged into a single turn (so the second message never
	 * starts on its own while more are queued).
	 */
	private async drain(sessionKey: string): Promise<void> {
		try {
			while (true) {
				const queue = this.sessionQueues.get(sessionKey);
				if (!queue || queue.length === 0) break;
				const batch = queue.splice(0, queue.length);
				await this.process(mergeMessages(batch)).catch(() => undefined);
			}
		} finally {
			this.sessionBusy.delete(sessionKey);
			const queue = this.sessionQueues.get(sessionKey);
			if (queue && queue.length > 0) {
				// Messages raced in while the busy flag was being torn down.
				this.sessionBusy.add(sessionKey);
				void this.drain(sessionKey);
			} else {
				this.sessionQueues.delete(sessionKey);
			}
		}
	}

	private enqueueDirect(message: InboundMessage): Promise<void> {
		const previous = this.pending.get(message.sessionKey) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(() => this.process(message));
		this.pending.set(message.sessionKey, current);
		void current.then(
			() => this.removePending(message.sessionKey, current),
			() => this.removePending(message.sessionKey, current),
		);
		return current;
	}

	private async process(message: InboundMessage): Promise<void> {
		const controller = new AbortController();
		this.activeControllers.add(controller);
		const unregisterInterrupt = this.interruptController.register(message.sessionKey, controller);
		const turnId = createMessageId("turn");
		const sessionManager = this.sdk.sessionManager;
		let turnAdmitted = false;
		let turnStatus: "completed" | "failed" | "interrupted" = "failed";
		try {
			await sessionManager?.recordInbound?.(message);
			const admitted = sessionManager?.beginTurn ? await sessionManager.beginTurn(message.sessionKey, turnId) : true;
			if (!admitted) {
				this.sdk.events.emit("turn.rejected", {
					turnId,
					sessionKey: message.sessionKey,
					channel: message.channel,
					chatId: message.chatId,
					reason: "session already has an active turn",
				});
				return;
			}
			turnAdmitted = true;
			this.sdk.events.emit("turn.started", {
				turnId,
				sessionKey: message.sessionKey,
				channel: message.channel,
				chatId: message.chatId,
				messageId: message.messageId,
			});
			const reply = await this.handleMessage(message, controller.signal);
			if (controller.signal.aborted) throw new Error("channel turn interrupted");
			if (reply !== undefined) {
				const outbound =
					typeof reply === "string" ? toOutboundMessage(message, reply, turnId) : { ...reply, turnId };
				await this.sdk.send(outbound);
			}
			turnStatus = "completed";
			this.sdk.events.emit("turn.completed", {
				turnId,
				sessionKey: message.sessionKey,
				channel: message.channel,
				chatId: message.chatId,
			});
		} catch (error) {
			this.sdk.events.emit(controller.signal.aborted ? "turn.interrupted" : "turn.failed", {
				turnId,
				sessionKey: message.sessionKey,
				channel: message.channel,
				chatId: message.chatId,
				error,
			});
			if (!controller.signal.aborted) this.reportError(message, error);
			if (controller.signal.aborted) turnStatus = "interrupted";
			if (!controller.signal.aborted) throw error;
		} finally {
			try {
				if (turnAdmitted) await sessionManager?.completeTurn?.(message.sessionKey, turnId, turnStatus);
			} catch (error) {
				console.error(`[gateway] session turn cleanup failed: ${formatError(error)}`);
			}
			try {
				await sessionManager?.completeInbound?.(message, turnStatus === "completed" ? "completed" : "failed");
			} catch (error) {
				console.error(`[gateway] inbound session cleanup failed: ${formatError(error)}`);
			}
			unregisterInterrupt();
			this.activeControllers.delete(controller);
		}
	}

	private removePending(sessionKey: string, task: Promise<void>): void {
		if (this.pending.get(sessionKey) === task) this.pending.delete(sessionKey);
	}

	private reportError(message: InboundMessage, error: unknown): void {
		const handler = this.onError;
		if (!handler) {
			console.error(
				`[gateway] message failed channel=${message.channel} chat=${message.chatId}: ${formatError(error)}`,
			);
			return;
		}
		try {
			void Promise.resolve(handler(message, error)).catch((handlerError: unknown) => {
				console.error(`[gateway] error handler failed: ${formatError(handlerError)}`);
			});
		} catch (handlerError) {
			console.error(`[gateway] error handler failed: ${formatError(handlerError)}`);
		}
	}
}

function toOutboundMessage(message: InboundMessage, content: string, turnId: string): OutboundMessage {
	return {
		channel: message.channel,
		chatId: message.chatId,
		content,
		replyTo: message.messageId,
		replyContext: message.replyTo,
		turnId,
	};
}

/**
 * Combine a merge-batch of messages into one synthetic message. A single
 * message passes through unchanged; multiples are numbered into one content
 * block with images (if any) appended, so the agent answers them as a whole.
 */
function mergeMessages(messages: InboundMessage[]): InboundMessage {
	const first = messages[0];
	if (messages.length === 1) return first;
	const numbered = messages.map((message, index) => `${index + 1}. ${message.content}`).join("\n");
	const images = messages.flatMap((message) => message.images ?? []);
	return {
		...first,
		content: numbered,
		...(images.length > 0 ? { images } : {}),
	};
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
