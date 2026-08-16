import { describe, expect, it } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { BaseChannel, type ChannelConfig, type GroupPolicy } from "../src/channels/base.ts";
import { ChannelContextScope } from "../src/channels/context.ts";
import { OutboundDispatcher } from "../src/channels/dispatcher.ts";
import { RuntimeModelUpdatedEvent } from "../src/events.ts";
import { InMemoryPairingStore } from "../src/pairing.ts";
import type { InboundMessage, OutboundDelta, OutboundMessage } from "../src/types.ts";

class TestChannel extends BaseChannel {
	name = "test";
	displayName = "Test";
	sent: OutboundMessage[] = [];
	streaming = false;
	failCount = 0;
	constructor(config: ChannelConfig = {}, bus = new MessageBus()) {
		super(config, bus);
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	async send(message: OutboundMessage): Promise<void> {
		if (this.failCount > 0) {
			this.failCount--;
			throw new Error("boom");
		}
		this.sent.push(message);
	}

	async sendDelta(_delta: OutboundDelta): Promise<void> {}

	override get supportsStreaming(): boolean {
		return this.streaming;
	}
}

function setup(config: Record<string, unknown> = {}, stream = false) {
	const bus = new MessageBus();
	const store = new InMemoryPairingStore();
	const channel = new TestChannel(config, bus);
	channel.streaming = stream;
	channel.bindContext(new ChannelContextScope(bus, { pairingStore: store }));
	return { bus, store, channel };
}

describe("W2-M0 inbound contract", () => {
	it("checks authorizationId when it differs from senderId", async () => {
		const { channel } = setup({ allowFrom: ["group:g1"] });
		// Sender is not allowed, but the group authorization entity is.
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const result = await channel["handleMessage"]({
			senderId: "u1",
			chatId: "g1",
			content: "hi",
			authorizationId: "group:g1",
		});
		expect(result.status).toBe("accepted");
	});

	it("rejects when the authorization entity is not allowed", async () => {
		const { channel } = setup({ allowFrom: ["u1"] });
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const result = await channel["handleMessage"]({
			senderId: "u1",
			chatId: "g1",
			content: "hi",
			authorizationId: "group:other",
		});
		expect(result.status).toBe("filtered");
	});

	it("records isDm and authorizationId on the inbound message", async () => {
		const { bus, channel } = setup({}, true);
		const seen: InboundMessage[] = [];
		bus.onInbound((message) => void seen.push(message), { consume: true });
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		await channel["handleMessage"]({
			senderId: "u1",
			chatId: "c1",
			content: "hi",
			isDm: true,
			authorizationId: "group:g1",
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]!.isDm).toBe(true);
		expect(seen[0]!.authorizationId).toBe("group:g1");
	});

	it("sets _wants_stream when the channel streams", async () => {
		const { bus, channel } = setup({ streaming: true }, true);
		const seen: InboundMessage[] = [];
		bus.onInbound((message) => void seen.push(message), { consume: true });
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		await channel["handleMessage"]({ senderId: "u1", chatId: "c1", content: "hi" });
		expect(seen[0]!.metadata).toMatchObject({ _wants_stream: true });
	});

	it("keeps metadata empty (not undefined) for non-streaming channels", async () => {
		const { bus, channel } = setup({});
		const seen: InboundMessage[] = [];
		bus.onInbound((message) => void seen.push(message), { consume: true });
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		await channel["handleMessage"]({ senderId: "u1", chatId: "c1", content: "hi" });
		expect(seen[0]!.metadata).toEqual({});
	});
});

describe("W2-M0 group policy modes", () => {
	function groupChannel(policy: GroupPolicy, config: Record<string, unknown> = {}) {
		const { channel } = setup({ ...config, group: policy });
		return channel;
	}

	it("open mode accepts every group sender", async () => {
		const channel = groupChannel({ mode: "open" });
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const result = await channel["handleMessage"]({
			senderId: "uX",
			chatId: "group:g1",
			content: "hi",
			metadata: { chatType: "group" },
		});
		expect(result.status).toBe("accepted");
	});

	it("mention mode requires mentionedBot", async () => {
		const channel = groupChannel({ mode: "mention" });
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const unmentioned = await channel["handleMessage"]({
			senderId: "u1",
			chatId: "group:g1",
			content: "hi",
			metadata: { chatType: "group" },
		});
		expect(unmentioned.status).toBe("filtered");
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const mentioned = await channel["handleMessage"]({
			senderId: "u1",
			chatId: "group:g1",
			content: "hi",
			metadata: { chatType: "group", mentionedBot: true },
		});
		expect(mentioned.status).toBe("accepted");
	});

	it("allowlist mode checks allowFrom against the authorization entity", async () => {
		const channel = groupChannel({ mode: "allowlist", allowFrom: ["group:g1"] });
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const allowed = await channel["handleMessage"]({
			senderId: "u1",
			chatId: "g1",
			content: "hi",
			metadata: { chatType: "group" },
			authorizationId: "group:g1",
		});
		expect(allowed.status).toBe("accepted");
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const denied = await channel["handleMessage"]({
			senderId: "u1",
			chatId: "g1",
			content: "hi",
			metadata: { chatType: "group" },
		});
		expect(denied.status).toBe("filtered");
	});

	it("keeps the legacy allowFrom/requireAt flags working", async () => {
		const legacy = groupChannel({ allowFrom: ["u1"], requireAt: true });
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const noMention = await legacy["handleMessage"]({
			senderId: "u1",
			chatId: "group:g1",
			content: "hi",
			metadata: { chatType: "group" },
		});
		expect(noMention.status).toBe("filtered");
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const ok = await legacy["handleMessage"]({
			senderId: "u1",
			chatId: "group:g1",
			content: "hi",
			metadata: { chatType: "group", mentionedBot: true },
		});
		expect(ok.status).toBe("accepted");
	});
});

describe("W2-M0 pairing and isDm", () => {
	it("sends a pairing code when isDm is explicit", async () => {
		const { channel } = setup({ pairing: true });
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const result = await channel["handleMessage"]({
			senderId: "u9",
			chatId: "c9",
			content: "hi",
			isDm: true,
		});
		expect(result.status).toBe("filtered");
		expect(channel.sent).toHaveLength(1);
	});

	it("stays silent for explicit non-DM messages", async () => {
		const { channel } = setup({ pairing: true });
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const result = await channel["handleMessage"]({
			senderId: "u9",
			chatId: "c9",
			content: "hi",
			isDm: false,
		});
		expect(result.status).toBe("filtered");
		expect(channel.sent).toHaveLength(0);
	});
});

describe("W2-M0 base helpers", () => {
	it("login defaults to true and defaultConfig scaffolds a disabled section", async () => {
		const { channel } = setup({});
		expect(await channel.login()).toBe(true);
		expect(await channel.login(true)).toBe(true);
		expect(TestChannel.defaultConfig()).toEqual({ enabled: false });
	});

	it("transcribeAudio proxies the context transcriber", async () => {
		const { bus, channel } = setup({});
		channel.bindContext(
			new ChannelContextScope(bus, {
				transcriber: async (data, mimeType) => `${mimeType}:${data.byteLength}`,
			}),
		);
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const text = await channel["transcribeAudio"](new Uint8Array([1, 2, 3]), "audio/ogg");
		expect(text).toBe("audio/ogg:3");
	});

	it("transcribeAudio returns empty string without a transcriber", async () => {
		const { channel } = setup({});
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const text = await channel["transcribeAudio"](new Uint8Array([1]), "audio/ogg");
		expect(text).toBe("");
	});
});

describe("W2-M0 dispatcher extensions", () => {
	it("sendDirect retries until the deadline beyond maxAttempts", async () => {
		const bus = new MessageBus();
		const channel = new TestChannel({}, bus);
		channel.failCount = 3; // Fail three times, then succeed.
		const dispatcher = new OutboundDispatcher(
			bus,
			{ get: (name: string) => (name === "test" ? channel : undefined) },
			{ maxAttempts: 2, baseDelayMs: 2, maxDelayMs: 5 },
		);
		dispatcher.start();
		const receipts: Array<{ status: string }> = [];
		bus.onDelivery((receipt) => void receipts.push(receipt));
		await dispatcher.sendDirect(
			channel,
			{ channel: "test", chatId: "c1", content: "hi" },
			{
				retryUntilMs: Date.now() + 500,
			},
		);
		expect(channel.sent).toHaveLength(1);
		expect(receipts.at(-1)?.status).toBe("success");
		dispatcher.stop();
	});

	it("drops RuntimeModelUpdatedEvent for a disabled websocket channel", async () => {
		const bus = new MessageBus();
		const dispatcher = new OutboundDispatcher(bus, { get: () => undefined });
		dispatcher.start();
		const receipts: Array<{ status: string }> = [];
		bus.onDelivery((receipt) => void receipts.push(receipt));
		bus.publishOutbound({
			channel: "websocket",
			chatId: "c1",
			content: "",
			event: new RuntimeModelUpdatedEvent({ model: "m1" }),
		});
		// Give the dispatcher a moment to drain.
		await new Promise((resolve) => setTimeout(resolve, 20));
		dispatcher.stop();
		expect(receipts).toHaveLength(0);
	});

	it("still reports a failed receipt for other channels that are not enabled", async () => {
		const bus = new MessageBus();
		const dispatcher = new OutboundDispatcher(bus, { get: () => undefined });
		dispatcher.start();
		const receipts: Array<{ status: string }> = [];
		bus.onDelivery((receipt) => void receipts.push(receipt));
		bus.publishOutbound({ channel: "missing", chatId: "c1", content: "hi" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		dispatcher.stop();
		expect(receipts).toHaveLength(1);
		expect(receipts[0]!.status).toBe("failed");
	});
});
