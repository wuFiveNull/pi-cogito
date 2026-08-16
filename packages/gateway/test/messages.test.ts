import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createChannelSdk,
	type DeliveryReceipt,
	FileChannelMessageStore,
	type InboundMessage,
	MessageBus,
	type OutboundMessage,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function inbound(messageId: string): InboundMessage {
	return {
		messageId,
		channel: "telegram",
		senderId: "user",
		chatId: "chat",
		content: `inbound-${messageId}`,
		timestamp: Date.now(),
		sessionKey: "telegram:chat",
	};
}

function outbound(messageId: string): OutboundMessage {
	return {
		messageId,
		channel: "telegram",
		chatId: "chat",
		content: `outbound-${messageId}`,
	};
}

describe("canonical channel message store", () => {
	it("retains inbound history and lifecycle status across store instances", () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-messages-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "messages.json");
		const message = inbound("in-1");
		const first = new FileChannelMessageStore(path);

		first.recordInbound(message);
		first.markInboundProcessing(message, 1);
		first.markInboundCompleted(message);

		const second = new FileChannelMessageStore(path);
		expect(second.list({ direction: "inbound" })).toMatchObject([
			{
				direction: "inbound",
				status: "completed",
				message: { messageId: "in-1", content: "inbound-in-1" },
			},
		]);
	});

	it("retains outbound delivery receipts and supports filters", () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-messages-outbound-"));
		temporaryDirectories.push(directory);
		const store = new FileChannelMessageStore(join(directory, "messages.json"));
		const message = outbound("out-1");
		const receipt: DeliveryReceipt = {
			messageId: "out-1",
			channel: "telegram",
			chatId: "chat",
			status: "success",
			attempts: 2,
			acceptedAt: Date.now(),
			deliveredAt: Date.now(),
			providerMessageId: "provider-1",
		};

		store.recordOutbound(message);
		store.markOutboundAttempt(message, 2);
		store.recordDelivery(receipt);

		expect(store.list({ direction: "outbound", channel: "telegram" })).toMatchObject([
			{
				direction: "outbound",
				status: "success",
				attempts: 2,
				receipt: { providerMessageId: "provider-1" },
			},
		]);
		expect(store.list({ channel: "discord" })).toEqual([]);
	});

	it("updates canonical statuses through MessageBus", async () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-messages-bus-"));
		temporaryDirectories.push(directory);
		const store = new FileChannelMessageStore(join(directory, "messages.json"));
		const bus = new MessageBus({ messageStore: store });
		const message = inbound("bus-in-1");
		bus.onInbound(() => undefined, { consume: true });

		bus.publishInbound(message);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(store.list({ direction: "inbound" })[0]).toMatchObject({ status: "completed" });
		bus.publishOutbound(outbound("bus-out-1"));
		bus.publishDelivery({
			messageId: "bus-out-1",
			channel: "telegram",
			chatId: "chat",
			status: "failed",
			attempts: 1,
			acceptedAt: Date.now(),
			detail: "provider unavailable",
		});
		expect(store.list({ direction: "outbound" })[0]).toMatchObject({ status: "failed" });
		bus.close();
	});

	it("retains retry and dead-letter status for failed inbound messages", async () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-messages-dlq-"));
		temporaryDirectories.push(directory);
		const store = new FileChannelMessageStore(join(directory, "messages.json"));
		const bus = new MessageBus({ messageStore: store, inboundRetry: { maxAttempts: 1 } });
		bus.onInbound(
			async () => {
				throw new Error("agent unavailable");
			},
			{ consume: true },
		);
		const message = inbound("dead-letter-1");

		bus.publishInbound(message);
		await vi.waitFor(() => expect(store.list({ direction: "inbound" })[0]?.status).toBe("dead-letter"));
		expect(store.list({ direction: "inbound" })[0]).toMatchObject({
			attempts: 1,
			lastError: "agent unavailable",
		});
		bus.close();
	});

	it("wires canonical history through ChannelSdk and the Web API", async () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-messages-sdk-"));
		temporaryDirectories.push(directory);
		const sdk = createChannelSdk({
			config: { channels: { web: { enabled: true, allowFrom: ["*"] } }, web: { host: "127.0.0.1", port: 0 } },
			channels: ["web"],
			messageStatePath: join(directory, "messages.json"),
		});
		let replyCompleted: (() => void) | undefined;
		const reply = new Promise<void>((resolve) => {
			replyCompleted = resolve;
		});
		sdk.onMessage(async (message) => {
			await sdk.send({ channel: message.channel, chatId: message.chatId, content: "reply" });
			replyCompleted?.();
		});

		try {
			await sdk.start();
			const port = sdk.status()[0]?.port;
			const response = await fetch(`http://127.0.0.1:${port}/api/messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ senderId: "user", chatId: "chat", content: "hello" }),
			});
			expect(response.status).toBe(202);
			await reply;

			const messages = sdk.listMessages({ chatId: "chat", limit: 10 });
			expect(messages).toHaveLength(2);
			expect(messages.map((message) => message.direction)).toEqual(["inbound", "outbound"]);
			expect(messages[0]).toMatchObject({ status: "completed", message: { content: "hello" } });
			expect(messages[1]).toMatchObject({ status: "success", message: { content: "reply" } });

			const listed = await fetch(`http://127.0.0.1:${port}/api/messages?chatId=chat`);
			expect((await listed.json()) as { items: unknown[] }).toMatchObject({
				items: expect.arrayContaining(messages),
			});
			const history = await fetch(`http://127.0.0.1:${port}/api/history?chatId=chat`);
			expect(await history.json()).toMatchObject({
				items: expect.arrayContaining([
					expect.objectContaining({ role: "user", content: "hello" }),
					expect.objectContaining({ role: "assistant", content: "reply" }),
				]),
			});
		} finally {
			await sdk.stop();
		}
	});
});
