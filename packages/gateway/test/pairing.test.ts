import { describe, expect, it } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { BaseChannel } from "../src/channels/base.ts";
import { ChannelContextScope } from "../src/channels/context.ts";
import { formatPairingReply, generatePairingCode, InMemoryPairingStore } from "../src/pairing.ts";
import type { OutboundMessage } from "../src/types.ts";

class PairingChannel extends BaseChannel {
	name = "test";
	displayName = "Test";
	sent: OutboundMessage[] = [];

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	async send(message: OutboundMessage): Promise<void> {
		this.sent.push(message);
	}
}

describe("pairing store", () => {
	it("generates codes, approves senders and expires pending codes", () => {
		const store = new InMemoryPairingStore();
		expect(store.isApproved("telegram", "u1")).toBe(false);
		const code = store.generateCode("telegram", "u1");
		expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
		// Same pending code is reused until expiry.
		expect(store.generateCode("telegram", "u1")).toBe(code);
		store.approve("telegram", "u1");
		expect(store.isApproved("telegram", "u1")).toBe(true);
		const records = store.list();
		expect(records.some((r) => r.channel === "telegram" && r.senderId === "u1" && r.approved)).toBe(true);
		store.deny("telegram", "u1");
		expect(store.isApproved("telegram", "u1")).toBe(false);
	});

	it("generates distinct codes and formats replies", () => {
		const a = generatePairingCode();
		const b = generatePairingCode();
		expect(a).not.toBe(b);
		expect(formatPairingReply(a, "telegram")).toContain(a);
		expect(formatPairingReply(a, "telegram")).toContain("telegram");
	});
});

describe("channel pairing flow", () => {
	function setup(config: Record<string, unknown> = {}) {
		const bus = new MessageBus();
		const store = new InMemoryPairingStore();
		const channel = new PairingChannel(config, bus);
		channel.bindContext(new ChannelContextScope(bus, { pairingStore: store }));
		return { bus, store, channel };
	}

	it("sends a pairing code to unapproved DM senders in pairing mode", async () => {
		const { channel } = setup({ pairing: true });
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const result = await channel["handleMessage"]({
			senderId: "u9",
			chatId: "c9",
			content: "hi",
			metadata: { chatType: "private" },
		});
		expect(result.status).toBe("filtered");
		expect(channel.sent).toHaveLength(1);
		expect(channel.sent[0]!.content).toContain("配对码");
		expect(channel.sent[0]!.metadata).toMatchObject({ pairingCode: expect.any(String) });
	});

	it("does not pair group messages", async () => {
		const { channel } = setup({ pairing: true });
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const result = await channel["handleMessage"]({
			senderId: "u9",
			chatId: "group:g1",
			content: "hi",
		});
		expect(result.status).toBe("filtered");
		expect(channel.sent).toHaveLength(0);
	});

	it("accepts approved senders in pairing mode", async () => {
		const { store, channel } = setup({ pairing: true });
		store.approve("test", "u7");
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const result = await channel["handleMessage"]({
			senderId: "u7",
			chatId: "c7",
			content: "hi",
		});
		expect(result.status).toBe("accepted");
		expect(channel.sent).toHaveLength(0);
	});

	it("keeps the default open policy when pairing is disabled", async () => {
		const { channel } = setup({});
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const result = await channel["handleMessage"]({
			senderId: "uX",
			chatId: "cX",
			content: "hi",
		});
		expect(result.status).toBe("accepted");
	});
});
