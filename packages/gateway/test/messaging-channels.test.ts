import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAgent } from "../src/agent.ts";
import { MessageBus } from "../src/bus.ts";
import type { BaseChannel } from "../src/channels/base.ts";
import { DiscordChannel } from "../src/channels/discord.ts";
import { OutboundDispatcher } from "../src/channels/dispatcher.ts";
import { MatrixChannel } from "../src/channels/matrix.ts";
import { MattermostChannel } from "../src/channels/mattermost.ts";
import { SlackChannel } from "../src/channels/slack.ts";
import type { WsLike } from "../src/channels/ws-common.ts";

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of running.splice(0)) await cleanup();
});

class FakeWs implements WsLike {
	url = "";
	headers: Record<string, string> = {};
	sent: string[] = [];
	private messageHandler: ((text: string) => void) | undefined;
	private closeHandler: (() => void) | undefined;

	async connect(url: string, headers: Record<string, string> = {}): Promise<void> {
		this.url = url;
		this.headers = headers;
	}

	send(text: string): void {
		this.sent.push(text);
	}

	onMessage(handler: (text: string) => void): void {
		this.messageHandler = handler;
	}

	onClose(handler: () => void): void {
		this.closeHandler = handler;
	}

	close(): void {}

	emit(text: string): void {
		this.messageHandler?.(text);
	}

	disconnect(): void {
		this.closeHandler?.();
	}
}

function jsonResponse(body: unknown, ok = true) {
	return {
		ok,
		status: ok ? 200 : 500,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as Response;
}

async function startChannel(channel: BaseChannel, bus: MessageBus) {
	await channel.start();
	const dispatcher = new OutboundDispatcher(bus, {
		get: (name: string) => (name === channel.name ? channel : undefined),
	});
	dispatcher.start();
	running.push(async () => {
		dispatcher.stop();
		await channel.stop();
	});
	return bus;
}

describe("MattermostChannel", () => {
	it("connects with bearer token and normalizes posted events", async () => {
		const ws = new FakeWs();
		const bus = new MessageBus();
		const channel = new MattermostChannel(
			{ serverUrl: "https://mm.example.com", token: "tok", allowFrom: ["*"] },
			bus,
			{ socket: ws },
		);
		await startChannel(channel, bus);

		expect(ws.url).toBe("wss://mm.example.com/api/v4/websocket");
		expect(ws.headers).toMatchObject({ Authorization: "Bearer tok" });

		ws.emit(
			JSON.stringify({
				event: "posted",
				data: { post: JSON.stringify({ channel_id: "chan-1", user_id: "user-1", message: "hi there", type: "" }) },
			}),
		);
		const inbound = await bus.consumeInbound();
		expect(inbound).toMatchObject({
			channel: "mattermost",
			chatId: "chan-1",
			senderId: "user-1",
			content: "hi there",
		});
	});

	it("skips bot posts and sends via REST", async () => {
		const ws = new FakeWs();
		const calls: Array<{ url: string; body: unknown }> = [];
		const bus = new MessageBus();
		const channel = new MattermostChannel(
			{ serverUrl: "https://mm.example.com", token: "tok", botUserId: "bot-1", allowFrom: ["*"] },
			bus,
			{
				socket: ws,
				fetchFn: async (url, init) => {
					calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
					return jsonResponse({ id: "p1" });
				},
			},
		);
		await startChannel(channel, bus);
		const agent = new FakeAgent(bus);
		agent.start();

		ws.emit(
			JSON.stringify({
				event: "posted",
				data: { post: JSON.stringify({ channel_id: "chan-1", user_id: "bot-1", message: "self" }) },
			}),
		);
		ws.emit(
			JSON.stringify({
				event: "posted",
				data: { post: JSON.stringify({ channel_id: "chan-2", user_id: "user-2", message: "hello" }) },
			}),
		);

		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			url: "https://mm.example.com/api/v4/posts",
			body: { channel_id: "chan-2", message: "[mattermost] 收到: hello" },
		});
		agent.stop();
	});
});

describe("SlackChannel", () => {
	it("opens socket mode, acks envelopes, normalizes events and sends replies", async () => {
		const ws = new FakeWs();
		const postCalls: Array<{ url: string; body: unknown }> = [];
		const bus = new MessageBus();
		const channel = new SlackChannel({ appToken: "xapp-1", botToken: "xoxb-1", allowFrom: ["*"] }, bus, {
			socket: ws,
			fetchFn: async (url, init) => {
				if (String(url).includes("apps.connections.open"))
					return jsonResponse({ ok: true, url: "wss://slack-socket.example" });
				postCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
				return jsonResponse({ ok: true, ts: "1.2" });
			},
		});
		await startChannel(channel, bus);
		await vi.waitFor(() => expect(ws.url).toBe("wss://slack-socket.example"), { timeout: 2000 });
		const agent = new FakeAgent(bus);
		agent.start();
		ws.emit(
			JSON.stringify({
				type: "events_api",
				envelope_id: "env-1",
				payload: { event: { type: "message", channel: "C123", user: "U456", text: "hello slack", ts: "1" } },
			}),
		);
		await vi.waitFor(() => expect(postCalls).toHaveLength(1), { timeout: 2000 });
		expect(postCalls[0]).toMatchObject({
			url: "https://slack.com/api/chat.postMessage",
			body: { channel: "C123", text: "[slack] 收到: hello slack" },
		});
		agent.stop();
	});
});

describe("DiscordChannel", () => {
	it("identifies on hello and normalizes MESSAGE_CREATE", async () => {
		const ws = new FakeWs();
		const bus = new MessageBus();
		const channel = new DiscordChannel({ token: "discord-tok", allowFrom: ["*"] }, bus, {
			socket: ws,
			fetchFn: async (_url) => jsonResponse({ url: "wss://gateway.example" }),
		});
		await startChannel(channel, bus);
		await vi.waitFor(() => expect(ws.url).toContain("wss://gateway.example"), { timeout: 2000 });
		ws.emit(JSON.stringify({ op: 10, d: { heartbeat_interval: 100000 } }));
		const identify = JSON.parse(ws.sent[0]!) as { op: number; d: { token: string } };
		expect(identify.op).toBe(2);
		expect(identify.d.token).toBe("discord-tok");

		ws.emit(
			JSON.stringify({
				op: 0,
				t: "MESSAGE_CREATE",
				d: { id: "m1", channel_id: "ch-1", author: { id: "a1", bot: false }, content: "hello discord" },
			}),
		);
		const inbound = await bus.consumeInbound();
		expect(inbound).toMatchObject({ channel: "discord", chatId: "ch-1", senderId: "a1", content: "hello discord" });
	});

	it("ignores its own bot messages but allows other bots (nanobot semantics)", async () => {
		const ws = new FakeWs();
		const bus = new MessageBus();
		const channel = new DiscordChannel({ token: "tok", allowFrom: ["*"] }, bus, {
			socket: ws,
			fetchFn: async () => jsonResponse({ url: "wss://gateway.example" }),
		});
		await startChannel(channel, bus);
		await vi.waitFor(() => expect(ws.url).toContain("wss://gateway.example"), { timeout: 2000 });
		// READY reveals the bot's own user id.
		ws.emit(JSON.stringify({ op: 0, t: "READY", d: { session_id: "s", user: { id: "bot-self" } }, s: 1 }));
		ws.emit(
			JSON.stringify({
				op: 0,
				t: "MESSAGE_CREATE",
				d: { id: "m1", channel_id: "ch-1", author: { id: "bot-self", bot: true }, content: "no" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(bus.inboundSize).toBe(0);

		// Multi-agent setups: other bots are allowed through.
		ws.emit(
			JSON.stringify({
				op: 0,
				t: "MESSAGE_CREATE",
				d: { id: "m2", channel_id: "ch-1", author: { id: "other-bot", bot: true }, content: "hi" },
			}),
		);
		const inbound = await bus.consumeInbound();
		expect(inbound.senderId).toBe("other-bot");
		expect(inbound.content).toBe("hi");
	});
});

describe("MatrixChannel", () => {
	it("polls sync and normalizes room messages", async () => {
		const syncCalls: string[] = [];
		const bus = new MessageBus();
		const channel = new MatrixChannel(
			{
				homeserver: "https://matrix.example",
				accessToken: "tok",
				userId: "@bot:example",
				allowFrom: ["*"],
				pollIntervalMs: 60000,
			},
			bus,
			{
				fetchFn: async (url) => {
					syncCalls.push(String(url));
					return jsonResponse({
						next_batch: "s1",
						rooms: {
							join: {
								"!room:example": {
									timeline: {
										events: [
											{
												type: "m.room.message",
												sender: "@alice:example",
												event_id: "$e1",
												content: { msgtype: "m.text", body: "hello matrix" },
											},
											{
												type: "m.room.message",
												sender: "@bot:example",
												event_id: "$e2",
												content: { msgtype: "m.text", body: "self" },
											},
											{ type: "m.room.member", sender: "@alice:example", event_id: "$e3" },
											{
												type: "m.room.message",
												sender: "@bob:example",
												event_id: "$e4",
												content: { msgtype: "m.image", body: "pic" },
											},
										],
									},
								},
							},
						},
					});
				},
			},
		);
		await startChannel(channel, bus);

		const inbound = await bus.consumeInbound();
		expect(inbound).toMatchObject({
			channel: "matrix",
			chatId: "!room:example",
			senderId: "@alice:example",
			content: "hello matrix",
		});
		expect(syncCalls[0]).toContain("/_matrix/client/v3/sync?");
		expect(bus.inboundSize).toBe(0); // own/bot/image messages skipped
	});

	it("sends m.text via PUT with a txn id", async () => {
		const calls: Array<{ url: string; body: unknown }> = [];
		const bus = new MessageBus();
		const channel = new MatrixChannel(
			{ homeserver: "https://matrix.example", accessToken: "tok", allowFrom: ["*"], pollIntervalMs: 60000 },
			bus,
			{
				fetchFn: async (url, init) => {
					if (String(url).includes("/sync")) {
						return jsonResponse({
							next_batch: "s1",
							rooms: {
								join: {
									"!room:mid": {
										timeline: {
											events: [
												{
													type: "m.room.message",
													sender: "@alice:example",
													event_id: "$e",
													content: { msgtype: "m.text", body: "hello" },
												},
											],
										},
									},
								},
							},
						});
					}
					calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
					return jsonResponse({ event_id: "$x" });
				},
			},
		);
		await startChannel(channel, bus);
		const agent = new FakeAgent(bus);
		agent.start();

		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toMatch(/\/rooms\/!room%3Amid\/send\/m\.room\.message\/\d+-/);
		expect(calls[0]!.body).toMatchObject({ msgtype: "m.text", body: "[matrix] 收到: hello" });
		agent.stop();
	});

	it("scopes thread replies to a thread session and replies inside the thread", async () => {
		const calls: Array<{ url: string; body: unknown }> = [];
		const bus = new MessageBus();
		const channel = new MatrixChannel(
			{ homeserver: "https://matrix.example", accessToken: "tok", allowFrom: ["*"], pollIntervalMs: 60000 },
			bus,
			{
				fetchFn: async (url, init) => {
					if (String(url).includes("/sync")) {
						return jsonResponse({
							next_batch: "s2",
							rooms: {
								join: {
									"!room:t": {
										timeline: {
											events: [
												{
													type: "m.room.message",
													sender: "@alice:example",
													event_id: "$root",
													content: { msgtype: "m.text", body: "root" },
												},
												{
													type: "m.room.message",
													sender: "@alice:example",
													event_id: "$reply",
													content: {
														msgtype: "m.text",
														body: "in thread",
														"m.relates_to": { "m.in_reply_to": { event_id: "$root" } },
													},
												},
											],
										},
									},
								},
							},
						});
					}
					calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
					return jsonResponse({ event_id: "$x" });
				},
			},
		);
		await startChannel(channel, bus);
		const first = await bus.consumeInbound();
		expect(first.content).toBe("root");
		expect(first.sessionKey).toBe("matrix:!room:t");
		const second = await bus.consumeInbound();
		expect(second.content).toBe("in thread");
		expect(second.sessionKey).toBe("matrix:!room:t:thread:$root");
		expect(second.metadata).toMatchObject({ threadId: "$root" });

		// A direct threadId send carries both in_reply_to and the thread relation.
		await channel.send({ channel: "matrix", chatId: "!room:t", content: "thread answer", threadId: "$root" });
		const threadSend = calls.find((call) => String(call.url).includes("/send/m.room.message"));
		expect(threadSend?.body).toMatchObject({
			msgtype: "m.text",
			body: "thread answer",
			"m.relates_to": { "m.in_reply_to": { event_id: "$root" }, "m.thread": { event_id: "$root" } },
		});
	});

	it("downloads inbound mxc media and joins rooms on invite", async () => {
		const bus = new MessageBus();
		const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
		const downloads: string[] = [];
		const channel = new MatrixChannel(
			{
				homeserver: "https://matrix.example",
				accessToken: "tok",
				userId: "@bot:example",
				allowFrom: ["*"],
				pollIntervalMs: 60000,
				autoJoinInvites: true,
			},
			bus,
			{
				fetchFn: async (url, _init) => {
					const u = String(url);
					if (u.includes("/sync")) {
						return jsonResponse({
							next_batch: "s3",
							rooms: {
								invite: { "!invited:example": {} },
								join: {
									"!room:m": {
										timeline: {
											events: [
												{
													type: "m.room.message",
													sender: "@alice:example",
													event_id: "$m",
													content: {
														msgtype: "m.image",
														body: "pic.png",
														url: "mxc://matrix.example/abc123",
														info: { mimetype: "image/png" },
													},
												},
											],
										},
									},
								},
							},
						});
					}
					if (u.includes("/media/v3/download")) {
						downloads.push(u);
						return {
							ok: true,
							status: 200,
							json: async () => ({}),
							text: async () => "",
							arrayBuffer: async () => png.buffer,
						} as Response;
					}
					if (u.includes("/join")) return jsonResponse({ room_id: "!invited:example" });
					return jsonResponse({});
				},
			},
		);
		await startChannel(channel, bus);
		const inbound = await bus.consumeInbound();
		expect(inbound.content).toBe("pic.png");
		expect(inbound.images).toHaveLength(1);
		expect(inbound.images?.[0]?.mimeType).toBe("image/png");
		expect(downloads[0]).toContain("/_matrix/media/v3/download/matrix.example/abc123");
	});
});

describe("SlackChannel threads and dedup", () => {
	it("scopes thread replies and dedupes redelivered events by ts", async () => {
		const ws = new FakeWs();
		const bus = new MessageBus();
		const channel = new SlackChannel({ appToken: "xapp", botToken: "xoxb", allowFrom: ["*"] }, bus, {
			socket: ws,
			fetchFn: async () => jsonResponse({ ok: true, url: "wss://slack.example" }),
		});
		await startChannel(channel, bus);
		await vi.waitFor(() => expect(ws.url).toContain("wss://slack.example"), { timeout: 2000 });
		const inbound = new Promise<Record<string, unknown>>((resolve) => {
			bus.onInbound((msg) => resolve({ content: msg.content, sessionKey: msg.sessionKey, metadata: msg.metadata }));
		});
		const event = {
			type: "events_api",
			envelope_id: "env-1",
			payload: {
				type: "events_api",
				event: {
					type: "message",
					channel: "C1",
					user: "U1",
					text: "thread reply",
					ts: "1700000000.000001",
					thread_ts: "1700000000.000000",
				},
			},
		};
		ws.emit(JSON.stringify(event));
		const received = await inbound;
		expect(received.content).toBe("thread reply");
		expect(received.sessionKey).toBe("slack:C1:thread:1700000000.000000");
		expect(received.metadata).toMatchObject({ threadId: "1700000000.000000" });

		// Redelivered envelope with the same event ts is dropped: the queue
		// still holds only the first delivery.
		ws.emit(JSON.stringify({ ...event, envelope_id: "env-2" }));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(bus.inboundSize).toBe(1);
	});

	it("marks messages that mention the bot", async () => {
		const ws = new FakeWs();
		const bus = new MessageBus();
		const channel = new SlackChannel(
			{ appToken: "xapp", botToken: "xoxb", allowFrom: ["*"], botUserId: "U42" },
			bus,
			{
				socket: ws,
				fetchFn: async () => jsonResponse({ ok: true, url: "wss://slack.example" }),
			},
		);
		await startChannel(channel, bus);
		await vi.waitFor(() => expect(ws.url).toContain("wss://slack.example"), { timeout: 2000 });
		const inbound = new Promise<{ metadata: Record<string, unknown> | undefined }>((resolve) => {
			bus.onInbound((msg) => resolve({ metadata: msg.metadata }));
		});
		ws.emit(
			JSON.stringify({
				type: "events_api",
				envelope_id: "env-3",
				payload: {
					type: "events_api",
					event: {
						type: "message",
						channel: "C1",
						user: "U1",
						text: "hi <@U42> please",
						ts: "1700000001.000001",
					},
				},
			}),
		);
		const received = await inbound;
		expect(received.metadata).toMatchObject({ mentionedBot: true });
	});
});
