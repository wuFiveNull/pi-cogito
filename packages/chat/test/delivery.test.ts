import type { ChannelSdk, DeliveryReceipt, OutboundMessage } from "@cogito/gateway";
import { describe, expect, it, vi } from "vitest";
import { ChatDelivery } from "../src/delivery.ts";

function receipt(overrides: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
	return {
		messageId: `out_${Math.random().toString(36).slice(2)}`,
		channel: "web",
		chatId: "1",
		status: "success",
		attempts: 1,
		acceptedAt: Date.now(),
		...overrides,
	};
}

function fakeSdk(overrides: Partial<ChannelSdk> = {}): ChannelSdk {
	return {
		capabilities: () => ({
			streaming: true,
			receives: true,
			sends: true,
			reasoning: true,
			fileEdits: false,
			progress: false,
			buttons: false,
		}),
		send: vi.fn(async (message: OutboundMessage) => receipt({ channel: message.channel, chatId: message.chatId })),
		sendDelta: vi.fn(async () => {}),
		...overrides,
	} as unknown as ChannelSdk;
}

describe("ChatDelivery", () => {
	it("reports streaming capability per channel", () => {
		const capabilities = ((name?: string) =>
			name === "web"
				? {
						streaming: true,
						receives: true,
						sends: true,
						reasoning: false,
						fileEdits: false,
						progress: false,
						buttons: false,
					}
				: undefined) as unknown as ChannelSdk["capabilities"];
		const sdk = fakeSdk({ capabilities });
		const delivery = new ChatDelivery(sdk);
		expect(delivery.supportsStreaming("web")).toBe(true);
		expect(delivery.supportsStreaming("telegram")).toBe(false);
	});

	it("sends a complete message with optional fields", async () => {
		const send = vi.fn(async (message: OutboundMessage) =>
			receipt({ channel: message.channel, chatId: message.chatId }),
		);
		const delivery = new ChatDelivery(fakeSdk({ send }));
		await delivery.send({
			channel: "telegram",
			chatId: "1",
			content: "hi",
			replyTo: "m1",
			media: ["/tmp/a.png"],
			thinking: "think",
		});
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				channel: "telegram",
				chatId: "1",
				content: "hi",
				replyTo: "m1",
				media: ["/tmp/a.png"],
				thinking: "think",
			}),
		);
	});

	it("omits empty media arrays", async () => {
		const send = vi.fn(async (message: OutboundMessage) =>
			receipt({ channel: message.channel, chatId: message.chatId }),
		);
		const delivery = new ChatDelivery(fakeSdk({ send }));
		await delivery.send({ channel: "web", chatId: "1", content: "hi" });
		const outbound = (send.mock.calls[0] ?? [])[0] as unknown as Record<string, unknown> | undefined;
		expect(outbound?.media).toBeUndefined();
	});

	it("forwards deltas with stream metadata", async () => {
		const sendDelta = vi.fn(async () => {});
		const delivery = new ChatDelivery(fakeSdk({ sendDelta }));
		await delivery.sendDelta({ channel: "web", chatId: "1", delta: "hello", type: "text", streamId: "s1" });
		expect(sendDelta).toHaveBeenCalledWith(
			expect.objectContaining({ channel: "web", chatId: "1", delta: "hello", type: "text", streamId: "s1" }),
		);
	});

	it("swallows sendDelta errors", async () => {
		const sendDelta = vi.fn(async () => {
			throw new Error("channel gone");
		});
		const delivery = new ChatDelivery(fakeSdk({ sendDelta }));
		await expect(delivery.sendDelta({ channel: "web", chatId: "1", delta: "x" })).resolves.toBeUndefined();
	});
});
