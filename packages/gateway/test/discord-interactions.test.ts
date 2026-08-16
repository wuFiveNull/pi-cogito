import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { DiscordChannel } from "../src/channels/discord.ts";
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

	close(): void {
		this.closeHandler?.();
	}

	emit(text: string): void {
		this.messageHandler?.(text);
	}
}

function jsonResponse(data: unknown, status = 200) {
	return {
		ok: status < 400,
		status,
		text: async () => JSON.stringify(data),
		json: async () => data,
	} as Response;
}

interface RestLogEntry {
	method: string | undefined;
	url: string;
	body?: unknown;
}

/** fetchFn that routes REST calls and records them. */
function makeRest(channelMeta: Record<string, { guild_id?: string; parent_id?: string }> = {}) {
	const log: RestLogEntry[] = [];
	const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const urlString = String(url);
		const method = init?.method ?? "GET";
		log.push({
			method,
			url: urlString,
			body: init?.body === undefined ? undefined : parseBody(init.body),
		});
		if (urlString.endsWith("/gateway")) return jsonResponse({ url: "wss://gateway.example" });
		if (urlString.endsWith("/users/@me")) return jsonResponse({ id: "bot-self" });
		if (urlString.endsWith("/oauth2/applications/@me")) return jsonResponse({ id: "app-1" });
		if (urlString.includes("/applications/app-1/commands")) return jsonResponse({});
		if (urlString.includes("/callback")) return jsonResponse({});
		if (urlString.includes("/typing") || urlString.includes("/reactions")) return jsonResponse({});
		const channelMatch = /\/channels\/([^/]+)$/.exec(urlString);
		if (channelMatch) {
			const meta = channelMeta[channelMatch[1]!] ?? {};
			return jsonResponse(meta);
		}
		if (urlString.endsWith("/messages")) return jsonResponse({ id: "dm-1" });
		return jsonResponse({});
	};
	return { fetchFn, log };
}

function parseBody(body: unknown): unknown {
	if (typeof body === "string") {
		try {
			return JSON.parse(body);
		} catch {
			return body;
		}
	}
	return body;
}

async function connect(ws: FakeWs, _channel: DiscordChannel): Promise<void> {
	await vi.waitFor(() => expect(ws.url).toContain("wss://gateway.example"), { timeout: 2000 });
	ws.emit(JSON.stringify({ op: 10, d: { heartbeat_interval: 100000 } }));
	ws.emit(JSON.stringify({ op: 0, t: "READY", d: { session_id: "s1", user: { id: "bot-self" } }, s: 1 }));
	await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("DiscordChannel interactions", () => {
	it("answers slash commands with an ephemeral ack and forwards the text", async () => {
		const { fetchFn, log } = makeRest();
		const ws = new FakeWs();
		const bus = new MessageBus();
		const channel = new DiscordChannel({ token: "tok", allowFrom: ["*"] }, bus, { socket: ws, fetchFn });
		await channel.start();
		running.push(async () => void channel.stop());
		await connect(ws, channel);
		const inbound = new Promise<Record<string, unknown>>((resolve) => {
			bus.onInbound((msg) =>
				resolve({
					content: msg.content,
					senderId: msg.senderId,
					chatId: msg.chatId,
					metadata: msg.metadata,
				}),
			);
		});
		ws.emit(
			JSON.stringify({
				op: 0,
				t: "INTERACTION_CREATE",
				d: {
					id: "int-1",
					token: "tok-1",
					type: 2,
					channel_id: "ch-1",
					user: { id: "u1" },
					data: { name: "help" },
				},
			}),
		);
		const received = await inbound;
		expect(received.content).toBe("/help");
		expect(received.senderId).toBe("u1");
		expect(received.chatId).toBe("ch-1");
		expect(received.metadata).toMatchObject({ isSlashCommand: true, interactionId: "int-1" });
		const ack = log.find((entry) => entry.url.includes("/callback"));
		expect(ack).toBeDefined();
		expect(ack!.method).toBe("POST");
		expect(ack!.body).toMatchObject({ type: 4, data: { content: "Processing...", flags: 64 } });
	});

	it("routes message components back as button messages", async () => {
		const { fetchFn, log } = makeRest();
		const ws = new FakeWs();
		const bus = new MessageBus();
		const channel = new DiscordChannel({ token: "tok", allowFrom: ["*"] }, bus, { socket: ws, fetchFn });
		await channel.start();
		running.push(async () => void channel.stop());
		await connect(ws, channel);
		const inbound = new Promise<Record<string, unknown>>((resolve) => {
			bus.onInbound((msg) => resolve({ content: msg.content, metadata: msg.metadata }));
		});
		ws.emit(
			JSON.stringify({
				op: 0,
				t: "INTERACTION_CREATE",
				d: {
					id: "int-2",
					token: "tok-2",
					type: 3,
					channel_id: "ch-1",
					user: { id: "u1" },
					data: { custom_id: "btn-yes" },
				},
			}),
		);
		const received = await inbound;
		expect(received.content).toBe("btn-yes");
		expect(received.metadata).toMatchObject({ button: true });
		const ack = log.find((entry) => entry.url.includes("/callback"));
		expect(ack!.body).toMatchObject({ type: 6 });
	});

	it("denies unauthorized slash commands with an ephemeral reply", async () => {
		const { fetchFn, log } = makeRest();
		const ws = new FakeWs();
		const bus = new MessageBus();
		const channel = new DiscordChannel({ token: "tok", allowFrom: ["u1"] }, bus, { socket: ws, fetchFn });
		await channel.start();
		running.push(async () => void channel.stop());
		await connect(ws, channel);
		ws.emit(
			JSON.stringify({
				op: 0,
				t: "INTERACTION_CREATE",
				d: {
					id: "int-3",
					token: "tok-3",
					type: 2,
					channel_id: "ch-1",
					user: { id: "intruder" },
					data: { name: "help" },
				},
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(bus.inboundSize).toBe(0);
		const ack = log.find((entry) => entry.url.includes("/callback"));
		expect(ack!.body).toMatchObject({ type: 4, data: { content: "You are not allowed to use this bot." } });
	});

	it("syncs the command registry on start", async () => {
		const { fetchFn, log } = makeRest();
		const ws = new FakeWs();
		const bus = new MessageBus();
		const channel = new DiscordChannel({ token: "tok", allowFrom: ["*"] }, bus, { socket: ws, fetchFn });
		await channel.start();
		running.push(async () => void channel.stop());
		await vi.waitFor(() => expect(log.some((entry) => entry.url.includes("/commands"))).toBe(true), {
			timeout: 2000,
		});
		const sync = log.find((entry) => entry.url.includes("/commands"));
		expect(sync!.method).toBe("PUT");
		expect(sync!.body).toEqual([
			{ name: "model", description: "Show or switch runtime model preset" },
			{ name: "trigger", description: "Create a named local trigger for this chat" },
			{ name: "help", description: "Show available commands" },
		]);
	});
});

describe("DiscordChannel threads and channels", () => {
	it("scopes thread messages to a parent-channel session", async () => {
		const { fetchFn } = makeRest({ "thread-9": { guild_id: "g1", parent_id: "parent-1" } });
		const ws = new FakeWs();
		const bus = new MessageBus();
		const channel = new DiscordChannel({ token: "tok", allowFrom: ["*"], groupPolicy: "open" }, bus, {
			socket: ws,
			fetchFn,
		});
		await channel.start();
		running.push(async () => void channel.stop());
		await connect(ws, channel);
		const inbound = new Promise<Record<string, unknown>>((resolve) => {
			bus.onInbound((msg) => resolve({ sessionKey: msg.sessionKey, metadata: msg.metadata, chatId: msg.chatId }));
		});
		ws.emit(
			JSON.stringify({
				op: 0,
				t: "MESSAGE_CREATE",
				d: {
					id: "m9",
					channel_id: "thread-9",
					guild_id: "g1",
					author: { id: "u1", bot: false },
					content: "in thread",
				},
			}),
		);
		const received = await inbound;
		expect(received.chatId).toBe("thread-9");
		expect(received.sessionKey).toBe("discord:parent-1:thread:thread-9");
		expect(received.metadata).toMatchObject({ parentChannelId: "parent-1", threadId: "thread-9" });
	});

	it("requires a mention in guilds under the default mention policy", async () => {
		const { fetchFn } = makeRest();
		const ws = new FakeWs();
		const bus = new MessageBus();
		const channel = new DiscordChannel({ token: "tok", allowFrom: ["*"] }, bus, { socket: ws, fetchFn });
		await channel.start();
		running.push(async () => void channel.stop());
		await connect(ws, channel);
		ws.emit(
			JSON.stringify({
				op: 0,
				t: "MESSAGE_CREATE",
				d: { id: "m1", channel_id: "ch-1", guild_id: "g1", author: { id: "u1" }, content: "no mention" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(bus.inboundSize).toBe(0);
		ws.emit(
			JSON.stringify({
				op: 0,
				t: "MESSAGE_CREATE",
				d: {
					id: "m2",
					channel_id: "ch-1",
					guild_id: "g1",
					author: { id: "u1" },
					content: "mentioned",
					mentions: [{ id: "bot-self" }],
				},
			}),
		);
		const inbound = await bus.consumeInbound();
		expect(inbound.content).toBe("mentioned");
	});

	it("enforces the channel/category allowlist", async () => {
		const { fetchFn } = makeRest({
			"ch-ok": { guild_id: "g1", parent_id: "cat-1" },
			"ch-no": { guild_id: "g1", parent_id: "cat-2" },
		});
		const ws = new FakeWs();
		const bus = new MessageBus();
		const channel = new DiscordChannel(
			{ token: "tok", allowFrom: ["*"], groupPolicy: "open", allowChannels: ["cat-1"] },
			bus,
			{ socket: ws, fetchFn },
		);
		await channel.start();
		running.push(async () => void channel.stop());
		await connect(ws, channel);
		ws.emit(
			JSON.stringify({
				op: 0,
				t: "MESSAGE_CREATE",
				d: { id: "m1", channel_id: "ch-no", guild_id: "g1", author: { id: "u1" }, content: "no" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(bus.inboundSize).toBe(0);
		ws.emit(
			JSON.stringify({
				op: 0,
				t: "MESSAGE_CREATE",
				d: { id: "m2", channel_id: "ch-ok", guild_id: "g1", author: { id: "u1" }, content: "yes" },
			}),
		);
		const inbound = await bus.consumeInbound();
		expect(inbound.content).toBe("yes");
	});
});

describe("DiscordChannel turn activity", () => {
	it("adds a read receipt, then clears reactions after the reply", async () => {
		const { fetchFn, log } = makeRest();
		const ws = new FakeWs();
		const bus = new MessageBus();
		const channel = new DiscordChannel(
			{ token: "tok", allowFrom: ["*"], groupPolicy: "open", workingEmoji: "", workingEmojiDelayMs: 0 },
			bus,
			{ socket: ws, fetchFn },
		);
		await channel.start();
		running.push(async () => void channel.stop());
		await connect(ws, channel);
		ws.emit(
			JSON.stringify({
				op: 0,
				t: "MESSAGE_CREATE",
				d: { id: "m1", channel_id: "ch-1", author: { id: "u1" }, content: "hi" },
			}),
		);
		await vi.waitFor(() => expect(log.some((entry) => entry.url.includes("/reactions"))).toBe(true), {
			timeout: 2000,
		});
		const added = log.find((entry) => entry.method === "PUT" && entry.url.includes("/reactions"));
		expect(added!.url).toContain("ch-1/messages/m1/reactions/%F0%9F%91%80/@me");
		// Reply completes the turn: reactions are removed.
		await channel.send({ channel: "discord", chatId: "ch-1", content: "done" });
		expect(log.some((entry) => entry.method === "DELETE" && entry.url.includes("/reactions"))).toBe(true);
	});
});
