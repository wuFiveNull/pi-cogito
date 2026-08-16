import { describe, expect, it, vi } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { DiscordChannel } from "../src/channels/discord.ts";
import { MatrixChannel } from "../src/channels/matrix.ts";
import { MattermostChannel } from "../src/channels/mattermost.ts";
import { SlackChannel } from "../src/channels/slack.ts";
import type { WsLike } from "../src/channels/ws-common.ts";
import { StreamEndEvent } from "../src/events.ts";
import type { OutboundMessage } from "../src/types.ts";

function jsonResponse(data: unknown) {
	return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) } as Response;
}

class FakeWs implements WsLike {
	url = "";
	sent: string[] = [];
	handlerRegistered = false;
	private handler: ((text: string) => void) | undefined;
	private closeHandler: (() => void) | undefined;

	async connect(url: string): Promise<void> {
		this.url = url;
	}

	onMessage(handler: (text: string) => void): void {
		this.handler = handler;
		this.handlerRegistered = true;
	}

	onClose(handler: () => void): void {
		this.closeHandler = handler;
	}

	async send(text: string): Promise<void> {
		this.sent.push(text);
	}

	async close(): Promise<void> {}

	emit(text: string): void {
		this.handler?.(text);
	}

	closeSocket(): void {
		this.closeHandler?.();
	}
}

describe("SlackChannel rich features", () => {
	function makeChannel(postCalls: Array<{ url: string; body: unknown }>) {
		const ws = new FakeWs();
		const bus = new MessageBus();
		const channel = new SlackChannel({ appToken: "xapp-1", botToken: "xoxb-1", allowFrom: ["*"] }, bus, {
			socket: ws,
			fetchFn: async (url, init) => {
				if (String(url).includes("apps.connections.open"))
					return jsonResponse({ ok: true, url: "wss://slack-socket.example" });
				postCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
				if (String(url).includes("chat.postMessage"))
					return jsonResponse({ ok: true, ts: String(postCalls.length) });
				return jsonResponse({ ok: true });
			},
		});
		return { ws, bus, channel };
	}

	it("streams by sending the first delta then editing", async () => {
		const postCalls: Array<{ url: string; body: unknown }> = [];
		const { channel } = makeChannel(postCalls);
		await channel.start();
		await channel.sendDelta({ channel: "slack", chatId: "C1", delta: "Hel" });
		await channel.sendDelta({ channel: "slack", chatId: "C1", delta: "lo" });
		await channel.sendDelta({
			channel: "slack",
			chatId: "C1",
			delta: "",
			streamEnd: true,
			event: new StreamEndEvent({ streamId: "s1" }),
		});
		expect(postCalls[0]).toMatchObject({
			url: "https://slack.com/api/chat.postMessage",
			body: { channel: "C1", text: "Hel" },
		});
		expect(postCalls[1]).toMatchObject({
			url: "https://slack.com/api/chat.update",
			body: { channel: "C1", ts: "1", text: "lo" },
		});
		await channel.stop();
	});

	it("sends buttons as an actions block", async () => {
		const postCalls: Array<{ url: string; body: unknown }> = [];
		const { channel } = makeChannel(postCalls);
		const message: OutboundMessage = { channel: "slack", chatId: "C1", content: "choose", buttons: [["yes", "no"]] };
		await channel.send(message);
		const body = postCalls[0]!.body as { blocks?: Array<{ type: string; elements: unknown[] }> };
		expect(body.blocks?.[0]?.type).toBe("actions");
		const elements = body.blocks?.[0]?.elements as Array<{ value?: string }>;
		expect(elements.map((e) => e.value)).toEqual(["yes", "no"]);
	});

	it("feeds block_actions back as inbound messages", async () => {
		const postCalls: Array<{ url: string; body: unknown }> = [];
		const { ws, bus, channel } = makeChannel(postCalls);
		const inbound = new Promise<{ content: string; chatId: string; metadata: Record<string, unknown> | undefined }>(
			(resolve) => {
				bus.onInbound((msg) => resolve({ content: msg.content, chatId: msg.chatId, metadata: msg.metadata }));
			},
		);
		await channel.start();
		await vi.waitFor(() => expect(ws.handlerRegistered).toBe(true), { timeout: 2000 });
		ws.emit(
			JSON.stringify({
				type: "events_api",
				envelope_id: "env-b",
				payload: {
					type: "block_actions",
					channel: { id: "C9" },
					user: { id: "U1" },
					message: { ts: "9.9" },
					actions: [{ action_id: "yes", value: "yes" }],
				},
			}),
		);
		const received = await inbound;
		expect(received.content).toBe("yes");
		expect(received.chatId).toBe("C9");
		expect(received.metadata).toMatchObject({ button: true });
		expect(ws.sent[0]).toContain("env-b");
		await channel.stop();
	});

	it("renders reasoning as a context block", async () => {
		const postCalls: Array<{ url: string; body: unknown }> = [];
		const { channel } = makeChannel(postCalls);
		await channel.sendReasoningDelta("C1", "thinking…", undefined, "r1");
		await channel.sendReasoningEnd("C1", undefined, "r1");
		const body = postCalls[0]!.body as { blocks?: Array<{ type: string; elements: Array<{ text?: string }> }> };
		expect(postCalls[0]!.url).toContain("chat.postMessage");
		expect(body.blocks?.[0]?.type).toBe("context");
		expect(body.blocks?.[0]?.elements[0]?.text).toBe("thinking…");
	});
});

describe("channel streaming edits", () => {
	it("discord sends then edits via PATCH", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const bus = new MessageBus();
		const channel = new DiscordChannel({ token: "tok", allowFrom: ["*"] }, bus, {
			socket: new FakeWs(),
			fetchFn: async (url, init) => {
				calls.push({ url: String(url), init: init ?? {} });
				if (String(url).endsWith("/messages")) return jsonResponse({ id: "d1" });
				return jsonResponse({ id: "d1" });
			},
		});
		await channel.sendDelta({ channel: "discord", chatId: "ch1", delta: "one" });
		await channel.sendDelta({ channel: "discord", chatId: "ch1", delta: "two" });
		expect(calls[0]!.init.method).toBe("POST");
		expect(calls[1]!.init.method).toBe("PATCH");
		expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ content: "two" });
	});

	it("mattermost sends then edits via PUT", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const bus = new MessageBus();
		const channel = new MattermostChannel({ serverUrl: "https://mm.example", token: "tok", allowFrom: ["*"] }, bus, {
			socket: new FakeWs(),
			fetchFn: async (url, init) => {
				calls.push({ url: String(url), init: init ?? {} });
				return jsonResponse({ id: "p1" });
			},
		});
		await channel.sendDelta({ channel: "mattermost", chatId: "c1", delta: "a" });
		await channel.sendDelta({
			channel: "mattermost",
			chatId: "c1",
			delta: "b",
			streamEnd: true,
			event: new StreamEndEvent({ streamId: "s" }),
		});
		expect(calls[0]!.url).toContain("/api/v4/posts");
		expect(calls[0]!.init.method).toBe("POST");
		expect(calls[1]!.init.method).toBe("PUT");
		expect(calls[1]!.url).toContain("/api/v4/posts/p1");
	});

	it("matrix sends then edits via m.replace", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const bus = new MessageBus();
		const channel = new MatrixChannel(
			{ homeserver: "https://matrix.example", accessToken: "tok", userId: "@bot:x", allowFrom: ["*"] },
			bus,
			{
				fetchFn: async (url, init) => {
					calls.push({ url: String(url), init: init ?? {} });
					return jsonResponse({ event_id: "e1" });
				},
			},
		);
		await channel.sendDelta({ channel: "matrix", chatId: "!room:x", delta: "x" });
		await channel.sendDelta({ channel: "matrix", chatId: "!room:x", delta: "y" });
		expect(calls[1]!.init.method).toBe("PUT");
		const body = JSON.parse(String(calls[1]!.init.body)) as {
			"m.relates_to"?: { rel_type?: string; event_id?: string };
		};
		expect(body["m.relates_to"]).toMatchObject({ rel_type: "m.replace", event_id: "e1" });
	});
});
