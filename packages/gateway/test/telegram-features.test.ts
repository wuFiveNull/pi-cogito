import { describe, expect, it, vi } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { ChannelContextScope } from "../src/channels/context.ts";
import { type HttpGet, type HttpPost, type HttpResult, TelegramChannel } from "../src/channels/telegram.ts";
import { StreamEndEvent } from "../src/events.ts";
import type { OutboundDelta, OutboundMessage } from "../src/types.ts";

function jsonResult(status: number, data: unknown): HttpResult {
	return { ok: status < 400, status, json: async () => data };
}

function makeChannel(
	get: ReturnType<typeof vi.fn>,
	post: ReturnType<typeof vi.fn>,
	config: Record<string, unknown> = {},
) {
	const bus = new MessageBus();
	const channel = new TelegramChannel({ token: "test-token", ...config }, bus, {
		get: get as unknown as HttpGet,
		post: post as unknown as HttpPost,
	});
	return channel;
}

function delta(overrides: Partial<OutboundDelta> = {}): OutboundDelta {
	return { channel: "telegram", chatId: "123", delta: "hello", ...overrides };
}

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
	return { channel: "telegram", chatId: "123", content: "hi", ...overrides };
}

describe("TelegramChannel streaming", () => {
	it("sends the first delta as a new message then edits it", async () => {
		const post = vi.fn().mockResolvedValue(jsonResult(200, { ok: true, result: { message_id: 55 } }));
		const channel = makeChannel(vi.fn(), post, { streaming: true, streamEditIntervalMs: 10 });
		await channel.sendDelta(delta({ delta: "Hel" }));
		await sleep(30);
		await channel.sendDelta(delta({ delta: "lo" }));
		await sleep(30);
		await channel.sendDelta(delta({ delta: " world" }));

		expect(post.mock.calls[0]![0]).toContain("/sendMessage");
		expect(post.mock.calls[0]![1]).toMatchObject({ chat_id: 123, text: "Hel" });
		expect(post.mock.calls[1]![0]).toContain("/editMessageText");
		expect(post.mock.calls[1]![1]).toMatchObject({ chat_id: 123, message_id: 55, text: "Hello" });
		expect(post.mock.calls[2]![1]).toMatchObject({ message_id: 55, text: "Hello world" });
	});

	it("throttles intermediate edits and finalizes on stream end", async () => {
		const post = vi.fn().mockResolvedValue(jsonResult(200, { ok: true, result: { message_id: 7 } }));
		const channel = makeChannel(vi.fn(), post, { streaming: true, streamEditIntervalMs: 1000 });
		await channel.sendDelta(delta({ delta: "one" }));
		await channel.sendDelta(delta({ delta: " two" }));
		await channel.sendDelta(
			delta({ delta: " three", streamEnd: true, event: new StreamEndEvent({ streamId: "s1" }) }),
		);
		// First delta sent a message; the second was throttled; the end edits.
		// The end's own content is ignored: the buffer holds the accumulated text.
		expect(post.mock.calls[0]![0]).toContain("/sendMessage");
		expect(post.mock.calls[1]![0]).toContain("/editMessageText");
		expect(post.mock.calls[1]![1]).toMatchObject({ message_id: 7, text: "one two" });
		expect(post.mock.calls).toHaveLength(2);
	});

	it("treats message-is-not-modified as a silent no-op", async () => {
		const post = vi
			.fn()
			.mockResolvedValueOnce(jsonResult(200, { ok: true, result: { message_id: 9 } }))
			.mockResolvedValue(jsonResult(400, { ok: false, description: "Bad Request: message is not modified" }));
		const channel = makeChannel(vi.fn(), post, { streaming: true, streamEditIntervalMs: 10 });
		await channel.sendDelta(delta({ delta: "a" }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		await channel.sendDelta(delta({ delta: "b" }));
		// No throw: the 400 was swallowed.
		expect(post.mock.calls[1]![0]).toContain("/editMessageText");
	});

	it("resends the full text when the final edit fails", async () => {
		const post = vi
			.fn()
			.mockResolvedValueOnce(jsonResult(200, { ok: true, result: { message_id: 11 } }))
			.mockResolvedValueOnce(jsonResult(500, { ok: false }))
			.mockResolvedValueOnce(jsonResult(500, { ok: false }))
			.mockResolvedValue(jsonResult(200, { ok: true, result: { message_id: 12 } }));
		const channel = makeChannel(vi.fn(), post, { streaming: true });
		await channel.sendDelta(delta({ delta: "final text" }));
		await channel.sendDelta(delta({ delta: "", streamEnd: true, event: new StreamEndEvent({ streamId: "s1" }) }));
		expect(post.mock.calls[1]![0]).toContain("/editMessageText");
		expect(post.mock.calls[2]![0]).toContain("/editMessageText");
		expect(post.mock.calls[3]![0]).toContain("/sendMessage");
		expect(post.mock.calls[3]![1]).toMatchObject({ chat_id: 123, text: "final text" });
	});
});

describe("TelegramChannel buttons", () => {
	it("sends buttons as an inline keyboard", async () => {
		const post = vi.fn().mockResolvedValue(jsonResult(200, { ok: true, result: { message_id: 1 } }));
		const channel = makeChannel(vi.fn(), post);
		await channel.send(message({ content: "choose", buttons: [["yes", "no"], ["maybe"]] }));
		expect(post.mock.calls[0]![1]).toMatchObject({
			reply_markup: {
				inline_keyboard: [
					[
						{ text: "yes", callback_data: "yes" },
						{ text: "no", callback_data: "no" },
					],
					[{ text: "maybe", callback_data: "maybe" }],
				],
			},
		});
	});

	it("renders buttons as text when keyboards are disabled", async () => {
		const post = vi.fn().mockResolvedValue(jsonResult(200, { ok: true, result: { message_id: 1 } }));
		const channel = makeChannel(vi.fn(), post, { inlineKeyboards: false });
		await channel.send(message({ content: "choose", buttons: [["yes", "no"]] }));
		const body = post.mock.calls[0]![1] as Record<string, unknown>;
		expect(body.reply_markup).toBeUndefined();
		expect(body.text).toContain("[yes]");
		expect(body.text).toContain("[no]");
	});

	it("feeds callback queries back as inbound messages", async () => {
		const get = vi.fn();
		const post = vi.fn();
		const channel = makeChannel(get, post, { allowFrom: ["42"] });
		const inbound = new Promise<Record<string, unknown>>((resolve) => {
			// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
			const bus = channel["bus"] as MessageBus;
			bus.onInbound((msg) =>
				resolve({ content: msg.content, senderId: msg.senderId, chatId: msg.chatId, metadata: msg.metadata }),
			);
		});
		get.mockResolvedValue(
			jsonResult(200, {
				ok: true,
				result: [
					{
						update_id: 5,
						callback_query: {
							id: "cb1",
							from: { id: 42 },
							message: { message_id: 200, chat: { id: -77, type: "group" } },
							data: "yes",
						},
					},
				],
			}),
		);
		await channel.start();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const received = await inbound;
		expect(received.content).toBe("yes");
		expect(received.senderId).toBe("42");
		expect(received.metadata).toMatchObject({ button: true, chatType: "group" });
		await channel.stop();
	});
});

describe("TelegramChannel inbound media and mentions", () => {
	it("marks messages that mention the bot", async () => {
		const get = vi.fn();
		const post = vi.fn();
		const channel = makeChannel(get, post, { allowFrom: ["42"] });
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const bus = channel["bus"] as MessageBus;
		const inbound = new Promise<Record<string, unknown>>((resolve) => {
			bus.onInbound((msg) => resolve({ content: msg.content, metadata: msg.metadata }));
		});
		// getMe resolves the bot username first.
		get.mockResolvedValueOnce(jsonResult(200, { ok: true, result: { username: "my_bot" } }));
		get.mockResolvedValue(
			jsonResult(200, {
				ok: true,
				result: [
					{
						update_id: 6,
						message: {
							message_id: 300,
							from: { id: 42 },
							chat: { id: -1, type: "group" },
							text: "@my_bot hi",
							entities: [{ type: "mention", offset: 0, length: 7 }],
						},
					},
				],
			}),
		);
		await channel.start();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const received = await inbound;
		expect(received.metadata).toMatchObject({ mentionedBot: true, chatType: "group" });
		await channel.stop();
	});

	it("downloads inbound photos as multimodal images", async () => {
		const get = vi.fn();
		const post = vi.fn();
		// 1x1 PNG bytes.
		const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
		const fetchFn = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => png.buffer });
		const channel = new TelegramChannel({ token: "test-token", allowFrom: ["42"] }, new MessageBus(), {
			get: get as unknown as HttpGet,
			post: post as unknown as HttpPost,
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const bus = channel["bus"] as MessageBus;
		const inbound = new Promise<{ images?: Array<{ mimeType: string }>; content: string }>((resolve) => {
			bus.onInbound((msg) => resolve({ content: msg.content, images: msg.images }));
		});
		get.mockResolvedValueOnce(jsonResult(200, { ok: true, result: { username: "my_bot" } }));
		get.mockResolvedValueOnce(
			jsonResult(200, {
				ok: true,
				result: [
					{
						update_id: 7,
						message: {
							message_id: 400,
							from: { id: 42 },
							chat: { id: 123 },
							caption: "see this",
							photo: [{ file_id: "f1", width: 100, height: 50 }],
						},
					},
				],
			}),
		);
		get.mockResolvedValueOnce(jsonResult(200, { ok: true, result: { file_path: "photos/f1.jpg" } }));
		await channel.start();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const received = await inbound;
		expect(received.content).toBe("see this");
		expect(received.images).toHaveLength(1);
		expect(received.images?.[0]?.mimeType).toBe("image/png");
		expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining("/file/bottest-token/photos/f1.jpg"));
		await channel.stop();
	});

	it("transcribes inbound voice through the host transcriber", async () => {
		const get = vi.fn();
		const post = vi.fn();
		const transcriber = vi.fn().mockResolvedValue("transcribed words");
		const bus = new MessageBus();
		const channel = new TelegramChannel({ token: "test-token", allowFrom: ["42"] }, bus, {
			get: get as unknown as HttpGet,
			post: post as unknown as HttpPost,
		});
		channel.bindContext(new ChannelContextScope(bus, { transcriber }));
		const inbound = new Promise<{ content: string }>((resolve) => {
			bus.onInbound((msg) => resolve({ content: msg.content }));
		});
		get.mockResolvedValueOnce(jsonResult(200, { ok: true, result: { username: "my_bot" } }));
		get.mockResolvedValueOnce(
			jsonResult(200, {
				ok: true,
				result: [
					{
						update_id: 8,
						message: {
							message_id: 500,
							from: { id: 42 },
							chat: { id: 123 },
							voice: { file_id: "v1", mime_type: "audio/ogg" },
						},
					},
				],
			}),
		);
		get.mockResolvedValueOnce(jsonResult(200, { ok: true, result: { file_path: "voice/v1.ogg" } }));
		const fetchFn = vi
			.fn()
			.mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
		(channel as unknown as { fetchFn: typeof fetch }).fetchFn = fetchFn as unknown as typeof fetch;
		await channel.start();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const received = await inbound;
		expect(received.content).toContain("transcribed words");
		expect(transcriber).toHaveBeenCalledWith(expect.any(Uint8Array), "audio/ogg");
		await channel.stop();
	});
});

describe("TelegramChannel turn activity", () => {
	it("starts typing and reacts on accepted messages, clears on reply", async () => {
		const get = vi.fn();
		const post = vi.fn().mockResolvedValue(jsonResult(200, { ok: true }));
		const channel = makeChannel(get, post, { allowFrom: ["42"], reactEmoji: "👀", pollIntervalMs: 20 });
		get.mockResolvedValue(
			jsonResult(200, {
				ok: true,
				result: [
					{
						update_id: 10,
						message: {
							message_id: 600,
							from: { id: 42 },
							chat: { id: 123 },
							text: "work",
						},
					},
				],
			}),
		);
		await channel.start();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const typingCalls = post.mock.calls.filter(([url]) => String(url).includes("/sendChatAction"));
		const reactionCalls = post.mock.calls.filter(([url]) => String(url).includes("/setMessageReaction"));
		expect(typingCalls.length).toBeGreaterThan(0);
		expect(typingCalls[0]![1]).toMatchObject({ chat_id: 123, action: "typing" });
		expect(reactionCalls).toHaveLength(1);
		expect(reactionCalls[0]![1]).toMatchObject({ chat_id: 123, message_id: 600 });
		await channel.stop();
	});

	it("does not type or react when disabled or filtered", async () => {
		const get = vi.fn();
		const post = vi.fn();
		const channel = makeChannel(get, post, {
			allowFrom: ["42"],
			showTyping: false,
			reactEmoji: "",
			pollIntervalMs: 20,
		});
		get.mockResolvedValue(
			jsonResult(200, {
				ok: true,
				result: [
					{
						update_id: 11,
						message: {
							message_id: 601,
							from: { id: 42 },
							chat: { id: 123 },
							text: "quiet",
						},
					},
				],
			}),
		);
		await channel.start();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(post.mock.calls.some(([url]) => String(url).includes("/sendChatAction"))).toBe(false);
		expect(post.mock.calls.some(([url]) => String(url).includes("/setMessageReaction"))).toBe(false);
		await channel.stop();
	});
});

describe("TelegramChannel media groups and topics", () => {
	it("buffers a media group and flushes it as one aggregated turn", async () => {
		const get = vi.fn();
		const post = vi.fn();
		const channel = makeChannel(get, post, { allowFrom: ["42"], pollIntervalMs: 20 });
		const inbound: Array<Record<string, unknown>> = [];
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const bus = channel["bus"] as MessageBus;
		bus.onInbound((msg) => void inbound.push({ content: msg.content, attachments: msg.attachments }));
		// getMe resolves the bot username; getUpdates returns the album only on
		// the first poll (later offsets return empty); getFile resolves paths.
		get.mockImplementation((url: string) => {
			if (url.includes("/getMe")) {
				return jsonResult(200, { ok: true, result: { username: "my_bot" } });
			}
			if (url.includes("/getFile")) {
				const fileId = new URL(url).searchParams.get("file_id");
				return jsonResult(200, {
					ok: true,
					result: { file_path: fileId === "p1" ? "photos/p1.jpg" : "docs/d1.txt" },
				});
			}
			const offset = Number(new URL(url).searchParams.get("offset") ?? 0);
			if (offset > 1) return jsonResult(200, { ok: true, result: [] });
			return jsonResult(200, {
				ok: true,
				result: [
					{
						update_id: 12,
						message: {
							message_id: 700,
							from: { id: 42 },
							chat: { id: 123 },
							caption: "first",
							media_group_id: "album1",
							photo: [{ file_id: "p1", width: 10, height: 10 }],
						},
					},
					{
						update_id: 13,
						message: {
							message_id: 701,
							from: { id: 42 },
							chat: { id: 123 },
							caption: "second",
							media_group_id: "album1",
							document: { file_id: "d1", file_name: "doc.txt", mime_type: "text/plain" },
						},
					},
				],
			});
		});
		const fetchFn = vi
			.fn()
			.mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
		(channel as unknown as { fetchFn: typeof fetch }).fetchFn = fetchFn as unknown as typeof fetch;
		await channel.start();
		await sleep(1200); // Longer than the 600ms flush window.
		expect(inbound).toHaveLength(1);
		expect(inbound[0]!.content).toContain("first");
		expect(inbound[0]!.content).toContain("second");
		expect(inbound[0]!.attachments).toHaveLength(1);
		await channel.stop();
	});

	it("scopes forum topic messages to their own session", async () => {
		const get = vi.fn();
		const post = vi.fn();
		const channel = makeChannel(get, post, { allowFrom: ["42"], pollIntervalMs: 20 });
		const inbound = new Promise<{ sessionKey: string }>((resolve) => {
			// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
			const bus = channel["bus"] as MessageBus;
			bus.onInbound((msg) => resolve({ sessionKey: msg.sessionKey }));
		});
		get.mockResolvedValue(
			jsonResult(200, {
				ok: true,
				result: [
					{
						update_id: 14,
						message: {
							message_id: 800,
							from: { id: 42 },
							chat: { id: -100, type: "supergroup" },
							text: "topic msg",
							message_thread_id: 99,
						},
					},
				],
			}),
		);
		await channel.start();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect((await inbound).sessionKey).toBe("telegram:-100:99");
		await channel.stop();
	});
});

describe("TelegramChannel markdown rendering and commands", () => {
	it("renders markdown to HTML for complete sends", async () => {
		const post = vi.fn().mockResolvedValue(jsonResult(200, { ok: true, result: { message_id: 1 } }));
		const channel = makeChannel(vi.fn(), post);
		await channel.send(message({ content: "**bold** and `code`\n```ts\nconst x = 1;\n```\n| a | b |\n| 1 | 2 |" }));
		const body = post.mock.calls[0]![1] as Record<string, unknown>;
		expect(body.parse_mode).toBe("HTML");
		expect(body.text).toContain("<b>bold</b>");
		expect(body.text).toContain("<code>code</code>");
		expect(body.text).toContain('<pre><code class="language-ts">const x = 1;</code></pre>');
		expect(body.text).toContain("<pre>| a | b |");
	});

	it("sends plain text when rendering produced no markup", async () => {
		const post = vi.fn().mockResolvedValue(jsonResult(200, { ok: true, result: { message_id: 2 } }));
		const channel = makeChannel(vi.fn(), post);
		await channel.send(message({ content: "just plain words" }));
		const body = post.mock.calls[0]![1] as Record<string, unknown>;
		expect(body.parse_mode).toBeUndefined();
		expect(body.text).toBe("just plain words");
	});

	it("falls back to plain text when the HTML send is rejected", async () => {
		const post = vi
			.fn()
			.mockResolvedValueOnce(jsonResult(400, { ok: false }))
			.mockResolvedValue(jsonResult(200, { ok: true, result: { message_id: 3 } }));
		const channel = makeChannel(vi.fn(), post);
		await channel.send(message({ content: "**bold**" }));
		expect(String(post.mock.calls[0]![0])).toContain("/sendMessage");
		expect((post.mock.calls[0]![1] as Record<string, unknown>).parse_mode).toBe("HTML");
		expect((post.mock.calls[1]![1] as Record<string, unknown>).text).toBe("**bold**");
	});

	it("renders the final stream edit with HTML", async () => {
		const post = vi
			.fn()
			.mockResolvedValueOnce(jsonResult(200, { ok: true, result: { message_id: 4 } }))
			.mockResolvedValue(jsonResult(200, { ok: true }));
		const channel = makeChannel(vi.fn(), post, { streaming: true });
		await channel.sendDelta(delta({ delta: "**done**" }));
		await channel.sendDelta(delta({ delta: "", streamEnd: true, event: new StreamEndEvent({ streamId: "s1" }) }));
		expect(post.mock.calls[1]![0]).toContain("/editMessageText");
		const body = post.mock.calls[1]![1] as Record<string, unknown>;
		expect(body.parse_mode).toBe("HTML");
		expect(body.text).toContain("<b>done</b>");
	});

	it("answers registered slash commands without publishing inbound", async () => {
		const get = vi.fn();
		const post = vi.fn().mockResolvedValue(jsonResult(200, { ok: true, result: { message_id: 5 } }));
		const channel = makeChannel(get, post, { allowFrom: ["42"], pollIntervalMs: 20 });
		let inboundCount = 0;
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		const bus = channel["bus"] as MessageBus;
		bus.onInbound(() => void inboundCount++);
		get.mockResolvedValue(
			jsonResult(200, {
				ok: true,
				result: [
					{
						update_id: 15,
						message: {
							message_id: 900,
							from: { id: 42 },
							chat: { id: 123, type: "private" },
							text: "/help",
						},
					},
				],
			}),
		);
		await channel.start();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(inboundCount).toBe(0);
		const reply = post.mock.calls.find(([url]) => String(url).includes("/sendMessage"))!;
		expect(String(reply[0])).toContain("/sendMessage");
		expect((reply[1] as Record<string, unknown>).text).toContain("Available commands");
		await channel.stop();
	});

	it("forwards unregistered commands to the agent", async () => {
		const get = vi.fn();
		const post = vi.fn();
		const channel = makeChannel(get, post, { allowFrom: ["42"], pollIntervalMs: 20 });
		const inbound = new Promise<{ content: string }>((resolve) => {
			// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
			const bus = channel["bus"] as MessageBus;
			bus.onInbound((msg) => resolve({ content: msg.content }));
		});
		get.mockResolvedValue(
			jsonResult(200, {
				ok: true,
				result: [
					{
						update_id: 16,
						message: {
							message_id: 901,
							from: { id: 42 },
							chat: { id: 123 },
							text: "/custom_thing arg1",
						},
					},
				],
			}),
		);
		await channel.start();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect((await inbound).content).toBe("/custom_thing arg1");
		await channel.stop();
	});
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
