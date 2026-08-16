import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { MochatChannel } from "../src/channels/mochat.ts";
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

async function startMochat(restLog: Array<{ url: string; body?: unknown }> = []) {
	const ws = new FakeWs();
	const bus = new MessageBus();
	const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		restLog.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
		return jsonResponse({ code: 200, data: {} });
	});
	const channel = new MochatChannel(
		{
			baseUrl: "https://mochat.example",
			clawToken: "tok-1",
			sessions: ["session-1"],
			panels: ["panel-1"],
			agentUserId: "bot-1",
			allowFrom: ["*"],
		},
		bus,
		{ socket: ws, fetchFn: fetchFn as unknown as typeof fetch },
	);
	await channel.start();
	running.push(async () => void channel.stop());
	await vi.waitFor(() => expect(ws.url).toContain("EIO=4"), { timeout: 2000 });
	return { bus, channel, ws };
}

describe("MochatChannel", () => {
	it("connects with auth and subscribes to sessions and panels", async () => {
		const { ws } = await startMochat();
		// Engine.IO open -> socket.io connect with auth.
		ws.emit('0{"sid":"x"}');
		await vi.waitFor(() => expect(ws.sent.some((text) => text.startsWith('40{"token":"tok-1"}'))).toBe(true), {
			timeout: 2000,
		});
		// Connected -> subscribe acks.
		ws.emit('40{"sid":"x"}');
		await vi.waitFor(() => expect(ws.sent.some((text) => text.includes("subscribeSessions"))).toBe(true), {
			timeout: 2000,
		});
		const subscribe = ws.sent.find((text) => text.includes("subscribeSessions"))!;
		expect(subscribe).toMatch(/^421\d+\["com\.claw\.im\.subscribeSessions"/);
		expect(JSON.parse(subscribe.slice(subscribe.indexOf("[")))[1]).toMatchObject({
			sessionIds: ["session-1"],
			limit: 20,
		});
		// Ack the sessions subscribe (ack id 1); the panel subscribe follows.
		ws.emit('431[{"result":true}]');
		await vi.waitFor(() => expect(ws.sent.some((text) => text.includes("subscribePanels"))).toBe(true), {
			timeout: 2000,
		});
	});

	it("answers engine.io pings with pongs", async () => {
		const { ws } = await startMochat();
		ws.emit("2");
		await vi.waitFor(() => expect(ws.sent.includes("3")).toBe(true), { timeout: 2000 });
	});

	it("normalizes session watch events", async () => {
		const { bus, ws } = await startMochat();
		ws.emit(
			'42["claw.session.events",{"sessionId":"session-1","cursor":5,"events":[{"type":"message.add","seq":5,"payload":{"author":"user-9","messageId":"m-1","content":"hello mochat","createdAt":1700000000000}}]}]',
		);
		const inbound = await bus.consumeInbound();
		expect(inbound).toMatchObject({
			channel: "mochat",
			senderId: "user-9",
			chatId: "session-1",
			content: "hello mochat",
			isDm: true,
		});
		expect(inbound.metadata).toMatchObject({ source: "watch" });
	});

	it("normalizes panel events and skips the agent's own messages", async () => {
		const { bus, ws } = await startMochat();
		ws.emit(
			'42["claw.panel.events",{"sessionId":"panel-1","events":[{"type":"message.add","payload":{"author":"bot-1","messageId":"m-self","content":"self"}},{"type":"message.add","payload":{"author":"user-9","messageId":"m-2","content":"panel hi"}}]}]',
		);
		const inbound = await bus.consumeInbound();
		expect(inbound.content).toBe("panel hi");
		expect(inbound.isDm).toBe(false);
	});

	it("handles notify:chat.inbox.append for DMs", async () => {
		const { bus, ws } = await startMochat();
		ws.emit(
			'42["notify:chat.inbox.append",{"type":"message","payload":{"converseId":"session-2","messageId":"m-3","messageAuthor":"user-9","messagePlainContent":"inbox hi"}}]',
		);
		const inbound = await bus.consumeInbound();
		expect(inbound.content).toBe("inbox hi");
		expect(inbound.chatId).toBe("session-2");
	});

	it("dedupes redelivered message ids", async () => {
		const { bus, ws } = await startMochat();
		const packet =
			'42["claw.session.events",{"sessionId":"session-1","events":[{"type":"message.add","payload":{"author":"user-9","messageId":"m-1","content":"again"}}]}]';
		ws.emit(packet);
		await bus.consumeInbound();
		ws.emit(packet);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(bus.inboundSize).toBe(0);
	});

	it("sends replies via the sessions HTTP API", async () => {
		const restLog: Array<{ url: string; body?: unknown }> = [];
		const { channel } = await startMochat(restLog);
		await channel.send({
			channel: "mochat",
			chatId: "session-1",
			content: "reply",
			replyTo: "m-1",
		} as OutboundMessage);
		expect(restLog[0]!.url).toBe("https://mochat.example/api/claw/sessions/send");
		expect(restLog[0]!.body).toMatchObject({ sessionId: "session-1", content: "reply", replyTo: "m-1" });
	});

	it("routes panel targets to the panels API", async () => {
		const restLog: Array<{ url: string; body?: unknown }> = [];
		const { channel } = await startMochat(restLog);
		await channel.send({ channel: "mochat", chatId: "panel-1", content: "p" } as OutboundMessage);
		expect(restLog[0]!.url).toBe("https://mochat.example/api/claw/groups/panels/send");
		expect(restLog[0]!.body).toMatchObject({ panelId: "panel-1" });
	});
});
