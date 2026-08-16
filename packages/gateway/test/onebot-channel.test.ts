import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAgent } from "../src/agent.ts";
import { MessageBus } from "../src/bus.ts";
import { OutboundDispatcher } from "../src/channels/dispatcher.ts";
import { OneBotChannel, type OneBotSocket } from "../src/channels/onebot.ts";

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of running.splice(0)) await cleanup();
});

class FakeOneBotSocket implements OneBotSocket {
	eventHandler: ((event: Record<string, unknown>) => void) | undefined;
	closeHandler: (() => void) | undefined;
	connected = false;
	connectHeaders: Record<string, string> | undefined;
	actions: Array<{ action: string; params: Record<string, unknown> }> = [];
	actionResults = new Map<string, unknown>();

	async connect(_url: string, headers: Record<string, string> = {}): Promise<void> {
		this.connected = true;
		this.connectHeaders = headers;
	}

	async sendAction(action: string, params: Record<string, unknown>): Promise<unknown> {
		this.actions.push({ action, params });
		return this.actionResults.get(action) ?? { status: "ok" };
	}

	onEvent(handler: (event: Record<string, unknown>) => void): void {
		this.eventHandler = handler;
	}

	onClose(handler: () => void): void {
		this.closeHandler = handler;
	}

	close(): void {
		this.connected = false;
	}

	/** Simulate an incoming OneBot message event. */
	emit(event: Record<string, unknown>): void {
		this.eventHandler?.(event);
	}
}

async function startOneBot(socket: FakeOneBotSocket, options: { fetchFn?: typeof fetch } = {}) {
	const bus = new MessageBus();
	const channel = new OneBotChannel({ wsUrl: "ws://127.0.0.1:6700", allowFrom: ["*"], reconnectDelayMs: 20 }, bus, {
		socket,
		...options,
	});
	await channel.start();
	const dispatcher = new OutboundDispatcher(bus, {
		get: (name: string) => (name === "onebot" ? channel : undefined),
	});
	dispatcher.start();
	running.push(async () => {
		dispatcher.stop();
		await channel.stop();
	});
	return { bus, channel };
}

describe("OneBotChannel", () => {
	it("sends the configured access token during the WebSocket handshake", async () => {
		const socket = new FakeOneBotSocket();
		const bus = new MessageBus();
		const channel = new OneBotChannel(
			{ wsUrl: "wss://onebot.example/ws", allowFrom: ["*"], accessToken: "test-access-token" },
			bus,
			{ socket },
		);
		await channel.start();
		running.push(async () => channel.stop());

		expect(socket.connectHeaders).toEqual({ Authorization: "Bearer test-access-token" });
		expect(channel.isReady).toBe(true);
	});

	it("normalizes group messages and sends group replies", async () => {
		const socket = new FakeOneBotSocket();
		const { bus } = await startOneBot(socket);
		const agent = new FakeAgent(bus);
		agent.start();

		socket.emit({
			post_type: "message",
			message_type: "group",
			user_id: 10001,
			group_id: 888888,
			message_id: 555,
			message: [{ type: "text", data: { text: "群消息" } }],
		});

		await vi.waitFor(() => expect(socket.actions.length).toBe(1), { timeout: 3000, interval: 10 });
		expect(socket.actions[0]).toMatchObject({
			action: "send_group_msg",
			params: { group_id: 888888, message: "[onebot] 收到: 群消息" },
		});
		agent.stop();
	});

	it("normalizes private messages and sends private replies", async () => {
		const socket = new FakeOneBotSocket();
		const { bus } = await startOneBot(socket);
		const agent = new FakeAgent(bus);
		agent.start();

		socket.emit({
			post_type: "message",
			message_type: "private",
			user_id: 10001,
			message_id: 556,
			message: "私聊文本",
		});

		await vi.waitFor(() => expect(socket.actions.length).toBe(1), { timeout: 3000, interval: 10 });
		expect(socket.actions[0]).toMatchObject({
			action: "send_private_msg",
			params: { user_id: 10001, message: "[onebot] 收到: 私聊文本" },
		});
		agent.stop();
	});

	it("sends outbound media as image segments before text", async () => {
		const socket = new FakeOneBotSocket();
		const { channel } = await startOneBot(socket);
		await channel.send({
			channel: "onebot",
			chatId: "user:10001",
			content: "看图",
			media: ["https://cdn.example/a.png"],
		});
		expect(socket.actions[0]).toMatchObject({
			action: "send_private_msg",
			params: {
				user_id: 10001,
				message: [
					{ type: "image", data: { file: "https://cdn.example/a.png" } },
					{ type: "text", data: { text: "看图" } },
				],
			},
		});
	});

	it("keeps a plain-text payload when no media is present", async () => {
		const socket = new FakeOneBotSocket();
		const { channel } = await startOneBot(socket);
		await channel.send({ channel: "onebot", chatId: "user:10001", content: "hello" });
		expect(socket.actions[0]).toMatchObject({
			action: "send_private_msg",
			params: { user_id: 10001, message: "hello" },
		});
	});

	it("drops missing local media files and still sends text", async () => {
		const socket = new FakeOneBotSocket();
		const { channel } = await startOneBot(socket);
		await channel.send({
			channel: "onebot",
			chatId: "user:10001",
			content: "hi",
			media: ["/nonexistent/x.png"],
		});
		expect(socket.actions[0]).toMatchObject({
			action: "send_private_msg",
			params: { user_id: 10001, message: "hi" },
		});
	});

	it("normalizes QQ image segments into inbound image attachments", async () => {
		const socket = new FakeOneBotSocket();
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
		socket.actionResults.set("get_image", { url: "https://cdn.example/fallback.jpg" });
		const { bus } = await startOneBot(socket, {
			fetchFn: async (url) => {
				const data = String(url).endsWith("fallback.jpg") ? jpeg : png;
				return {
					ok: true,
					status: 200,
					headers: { get: () => (data === jpeg ? "image/jpeg" : "image/png") },
					arrayBuffer: async () => data,
				} as unknown as Response;
			},
		});

		socket.emit({
			post_type: "message",
			message_type: "private",
			user_id: 10001,
			message_id: 557,
			message: [
				{ type: "text", data: { text: "请看" } },
				{ type: "image", data: { url: "https://cdn.example/direct.png" } },
				{ type: "image", data: { file: "napcat-file-id" } },
			],
		});

		const inbound = await bus.consumeInbound();
		expect(inbound).toMatchObject({
			content: "请看",
			images: [
				{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
				{ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
			],
		});
		expect(socket.actions).toContainEqual({ action: "get_image", params: { file: "napcat-file-id" } });
	});

	it("normalizes CQ image strings with inline base64", async () => {
		const socket = new FakeOneBotSocket();
		const { bus } = await startOneBot(socket);
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

		socket.emit({
			post_type: "message",
			message_type: "private",
			user_id: 10001,
			message: `看图[CQ:image,file=base64://${png.toString("base64")}]`,
		});

		const inbound = await bus.consumeInbound();
		expect(inbound.content).toBe("看图");
		expect(inbound.images).toEqual([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
	});

	it("ignores non-message events", async () => {
		const socket = new FakeOneBotSocket();
		const { bus } = await startOneBot(socket);
		const agent = new FakeAgent(bus);
		agent.start();

		socket.emit({ post_type: "notice", notice_type: "group_increase" });
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(socket.actions.length).toBe(0);
		agent.stop();
	});

	it("reconnects after the socket closes", async () => {
		const socket = new FakeOneBotSocket();
		const { channel } = await startOneBot(socket);
		expect(socket.connected).toBe(true);

		// Simulate a drop: the socket closes and the channel schedules a reconnect.
		socket.close();
		socket.closeHandler?.();
		expect(socket.connected).toBe(false);
		expect(channel.isReady).toBe(false);

		await vi.waitFor(() => expect(socket.connected).toBe(true), { timeout: 3000, interval: 20 });
		expect(channel.isReady).toBe(true);
		await channel.stop();
	});
});
