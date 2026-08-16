import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { DingtalkChannel } from "../src/channels/dingtalk.ts";
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

function dataFrame(payload: Record<string, unknown>): string {
	return JSON.stringify({
		type: "data",
		headers: { topic: "chatbot", messageId: "dm-1" },
		body: Buffer.from(JSON.stringify(payload)).toString("base64"),
	});
}

async function startDingtalk(restLog: Array<{ url: string; body?: unknown }>) {
	const ws = new FakeWs();
	const bus = new MessageBus();
	const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const u = String(url);
		if (u.includes("/v1.0/gateway/connections/open")) {
			return jsonResponse({ url: "wss://dingtalk-gateway.example" });
		}
		if (u.includes("oapi.dingtalk.com/gettoken")) {
			return jsonResponse({ errcode: 0, access_token: "tok-1", expires_in: 7200 });
		}
		restLog.push({ url: u, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
		return jsonResponse({});
	});
	const channel = new DingtalkChannel({ clientId: "ding-1", clientSecret: "secret", allowFrom: ["*"] }, bus, {
		socket: ws,
		fetchFn: fetchFn as unknown as typeof fetch,
	});
	await channel.start();
	running.push(async () => void channel.stop());
	await vi.waitFor(() => expect(ws.url).toContain("wss://dingtalk-gateway.example"), { timeout: 2000 });
	const register = JSON.parse(ws.sent.find((text) => text.includes('"register"'))!) as {
		type: string;
		headers: { topic: string };
	};
	expect(register.type).toBe("register");
	expect(register.headers.topic).toBe("chatbot");
	return { bus, channel, ws };
}

describe("DingtalkChannel", () => {
	it("answers pings with pongs", async () => {
		const { ws } = await startDingtalk([]);
		ws.emit(JSON.stringify({ type: "ping" }));
		await vi.waitFor(() => expect(ws.sent.some((text) => text.includes('"pong"'))).toBe(true), { timeout: 2000 });
	});

	it("normalizes single-chat text messages", async () => {
		const { bus, ws } = await startDingtalk([]);
		ws.emit(
			dataFrame({
				msgtype: "text",
				text: { content: "你好钉钉" },
				senderStaffId: "staff-1",
				senderNick: "张三",
				conversationId: "cid-1",
				conversationType: "1",
				msgId: "msg-1",
			}),
		);
		const inbound = await bus.consumeInbound();
		expect(inbound).toMatchObject({
			channel: "dingtalk",
			senderId: "staff-1",
			chatId: "cid-1",
			content: "你好钉钉",
			isDm: true,
		});
		expect(inbound.metadata).toMatchObject({ senderNick: "张三", conversationType: "1" });
	});

	it("normalizes group messages and strips @ mentions", async () => {
		const { bus, ws } = await startDingtalk([]);
		ws.emit(
			dataFrame({
				msgtype: "text",
				text: { content: "@张三 @机器人 hi group" },
				senderStaffId: "staff-1",
				conversationId: "cid:group-1",
				conversationType: "2",
				msgId: "msg-2",
			}),
		);
		const inbound = await bus.consumeInbound();
		expect(inbound.content).toBe("hi group");
		expect(inbound.isDm).toBe(false);
		expect(inbound.chatId).toBe("cid:group-1");
	});

	it("dedupes redelivered message ids", async () => {
		const { bus, ws } = await startDingtalk([]);
		const frame = dataFrame({
			msgtype: "text",
			text: { content: "again" },
			senderStaffId: "staff-1",
			conversationId: "cid-1",
			conversationType: "1",
			msgId: "msg-1",
		});
		ws.emit(frame);
		await bus.consumeInbound();
		ws.emit(frame);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(bus.inboundSize).toBe(0);
	});

	it("sends group replies via robot groupMessages/send", async () => {
		const restLog: Array<{ url: string; body?: unknown }> = [];
		const { channel } = await startDingtalk(restLog);
		await channel.send({ channel: "dingtalk", chatId: "group:cid:g1", content: "g reply" } as OutboundMessage);
		expect(restLog[0]!.url).toBe("https://api.dingtalk.com/v1.0/robot/groupMessages/send");
		expect(restLog[0]!.body).toMatchObject({
			robotCode: "ding-1",
			openConversationId: "cid:g1",
			msgKey: "sampleText",
			msgParam: JSON.stringify({ content: "g reply" }),
		});
	});

	it("sends single-chat replies via robot/oToMessages/batchSend", async () => {
		const restLog: Array<{ url: string; body?: unknown }> = [];
		const { channel } = await startDingtalk(restLog);
		await channel.send({ channel: "dingtalk", chatId: "staff-1", content: "dm reply" } as OutboundMessage);
		expect(restLog[0]!.url).toBe("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend");
		expect(restLog[0]!.body).toMatchObject({ robotCode: "ding-1", userIds: ["staff-1"], msgKey: "sampleText" });
	});
});
