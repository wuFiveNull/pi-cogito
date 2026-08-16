import { describe, expect, it } from "vitest";
import {
	eventContent,
	eventFromPayload,
	outboundEventFromMessage,
	outboundMessageForEvent,
	ProgressEvent,
	RuntimeModelUpdatedEvent,
	replaceOutboundEvent,
	StreamDeltaEvent,
	StreamEndEvent,
	StreamedResponseEvent,
	TurnEndEvent,
} from "../src/events.ts";

describe("typed outbound events", () => {
	it("builds event-carrying outbound messages", () => {
		const msg = outboundMessageForEvent({
			channel: "telegram",
			chatId: "42",
			event: new ProgressEvent({ content: "thinking…", reasoningDelta: true }),
			metadata: { messageId: "99" },
		});
		expect(msg.channel).toBe("telegram");
		expect(msg.chatId).toBe("42");
		expect(msg.content).toBe("thinking…");
		expect(msg.metadata).toEqual({ messageId: "99" });
		expect(outboundEventFromMessage(msg)).toBeInstanceOf(ProgressEvent);
	});

	it("extracts event content for content-carrying events", () => {
		expect(eventContent(new StreamDeltaEvent({ content: "abc" }))).toBe("abc");
		expect(eventContent(new StreamEndEvent({ content: "def" }))).toBe("def");
		expect(eventContent(new ProgressEvent({ content: "ghi" }))).toBe("ghi");
		expect(eventContent(new StreamedResponseEvent())).toBe("");
		expect(eventContent(new TurnEndEvent({ latencyMs: 5 }))).toBe("");
	});

	it("replaces the event while keeping routing fields", () => {
		const msg = outboundMessageForEvent({
			channel: "web",
			chatId: "c1",
			event: new StreamDeltaEvent({ content: "old" }),
		});
		const next = replaceOutboundEvent(msg, new StreamEndEvent({ content: "new", streamId: "s1" }));
		expect(next.event).toBeInstanceOf(StreamEndEvent);
		expect(next.content).toBe("new");
		expect(next.channel).toBe("web");
		expect(next.chatId).toBe("c1");
	});

	it("reads legacy reserved metadata flags", () => {
		expect(outboundEventFromMessage({ channel: "x", chatId: "y", content: "" })?.kind).toBeUndefined();
		expect(
			outboundEventFromMessage({
				channel: "x",
				chatId: "y",
				content: "delta",
				metadata: { _stream_delta: true, _stream_id: "s9" },
			})?.kind,
		).toBe("stream_delta");
		expect(
			outboundEventFromMessage({
				channel: "x",
				chatId: "y",
				content: "",
				metadata: { _stream_end: true, _merge_next: true },
			})?.kind,
		).toBe("stream_end");
		expect(
			outboundEventFromMessage({
				channel: "x",
				chatId: "y",
				content: "",
				metadata: { _progress: true, _tool_hint: true },
			})?.kind,
		).toBe("progress");
		expect(
			outboundEventFromMessage({
				channel: "x",
				chatId: "y",
				content: "",
				metadata: { _runtime_model_updated: true, model: "gpt-4o" },
			})?.kind,
		).toBe("runtime_model_updated");
	});

	it("round-trips events through JSON payloads", () => {
		const event = new ProgressEvent({ content: "p", toolHint: true, streamId: "s1" });
		const restored = eventFromPayload(JSON.parse(JSON.stringify(event)));
		expect(restored).toBeInstanceOf(ProgressEvent);
		expect(restored?.kind).toBe("progress");
		if (restored instanceof ProgressEvent) {
			expect(restored.content).toBe("p");
			expect(restored.toolHint).toBe(true);
			expect(restored.streamId).toBe("s1");
		}
		expect(eventFromPayload({ kind: "unknown-thing" })).toBeUndefined();
		expect(eventFromPayload(undefined)).toBeUndefined();
		expect(
			eventFromPayload({ kind: "runtime_model_updated", model: "deepseek" }) instanceof RuntimeModelUpdatedEvent,
		).toBe(true);
	});

	it("stream end carries resuming/mergeNext semantics", () => {
		const end = new StreamEndEvent({ content: "final", streamId: "s1", resuming: true, mergeNext: false });
		expect(end.resuming).toBe(true);
		expect(end.mergeNext).toBe(false);
	});
});
