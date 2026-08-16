/**
 * Typed outbound events carried by OutboundMessage/OutboundDelta.
 *
 * Mirrors nanobot's bus/outbound_events.py: platform-agnostic runtime/UI
 * semantics (progress, tool hints, reasoning, streaming, turn lifecycle) ride
 * on the message's explicit `event` field instead of reserved metadata flags.
 *
 * Events are JSON-serializable: outbox persistence round-trips them as plain
 * objects, so routing is keyed on the `kind` string, not `instanceof`.
 */

import type { OutboundMessage } from "./types.ts";

export abstract class OutboundEvent {
	/** Stable discriminator, survives JSON round-trips through the outbox. */
	abstract readonly kind: string;
}

/** Process progress: status text, tool hints, reasoning, file-edit events. */
export class ProgressEvent extends OutboundEvent {
	readonly kind = "progress";
	content = "";
	toolHint = false;
	toolEvents?: Array<Record<string, unknown>>;
	fileEditEvents?: Array<Record<string, unknown>>;
	/** One-shot reasoning block (full content). */
	reasoning = false;
	/** Streaming reasoning chunk. */
	reasoningDelta = false;
	/** End of a reasoning stream segment. */
	reasoningEnd = false;
	streamId?: string;

	constructor(init: Partial<ProgressEvent> = {}) {
		super();
		Object.assign(this, init);
	}
}

/** Streaming text chunk (delivered through the delta queue). */
export class StreamDeltaEvent extends OutboundEvent {
	readonly kind = "stream_delta";
	content = "";
	streamId?: string;

	constructor(init: Partial<StreamDeltaEvent> = {}) {
		super();
		Object.assign(this, init);
	}
}

/** End of a streaming segment. `mergeNext` marks a resumable provider boundary. */
export class StreamEndEvent extends OutboundEvent {
	readonly kind = "stream_end";
	content = "";
	streamId?: string;
	resuming = false;
	mergeNext = false;

	constructor(init: Partial<StreamEndEvent> = {}) {
		super();
		Object.assign(this, init);
	}
}

/** A complete reply that was already streamed; nothing new to render. */
export class StreamedResponseEvent extends OutboundEvent {
	readonly kind = "streamed_response";
}

/** Whole-turn completion (latency, goal state). */
export class TurnEndEvent extends OutboundEvent {
	readonly kind = "turn_end";
	latencyMs?: number;
	goalState?: Record<string, unknown>;

	constructor(init: Partial<TurnEndEvent> = {}) {
		super();
		Object.assign(this, init);
	}
}

/** Provider retry wait notice; dispatchers drop it for chat rendering. */
export class RetryWaitEvent extends OutboundEvent {
	readonly kind = "retry_wait";
	content = "";

	constructor(init: Partial<RetryWaitEvent> = {}) {
		super();
		Object.assign(this, init);
	}
}

/** Runtime session scope update (WebUI rendering). */
export class SessionUpdatedEvent extends OutboundEvent {
	readonly kind = "session_updated";
	scope?: string;

	constructor(init: Partial<SessionUpdatedEvent> = {}) {
		super();
		Object.assign(this, init);
	}
}

/** Runtime model change notification (WebUI rendering). */
export class RuntimeModelUpdatedEvent extends OutboundEvent {
	readonly kind = "runtime_model_updated";
	model?: string | null;
	modelPreset?: string | null;

	constructor(init: Partial<RuntimeModelUpdatedEvent> = {}) {
		super();
		Object.assign(this, init);
	}
}

/**
 * Return the typed outbound event carried by *msg*, if any. New code sets
 * `msg.event` directly; the fallback bridges legacy reserved metadata flags
 * (`_stream_delta`, `_progress`, `_reasoning*`, ...) used by older producers.
 */
export function outboundEventFromMessage(msg: OutboundMessage): OutboundEvent | undefined {
	if (msg.event !== undefined) return msg.event;
	return legacyEventFromMetadata(msg.metadata);
}

/** Build an OutboundMessage carrying a typed event. */
export function outboundMessageForEvent(options: {
	channel: string;
	chatId: string;
	event: OutboundEvent;
	content?: string;
	metadata?: Record<string, unknown>;
	messageId?: string;
	replyTo?: string;
}): OutboundMessage {
	const event = options.event;
	return {
		messageId: options.messageId,
		channel: options.channel,
		chatId: options.chatId,
		content: options.content ?? eventContent(event),
		event,
		metadata: { ...(options.metadata ?? {}) },
		replyTo: options.replyTo,
	};
}

/** Return *msg* with a new event and optional content. */
export function replaceOutboundEvent(
	msg: OutboundMessage,
	event: OutboundEvent,
	options: { content?: string } = {},
): OutboundMessage {
	return { ...msg, content: options.content ?? eventContent(event), event };
}

export function eventContent(event: OutboundEvent): string {
	if (event.kind === "progress") return (event as ProgressEvent).content;
	if (event.kind === "stream_delta") return (event as StreamDeltaEvent).content;
	if (event.kind === "stream_end") return (event as StreamEndEvent).content;
	if (event.kind === "retry_wait") return (event as RetryWaitEvent).content;
	return "";
}

/** Normalize a raw metadata payload into a typed event. */
export function eventFromPayload(payload: Record<string, unknown> | undefined): OutboundEvent | undefined {
	if (payload === undefined) return undefined;
	const kind = payload.kind;
	switch (kind) {
		case "progress":
			return new ProgressEvent(payload as Partial<ProgressEvent>);
		case "stream_delta":
			return new StreamDeltaEvent(payload as Partial<StreamDeltaEvent>);
		case "stream_end":
			return new StreamEndEvent(payload as Partial<StreamEndEvent>);
		case "streamed_response":
			return new StreamedResponseEvent();
		case "turn_end":
			return new TurnEndEvent(payload as Partial<TurnEndEvent>);
		case "retry_wait":
			return new RetryWaitEvent(payload as Partial<RetryWaitEvent>);
		case "session_updated":
			return new SessionUpdatedEvent(payload as Partial<SessionUpdatedEvent>);
		case "runtime_model_updated":
			return new RuntimeModelUpdatedEvent(payload as Partial<RuntimeModelUpdatedEvent>);
		default:
			return undefined;
	}
}

function legacyEventFromMetadata(meta: Record<string, unknown> | undefined): OutboundEvent | undefined {
	if (meta === undefined) return undefined;
	if (isTruthy(meta._runtime_model_updated)) {
		return new RuntimeModelUpdatedEvent({
			model: metaString(meta, "model"),
			modelPreset: metaString(meta, "model_preset"),
		});
	}
	if (isTruthy(meta._turn_end)) {
		return new TurnEndEvent({
			latencyMs: metaNumber(meta, "latency_ms"),
			goalState: isRecord(meta.goal_state) ? (meta.goal_state as Record<string, unknown>) : undefined,
		});
	}
	if (isTruthy(meta._session_updated)) {
		return new SessionUpdatedEvent({ scope: metaString(meta, "_session_update_scope") });
	}
	if (isTruthy(meta._retry_wait)) {
		return new RetryWaitEvent({ content: metaString(meta, "content") ?? "" });
	}
	if (isTruthy(meta._stream_end)) {
		return new StreamEndEvent({
			content: metaString(meta, "content") ?? "",
			streamId: metaString(meta, "_stream_id"),
			resuming: isTruthy(meta._resuming),
			mergeNext: isTruthy(meta._merge_next),
		});
	}
	if (isTruthy(meta._stream_delta)) {
		return new StreamDeltaEvent({
			content: metaString(meta, "content") ?? "",
			streamId: metaString(meta, "_stream_id"),
		});
	}
	if (isTruthy(meta._streamed)) {
		return new StreamedResponseEvent();
	}
	if (
		isTruthy(meta._progress) ||
		isTruthy(meta._reasoning_delta) ||
		isTruthy(meta._reasoning_end) ||
		isTruthy(meta._reasoning) ||
		isTruthy(meta._file_edit_events) ||
		isTruthy(meta._tool_events)
	) {
		const toolEvents = meta._tool_events;
		const fileEditEvents = meta._file_edit_events;
		return new ProgressEvent({
			content: metaString(meta, "content") ?? "",
			toolHint: isTruthy(meta._tool_hint),
			reasoning: isTruthy(meta._reasoning),
			reasoningDelta: isTruthy(meta._reasoning_delta),
			reasoningEnd: isTruthy(meta._reasoning_end),
			streamId: metaString(meta, "_stream_id"),
			toolEvents: Array.isArray(toolEvents) ? (toolEvents as Array<Record<string, unknown>>) : undefined,
			fileEditEvents: Array.isArray(fileEditEvents) ? (fileEditEvents as Array<Record<string, unknown>>) : undefined,
		});
	}
	return undefined;
}

function isTruthy(value: unknown): boolean {
	return value === true || value === 1 || value === "1" || value === "true";
}

function metaString(meta: Record<string, unknown>, key: string): string | undefined {
	const value = meta[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metaNumber(meta: Record<string, unknown>, key: string): number | undefined {
	const value = meta[key];
	if (typeof value === "boolean") return undefined;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
