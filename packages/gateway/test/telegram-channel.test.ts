import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAgent } from "../src/agent.ts";
import { MessageBus } from "../src/bus.ts";
import { OutboundDispatcher } from "../src/channels/dispatcher.ts";
import { type HttpGet, type HttpPost, type HttpResult, TelegramChannel } from "../src/channels/telegram.ts";

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of running.splice(0)) await cleanup();
});

function jsonResult(status: number, data: unknown): HttpResult {
	return { ok: status < 400, status, json: async () => data };
}

function asGet(mock: ReturnType<typeof vi.fn>): HttpGet {
	return mock as unknown as HttpGet;
}

function asPost(mock: ReturnType<typeof vi.fn>): HttpPost {
	return mock as unknown as HttpPost;
}

async function startTelegram(get: ReturnType<typeof vi.fn>, post: ReturnType<typeof vi.fn>) {
	const bus = new MessageBus();
	const channel = new TelegramChannel({ token: "test-token", allowFrom: ["42"], pollIntervalMs: 20 }, bus, {
		get: asGet(get),
		post: asPost(post),
	});
	await channel.start();
	const dispatcher = new OutboundDispatcher(bus, {
		get: (name: string) => (name === "telegram" ? channel : undefined),
	});
	dispatcher.start();
	running.push(async () => {
		dispatcher.stop();
		await channel.stop();
	});
	return { bus, channel };
}

describe("TelegramChannel", () => {
	it("polls updates, normalizes them and delivers agent replies", async () => {
		const get = vi.fn();
		const post = vi.fn().mockResolvedValue(jsonResult(200, { ok: true }));
		// First poll: one text message from allowed user 42.
		get.mockResolvedValue(
			jsonResult(200, {
				ok: true,
				result: [
					{
						update_id: 1,
						message: {
							message_id: 100,
							from: { id: 42, first_name: "Alice" },
							chat: { id: -100123, type: "group" },
							text: "你好 telegram",
						},
					},
				],
			}),
		);

		const { bus } = await startTelegram(get, post);
		const agent = new FakeAgent(bus);
		agent.start();

		// Wait for the reply to be sent via sendMessage.
		await vi.waitFor(
			() => {
				expect(post.mock.calls.some(([url]) => String(url).includes("/sendMessage"))).toBe(true);
			},
			{ timeout: 3000, interval: 20 },
		);

		const sendCall = post.mock.calls.find(([url]) => String(url).includes("/sendMessage"))!;
		expect(String(sendCall[0])).toContain("/sendMessage");
		expect(sendCall[1]).toMatchObject({
			chat_id: -100123,
			text: "[telegram] 收到: 你好 telegram",
			reply_to_message_id: 100,
		});
		agent.stop();
	});

	it("drops messages from unauthorized senders", async () => {
		const get = vi.fn();
		const post = vi.fn();
		get.mockResolvedValue(
			jsonResult(200, {
				ok: true,
				result: [
					{
						update_id: 2,
						message: {
							message_id: 101,
							from: { id: 999 },
							chat: { id: 123 },
							text: "入侵",
						},
					},
				],
			}),
		);

		const { bus } = await startTelegram(get, post);
		const agent = new FakeAgent(bus);
		agent.start();

		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(post).not.toHaveBeenCalled();
		agent.stop();
	});

	it("does not reply when replyToMessage is disabled", async () => {
		const get = vi.fn();
		const post = vi.fn().mockResolvedValue(jsonResult(200, { ok: true }));
		get.mockResolvedValue(
			jsonResult(200, {
				ok: true,
				result: [
					{
						update_id: 3,
						message: {
							message_id: 102,
							from: { id: 42 },
							chat: { id: 123 },
							text: "不回复原消息",
						},
					},
				],
			}),
		);

		const bus = new MessageBus();
		const channel = new TelegramChannel(
			{ token: "t", allowFrom: ["42"], pollIntervalMs: 20, replyToMessage: false },
			bus,
			{ get: asGet(get), post: asPost(post) },
		);
		await channel.start();
		const dispatcher = new OutboundDispatcher(bus, {
			get: (name: string) => (name === "telegram" ? channel : undefined),
		});
		dispatcher.start();
		running.push(async () => {
			dispatcher.stop();
			await channel.stop();
		});
		const agent = new FakeAgent(bus);
		agent.start();

		await vi.waitFor(
			() => {
				expect(post.mock.calls.some(([url]) => String(url).includes("/sendMessage"))).toBe(true);
			},
			{ timeout: 3000, interval: 20 },
		);
		const sendCall = post.mock.calls.find(([url]) => String(url).includes("/sendMessage"))!;
		expect(sendCall[1].reply_to_message_id).toBeUndefined();
		agent.stop();
	});
});
