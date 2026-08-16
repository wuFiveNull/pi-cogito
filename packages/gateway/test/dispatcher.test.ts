import { describe, expect, it } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { BaseChannel, type ChannelConfig } from "../src/channels/base.ts";
import { OutboundDispatcher } from "../src/channels/dispatcher.ts";
import {
	ProgressEvent,
	RetryWaitEvent,
	StreamDeltaEvent,
	StreamEndEvent,
	StreamedResponseEvent,
} from "../src/events.ts";
import type { ChannelSendResult, OutboundDelta, OutboundMessage } from "../src/types.ts";

class RecordingChannel extends BaseChannel {
	name = "rec";
	displayName = "Recording";
	sent: Array<OutboundMessage> = [];
	deltas: Array<OutboundDelta> = [];
	progress: Array<OutboundMessage> = [];
	reasoningDeltas: Array<{ chatId: string; delta: string; streamId?: string }> = [];
	reasoningEnds: Array<{ chatId: string; streamId?: string }> = [];
	fileEdits: Array<{ chatId: string; edits: Array<Record<string, unknown>> }> = [];
	failSend = false;

	constructor(config: ChannelConfig = {}, bus: MessageBus = new MessageBus()) {
		super(config, bus);
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	// biome-ignore lint/suspicious/noConfusingVoidType: matches the BaseChannel contract
	async send(message: OutboundMessage): Promise<void | ChannelSendResult> {
		if (this.failSend) throw new Error("boom");
		this.sent.push(message);
	}

	async sendDelta(delta: OutboundDelta): Promise<void> {
		this.deltas.push(delta);
	}

	async sendProgress(message: OutboundMessage): Promise<void> {
		this.progress.push(message);
	}

	async sendReasoningDelta(
		chatId: string,
		delta: string,
		_metadata?: Record<string, unknown>,
		streamId?: string,
	): Promise<void> {
		this.reasoningDeltas.push({ chatId, delta, streamId });
	}

	async sendReasoningEnd(chatId: string, _metadata?: Record<string, unknown>, streamId?: string): Promise<void> {
		this.reasoningEnds.push({ chatId, streamId });
	}

	async sendFileEditEvents(chatId: string, edits: Array<Record<string, unknown>>): Promise<void> {
		this.fileEdits.push({ chatId, edits });
	}

	override get supportsStreaming(): boolean {
		return true;
	}
}

function setup(config: Record<string, unknown> = {}) {
	const bus = new MessageBus();
	const channel = new RecordingChannel(config);
	const dispatcher = new OutboundDispatcher(
		bus,
		{ get: (name: string) => (name === "rec" ? channel : undefined) },
		{ baseDelayMs: 5, maxDelayMs: 10 },
	);
	return { bus, channel, dispatcher };
}

function outbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
	return { channel: "rec", chatId: "c1", content: "hello", ...overrides };
}

describe("OutboundDispatcher typed event routing", () => {
	it("routes plain messages to channel.send", async () => {
		const { bus, channel, dispatcher } = setup();
		dispatcher.start();
		bus.publishOutbound(outbound());
		await waitFor(() => channel.sent.length === 1);
		dispatcher.stop();
		expect(channel.sent[0]?.content).toBe("hello");
	});

	it("routes progress events to sendProgress", async () => {
		const { bus, channel, dispatcher } = setup();
		dispatcher.start();
		bus.publishOutbound(outbound({ content: "working…", event: new ProgressEvent({ content: "working…" }) }));
		await waitFor(() => channel.progress.length === 1);
		dispatcher.stop();
		expect(channel.progress[0]?.content).toBe("working…");
		expect(channel.sent).toHaveLength(0);
	});

	it("gates progress by sendProgress config", async () => {
		const { bus, channel, dispatcher } = setup({ sendProgress: false });
		dispatcher.start();
		bus.publishOutbound(outbound({ content: "working…", event: new ProgressEvent({ content: "working…" }) }));
		await sleep(30);
		dispatcher.stop();
		expect(channel.progress).toHaveLength(0);
	});

	it("gates tool hints by sendToolHints config", async () => {
		const { bus, channel, dispatcher } = setup({ sendToolHints: false });
		dispatcher.start();
		bus.publishOutbound(
			outbound({ content: "using search", event: new ProgressEvent({ content: "using search", toolHint: true }) }),
		);
		await sleep(30);
		dispatcher.stop();
		expect(channel.progress).toHaveLength(0);
	});

	it("routes reasoning deltas/ends to the reasoning primitives", async () => {
		const { bus, channel, dispatcher } = setup();
		dispatcher.start();
		bus.publishOutbound(
			outbound({
				content: "let me think",
				event: new ProgressEvent({ content: "let me think", reasoningDelta: true, streamId: "s1" }),
			}),
		);
		bus.publishOutbound(outbound({ event: new ProgressEvent({ reasoningEnd: true, streamId: "s1" }) }));
		await waitFor(() => channel.reasoningEnds.length === 1);
		dispatcher.stop();
		expect(channel.reasoningDeltas).toEqual([{ chatId: "c1", delta: "let me think", streamId: "s1" }]);
		expect(channel.reasoningEnds).toEqual([{ chatId: "c1", streamId: "s1" }]);
	});

	it("drops reasoning when showReasoning is disabled", async () => {
		const { bus, channel, dispatcher } = setup({ showReasoning: false });
		dispatcher.start();
		bus.publishOutbound(
			outbound({ content: "thinking", event: new ProgressEvent({ content: "thinking", reasoningDelta: true }) }),
		);
		await sleep(30);
		dispatcher.stop();
		expect(channel.reasoningDeltas).toHaveLength(0);
	});

	it("routes one-shot reasoning through sendReasoning (delta + end)", async () => {
		const { bus, channel, dispatcher } = setup();
		dispatcher.start();
		bus.publishOutbound(
			outbound({
				content: "full reasoning",
				event: new ProgressEvent({ content: "full reasoning", reasoning: true }),
			}),
		);
		await waitFor(() => channel.reasoningDeltas.length === 1);
		dispatcher.stop();
		expect(channel.reasoningDeltas[0]?.delta).toBe("full reasoning");
		expect(channel.reasoningEnds).toHaveLength(1);
	});

	it("routes file-edit events to sendFileEditEvents", async () => {
		const { bus, channel, dispatcher } = setup();
		dispatcher.start();
		bus.publishOutbound(outbound({ event: new ProgressEvent({ fileEditEvents: [{ path: "a.ts", op: "write" }] }) }));
		await waitFor(() => channel.fileEdits.length === 1);
		dispatcher.stop();
		expect(channel.fileEdits[0]?.edits).toEqual([{ path: "a.ts", op: "write" }]);
	});

	it("drops RetryWaitEvent and StreamedResponseEvent without sending", async () => {
		const { bus, channel, dispatcher } = setup();
		dispatcher.start();
		bus.publishOutbound(outbound({ event: new RetryWaitEvent({ content: "retrying" }) }));
		bus.publishOutbound(outbound({ event: new StreamedResponseEvent() }));
		await sleep(30);
		dispatcher.stop();
		expect(channel.sent).toHaveLength(0);
		expect(channel.progress).toHaveLength(0);
	});

	it("suppresses duplicate content for the same origin message", async () => {
		const { bus, channel, dispatcher } = setup();
		dispatcher.start();
		const metadata = { originMessageId: "m1" };
		bus.publishOutbound(outbound({ metadata }));
		bus.publishOutbound(outbound({ metadata }));
		await waitFor(() => channel.sent.length === 1);
		await sleep(30);
		dispatcher.stop();
		expect(channel.sent).toHaveLength(1);
	});

	it("delivers distinct content for the same origin message", async () => {
		const { bus, channel, dispatcher } = setup();
		dispatcher.start();
		bus.publishOutbound(outbound({ content: "first", metadata: { originMessageId: "m1" } }));
		bus.publishOutbound(outbound({ content: "second", metadata: { originMessageId: "m1" } }));
		await waitFor(() => channel.sent.length === 2);
		dispatcher.stop();
		expect(channel.sent.map((m) => m.content)).toEqual(["first", "second"]);
	});
});

describe("OutboundDispatcher stream delta coalescing", () => {
	it("coalesces consecutive deltas for the same stream into one sendDelta", async () => {
		const { bus, channel, dispatcher } = setup();
		dispatcher.start();
		bus.publishDelta({ channel: "rec", chatId: "c1", delta: "ab", streamId: "s1" });
		bus.publishDelta({ channel: "rec", chatId: "c1", delta: "cd", streamId: "s1" });
		bus.publishDelta({
			channel: "rec",
			chatId: "c1",
			delta: "ef",
			streamId: "s1",
			streamEnd: true,
			event: new StreamEndEvent({ streamId: "s1" }),
		});
		await waitFor(() => channel.deltas.length === 1);
		dispatcher.stop();
		expect(channel.deltas).toHaveLength(1);
		const merged = channel.deltas[0]!;
		expect(merged.delta).toBe("abcdef");
		expect(merged.streamEnd).toBe(true);
		expect(merged.event?.kind).toBe("stream_end");
	});

	it("does not merge deltas from different streams", async () => {
		const { bus, channel, dispatcher } = setup();
		dispatcher.start();
		bus.publishDelta({ channel: "rec", chatId: "c1", delta: "aa", streamId: "s1" });
		bus.publishDelta({ channel: "rec", chatId: "c1", delta: "bb", streamId: "s2" });
		await waitFor(() => channel.deltas.length === 2);
		dispatcher.stop();
		expect(channel.deltas.map((d) => d.delta)).toEqual(["aa", "bb"]);
	});

	it("coalesces eventized stream deltas", async () => {
		const { bus, channel, dispatcher } = setup();
		dispatcher.start();
		bus.publishDelta({
			channel: "rec",
			chatId: "c1",
			delta: "x",
			streamId: "s1",
			event: new StreamDeltaEvent({ content: "x", streamId: "s1" }),
		});
		bus.publishDelta({
			channel: "rec",
			chatId: "c1",
			delta: "y",
			streamId: "s1",
			event: new StreamDeltaEvent({ content: "y", streamId: "s1" }),
		});
		await waitFor(() => channel.deltas.length === 1);
		dispatcher.stop();
		expect(channel.deltas[0]?.delta).toBe("xy");
		expect(channel.deltas[0]?.event?.kind).toBe("stream_delta");
	});
});

function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = (): void => {
			if (condition()) {
				resolve();
				return;
			}
			if (Date.now() - started > timeoutMs) {
				reject(new Error("waitFor timeout"));
				return;
			}
			setTimeout(tick, 5);
		};
		tick();
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
