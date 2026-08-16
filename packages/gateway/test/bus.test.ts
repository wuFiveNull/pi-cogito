import { describe, expect, it } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { buildSessionKey, type InboundMessage, type OutboundMessage } from "../src/types.ts";

describe("MessageBus", () => {
	it("delivers inbound messages to waiting consumers", async () => {
		const bus = new MessageBus();
		const consumer = bus.consumeInbound();
		const message: InboundMessage = {
			messageId: "m1",
			channel: "web",
			senderId: "u1",
			chatId: "c1",
			content: "hello",
			timestamp: Date.now(),
			sessionKey: buildSessionKey("web", "c1"),
		};
		bus.publishInbound(message);
		await expect(consumer).resolves.toBe(message);
	});

	it("queues messages when no consumer is waiting", () => {
		const bus = new MessageBus();
		const message: InboundMessage = {
			messageId: "m2",
			channel: "web",
			senderId: "u1",
			chatId: "c1",
			content: "hi",
			timestamp: Date.now(),
			sessionKey: buildSessionKey("web", "c1"),
		};
		bus.publishInbound(message);
		expect(bus.inboundSize).toBe(1);
	});

	it("notifies inbound subscribers without removing the queue message", async () => {
		const bus = new MessageBus();
		const received = new Promise<InboundMessage>((resolve) => {
			bus.onInbound(resolve);
		});
		const message: InboundMessage = {
			messageId: "m3",
			channel: "web",
			senderId: "u1",
			chatId: "c1",
			content: "hi",
			timestamp: Date.now(),
			sessionKey: buildSessionKey("web", "c1"),
		};

		bus.publishInbound(message);

		await expect(received).resolves.toBe(message);
		expect(await bus.consumeInbound()).toBe(message);
	});

	it("delivers outbound messages and streaming deltas", async () => {
		const bus = new MessageBus();
		const outbound: OutboundMessage = { channel: "web", chatId: "c1", content: "reply" };
		const consumer = bus.consumeOutbound();
		bus.publishOutbound(outbound);
		await expect(consumer).resolves.toBe(outbound);

		const deltaConsumer = bus.consumeDelta();
		bus.publishDelta({ channel: "web", chatId: "c1", delta: "chunk" });
		await expect(deltaConsumer).resolves.toMatchObject({ delta: "chunk" });
	});
});

describe("buildSessionKey", () => {
	it("joins channel and chat id", () => {
		expect(buildSessionKey("web", "c1")).toBe("web:c1");
	});
});
