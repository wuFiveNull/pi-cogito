import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { ChannelContextScope } from "../src/channels/context.ts";
import { DiscordChannel } from "../src/channels/discord.ts";
import { encodeFeishuFrame, FeishuChannel } from "../src/channels/feishu.ts";
import { OneBotChannel, type OneBotSocket } from "../src/channels/onebot.ts";
import { SlackChannel } from "../src/channels/slack.ts";
import type { WsLike } from "../src/channels/ws-common.ts";
import { FileChannelOffsetStore } from "../src/state.ts";

const temporaryDirectories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class FakeWs implements WsLike {
	url = "";
	sent: string[] = [];
	binarySent: Uint8Array[] = [];
	private messageHandler: ((text: string) => void) | undefined;
	private binaryHandler: ((data: Uint8Array) => void) | undefined;
	private closeHandler: (() => void) | undefined;

	async connect(url: string): Promise<void> {
		this.url = url;
	}

	send(text: string): void {
		this.sent.push(text);
	}

	sendBinary(data: Uint8Array): void {
		this.binarySent.push(data);
	}

	onMessage(handler: (text: string) => void): void {
		this.messageHandler = handler;
	}

	onBinary(handler: (data: Uint8Array) => void): void {
		this.binaryHandler = handler;
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

	emitBinary(data: Uint8Array): void {
		this.binaryHandler?.(data);
	}

	disconnect(): void {
		this.closeHandler?.();
	}
}

class FakeOneBotSocket implements OneBotSocket {
	private eventHandler: ((event: Record<string, unknown>) => void) | undefined;
	private closeHandler: (() => void) | undefined;

	async connect(_url: string): Promise<void> {}

	async sendAction(_action: string, _params: Record<string, unknown>): Promise<unknown> {
		return { status: "ok" };
	}

	onEvent(handler: (event: Record<string, unknown>) => void): void {
		this.eventHandler = handler;
	}

	onClose(handler: () => void): void {
		this.closeHandler = handler;
	}

	close(): void {
		this.closeHandler?.();
	}

	emit(event: Record<string, unknown>): void {
		this.eventHandler?.(event);
	}
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function statePath(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return join(directory, "offsets.json");
}

describe("provider resume state", () => {
	it("persists Slack Socket Mode envelope cursors after acceptance", async () => {
		const ws = new FakeWs();
		const store = new FileChannelOffsetStore(statePath("gateway-slack-resume-"));
		const bus = new MessageBus();
		const channel = new SlackChannel({ appToken: "xapp", allowFrom: ["*"] }, bus, {
			socket: ws,
			fetchFn: async () => jsonResponse({ ok: true, url: "wss://slack.example" }),
		});
		await channel.start(new ChannelContextScope(bus, { offsetStore: store }));
		cleanups.push(async () => channel.stop());
		await vi.waitFor(() => expect(ws.url).toBe("wss://slack.example"), { timeout: 1000 });
		ws.emit(
			JSON.stringify({
				type: "events_api",
				envelope_id: "env-1",
				payload: { event: { type: "message", event_id: "evt-1", channel: "C1", user: "U1", text: "hello" } },
			}),
		);
		await vi.waitFor(() => expect(store.get("slack", "envelopeId")).toBe("env-1"), { timeout: 1000 });
		await expect(store.get("slack", "eventId")).toBe("evt-1");
	});

	it("resumes Discord with the persisted gateway session and sequence", async () => {
		const ws = new FakeWs();
		const store = new FileChannelOffsetStore(statePath("gateway-discord-resume-"));
		store.set("discord", "sessionId", "session-1");
		store.set("discord", "resumeGatewayUrl", "wss://resume.example");
		store.set("discord", "sequence", "42");
		const bus = new MessageBus();
		const channel = new DiscordChannel({ token: "discord-token", allowFrom: ["*"] }, bus, {
			socket: ws,
			fetchFn: async () => {
				throw new Error("fresh gateway lookup should not be used when resume state exists");
			},
		});
		await channel.start(new ChannelContextScope(bus, { offsetStore: store }));
		cleanups.push(async () => channel.stop());
		await vi.waitFor(() => expect(ws.url).toContain("wss://resume.example"), { timeout: 1000 });
		ws.emit(JSON.stringify({ op: 10, d: { heartbeat_interval: 100000 } }));
		await vi.waitFor(() => expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({ op: 6 }), { timeout: 1000 });
		expect(JSON.parse(ws.sent[0]!).d).toMatchObject({ session_id: "session-1", seq: 42 });
	});

	it("persists Feishu event ids after the frame is accepted", async () => {
		const ws = new FakeWs();
		const store = new FileChannelOffsetStore(statePath("gateway-feishu-resume-"));
		const bus = new MessageBus();
		const channel = new FeishuChannel({ appId: "app", appSecret: "secret", allowFrom: ["*"] }, bus, {
			socket: ws,
			fetchFn: async (url) =>
				String(url).includes("callback/ws/endpoint")
					? jsonResponse({ code: 0, data: { URL: "wss://feishu.example?service_id=1" } })
					: jsonResponse({ code: 0, tenant_access_token: "token", expire: 3600 }),
		});
		await channel.start(new ChannelContextScope(bus, { offsetStore: store }));
		cleanups.push(async () => channel.stop());
		await vi.waitFor(() => expect(ws.url).toContain("feishu.example"), { timeout: 1000 });
		const event = {
			header: { event_type: "im.message.receive_v1", event_id: "feishu-event-1" },
			event: {
				sender: { sender_id: { open_id: "user-1" } },
				message: {
					message_id: "om-1",
					chat_id: "chat-1",
					chat_type: "p2p",
					message_type: "text",
					content: JSON.stringify({ text: "hi" }),
				},
			},
		};
		ws.emitBinary(
			encodeFeishuFrame({
				SeqID: 1,
				LogID: 1,
				service: 1,
				method: 1,
				headers: [
					["type", "event"],
					["message_id", "frame-1"],
				],
				payload: Buffer.from(JSON.stringify(event)),
			}),
		);
		await vi.waitFor(() => expect(store.get("feishu", "eventId")).toBe("feishu-event-1"), { timeout: 1000 });
	});

	it("persists OneBot message ids across reconnects", async () => {
		const socket = new FakeOneBotSocket();
		const store = new FileChannelOffsetStore(statePath("gateway-onebot-resume-"));
		const bus = new MessageBus();
		const channel = new OneBotChannel({ wsUrl: "ws://127.0.0.1:6700", allowFrom: ["*"] }, bus, { socket });
		await channel.start(new ChannelContextScope(bus, { offsetStore: store }));
		cleanups.push(async () => channel.stop());
		socket.emit({ post_type: "message", message_type: "private", user_id: 1, message_id: 7, message: "hello" });
		await vi.waitFor(() => expect(store.get("onebot", "messageId")).toBe("7"), { timeout: 1000 });
	});
});
