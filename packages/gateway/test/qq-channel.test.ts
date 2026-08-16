import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { QqOfficialChannel } from "../src/channels/qq.ts";
import type { WsLike } from "../src/channels/ws-common.ts";
import type { OutboundMessage } from "../src/types.ts";

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
	return { ok: status < 400, status, text: async () => JSON.stringify(data), json: async () => data } as Response;
}

function makeFetch(restLog: Array<{ url: string; body?: unknown }>) {
	return vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const u = String(url);
		if (u.endsWith("/gateway")) return jsonResponse({ url: "wss://qq-gateway.example" });
		restLog.push({ url: u, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
		return jsonResponse({ id: "send-1" });
	});
}

async function startQq(fetchFn: typeof fetch) {
	const ws = new FakeWs();
	const bus = new MessageBus();
	const channel = new QqOfficialChannel({ appId: "app-1", token: "tok", allowFrom: ["*"] }, bus, {
		socket: ws,
		fetchFn,
	});
	await channel.start();
	running.push(async () => void channel.stop());
	await vi.waitFor(() => expect(ws.url).toContain("wss://qq-gateway.example"), { timeout: 2000 });
	ws.emit(JSON.stringify({ op: 10, d: { hello: { heartbeat_interval: 40000 } } }));
	const identify = JSON.parse(ws.sent[0]!) as { op: number; d: { token: string; intents: number } };
	expect(identify.op).toBe(2);
	expect(identify.d.token).toBe("Bot app-1.tok");
	expect(identify.d.intents).toBe(1 << 25);
	return { bus, channel, ws };
}

describe("QqChannel", () => {
	it("normalizes C2C messages", async () => {
		const { bus, ws } = await startQq(makeFetch([]));
		ws.emit(
			JSON.stringify({
				op: 0,
				s: 1,
				t: "C2C_MESSAGE_CREATE",
				d: {
					id: "m-1",
					content: "hello qq",
					author: { user_openid: "user-1" },
				},
			}),
		);
		const inbound = await bus.consumeInbound();
		expect(inbound).toMatchObject({
			channel: "qqofficial",
			senderId: "user-1",
			chatId: "user-1",
			content: "hello qq",
			isDm: true,
		});
		expect(inbound.metadata).toMatchObject({ chatType: "c2c" });
	});

	it("normalizes group at-messages and strips mentions", async () => {
		const { bus, ws } = await startQq(makeFetch([]));
		ws.emit(
			JSON.stringify({
				op: 0,
				s: 2,
				t: "GROUP_AT_MESSAGE_CREATE",
				d: {
					id: "m-2",
					content: "<@!12345> hi group",
					author: { member_openid: "member-1" },
					group_openid: "group:g1",
				},
			}),
		);
		const inbound = await bus.consumeInbound();
		expect(inbound.content).toBe("hi group");
		expect(inbound.chatId).toBe("group:g1");
		expect(inbound.senderId).toBe("member-1");
		expect(inbound.isDm).toBe(false);
	});

	it("dedupes redelivered message ids", async () => {
		const { bus, ws } = await startQq(makeFetch([]));
		ws.emit(
			JSON.stringify({
				op: 0,
				s: 3,
				t: "C2C_MESSAGE_CREATE",
				d: { id: "m-1", content: "hello qq", author: { user_openid: "user-1" } },
			}),
		);
		await bus.consumeInbound();
		ws.emit(
			JSON.stringify({
				op: 0,
				s: 4,
				t: "C2C_MESSAGE_CREATE",
				d: { id: "m-1", content: "hello qq", author: { user_openid: "user-1" } },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(bus.inboundSize).toBe(0);
	});

	it("sends c2c replies to /v2/users and group replies to /v2/groups", async () => {
		const restLog: Array<{ url: string; body?: unknown }> = [];
		const { channel } = await startQq(makeFetch(restLog));
		await channel.send({
			channel: "qqofficial",
			chatId: "user-1",
			content: "reply",
			replyTo: "m-1",
		} as OutboundMessage);
		expect(restLog[0]!.url).toBe("https://api.sgroup.qq.com/v2/users/user-1/messages");
		expect(restLog[0]!.body).toMatchObject({ content: "reply", msg_type: 0, msg_id: "m-1" });

		await channel.send({ channel: "qqofficial", chatId: "group:g1", content: "g reply" } as OutboundMessage);
		expect(restLog[1]!.url).toBe("https://api.sgroup.qq.com/v2/groups/g1/messages");
	});

	it("downloads inbound attachments as multimodal images", async () => {
		const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
		const fetchFn = vi.fn(async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
			const u = String(url);
			if (u.endsWith("/gateway")) return jsonResponse({ url: "wss://qq-gateway.example" });
			return {
				ok: true,
				status: 200,
				arrayBuffer: async () => png.buffer,
				json: async () => ({}),
				text: async () => "",
			} as Response;
		});
		const ws = new FakeWs();
		const bus = new MessageBus();
		const channel = new QqOfficialChannel({ appId: "app-1", token: "tok", allowFrom: ["*"] }, bus, {
			socket: ws,
			fetchFn,
		});
		await channel.start();
		running.push(async () => void channel.stop());
		await vi.waitFor(() => expect(ws.url).toContain("wss://qq-gateway.example"), { timeout: 2000 });
		ws.emit(JSON.stringify({ op: 10, d: { hello: { heartbeat_interval: 40000 } } }));
		const inbound = bus.consumeInbound();
		ws.emit(
			JSON.stringify({
				op: 0,
				s: 5,
				t: "C2C_MESSAGE_CREATE",
				d: {
					id: "m-3",
					content: "pic",
					author: { user_openid: "user-1" },
					attachments: [{ url: "https://cdn.example/pic.png", content_type: "image/png" }],
				},
			}),
		);
		const received = await inbound;
		expect(received.images).toHaveLength(1);
		expect(received.images?.[0]?.mimeType).toBe("image/png");
	});
});
