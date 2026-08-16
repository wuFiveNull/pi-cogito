import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { SignalChannel } from "../src/channels/signal.ts";
import type { OutboundMessage } from "../src/types.ts";

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of running.splice(0)) await cleanup();
});

interface RestLogEntry {
	method: string | undefined;
	url: string;
	body?: Record<string, unknown>;
}

function sseResponse(events: string[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`data: ${event}\n\n`));
			}
			controller.close();
		},
	});
	return {
		ok: true,
		status: 200,
		body,
		json: async () => ({}),
		text: async () => "",
	} as Response;
}

function makeDaemon({ events }: { events?: string[] } = {}) {
	const log: RestLogEntry[] = [];
	const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const u = String(url);
		const method = init?.method ?? "GET";
		log.push({
			method,
			url: u,
			body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
		});
		if (u.endsWith("/api/v1/check")) return { ok: true, status: 200, json: async () => ({}) } as Response;
		if (u.endsWith("/api/v1/events")) return sseResponse(events ?? []);
		if (u.endsWith("/api/v1/send")) {
			return {
				ok: true,
				status: 200,
				json: async () => ({ result: { timestamp: 123 } }),
			} as Response;
		}
		return { ok: true, status: 200, json: async () => ({}) } as Response;
	});
	return { fetchFn, log };
}

function envelope(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		envelope: {
			sourceNumber: "+15551234567",
			timestamp: 1700000000000,
			dataMessage: { message: "hello signal", attachments: [] },
			...overrides,
		},
	});
}

describe("SignalChannel", () => {
	it("receives DM messages over SSE and normalizes them", async () => {
		const { fetchFn } = makeDaemon({ events: [envelope()] });
		const bus = new MessageBus();
		const channel = new SignalChannel({ phoneNumber: "+15550000000", allowFrom: ["*"], reconnectDelayMs: 50 }, bus, {
			fetchFn,
		});
		await channel.start();
		running.push(async () => void channel.stop());
		const inbound = await bus.consumeInbound();
		expect(inbound).toMatchObject({
			channel: "signal",
			chatId: "+15551234567",
			content: "hello signal",
			isDm: true,
		});
		expect(inbound.metadata).toMatchObject({ chatType: "private" });
	});

	it("routes group messages to the group chat and marks chatType group", async () => {
		const { fetchFn } = makeDaemon({
			events: [
				envelope({
					sourceNumber: "+15551234567",
					dataMessage: {
						message: "group hi",
						groupInfo: { groupId: "Z3JvdXA=" },
						attachments: [],
					},
				}),
			],
		});
		const bus = new MessageBus();
		const channel = new SignalChannel({ phoneNumber: "+15550000000", allowFrom: ["*"], reconnectDelayMs: 50 }, bus, {
			fetchFn,
		});
		await channel.start();
		running.push(async () => void channel.stop());
		const inbound = await bus.consumeInbound();
		expect(inbound.chatId).toBe("group:Z3JvdXA=");
		expect(inbound.metadata).toMatchObject({ chatType: "group", groupId: "Z3JvdXA=" });
		expect(inbound.isDm).toBe(false);
	});

	it("ignores receipts, typing and sync messages", async () => {
		const { fetchFn } = makeDaemon({
			events: [
				JSON.stringify({ envelope: { sourceNumber: "+15551234567", receiptMessage: { delivery: {} } } }),
				JSON.stringify({ envelope: { sourceNumber: "+15551234567", typingMessage: { action: 0 } } }),
				JSON.stringify({
					envelope: {
						sourceNumber: "+15551234567",
						syncMessage: { sentMessage: { message: "from other device" } },
					},
				}),
			],
		});
		const bus = new MessageBus();
		const channel = new SignalChannel({ phoneNumber: "+15550000000", allowFrom: ["*"], reconnectDelayMs: 50 }, bus, {
			fetchFn,
		});
		await channel.start();
		running.push(async () => void channel.stop());
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(bus.inboundSize).toBe(0);
	});

	it("sends replies via /api/v1/send with the recipient list", async () => {
		const { fetchFn, log } = makeDaemon({ events: [envelope()] });
		const bus = new MessageBus();
		const channel = new SignalChannel({ phoneNumber: "+15550000000", allowFrom: ["*"], reconnectDelayMs: 50 }, bus, {
			fetchFn,
		});
		await channel.start();
		running.push(async () => void channel.stop());
		await bus.consumeInbound();
		await channel.send({ channel: "signal", chatId: "+15551234567", content: "reply" } as OutboundMessage);
		const send = log.find((entry) => entry.url.endsWith("/api/v1/send"));
		expect(send).toBeDefined();
		expect(send!.body).toMatchObject({ message: "reply", recipient: ["+15551234567"] });
	});

	it("sends to groups via groupId and splits long messages", async () => {
		const { fetchFn, log } = makeDaemon();
		const bus = new MessageBus();
		const channel = new SignalChannel({ phoneNumber: "+15550000000", allowFrom: ["*"], reconnectDelayMs: 50 }, bus, {
			fetchFn,
		});
		await channel.start();
		running.push(async () => void channel.stop());
		const long = "x".repeat(4500);
		await channel.send({ channel: "signal", chatId: "group:Z3JvdXA=", content: long } as OutboundMessage);
		const sends = log.filter((entry) => entry.url.endsWith("/api/v1/send"));
		expect(sends).toHaveLength(3);
		expect(sends[0]!.body).toMatchObject({ groupId: "Z3JvdXA=" });
	});

	it("starts a typing loop on accepted messages and stops it after the reply", async () => {
		const { fetchFn, log } = makeDaemon({ events: [envelope()] });
		const bus = new MessageBus();
		const channel = new SignalChannel(
			{ phoneNumber: "+15550000000", allowFrom: ["*"], reconnectDelayMs: 50, showTyping: true },
			bus,
			{ fetchFn },
		);
		await channel.start();
		running.push(async () => void channel.stop());
		await bus.consumeInbound();
		await vi.waitFor(() => expect(log.some((entry) => entry.url.endsWith("/api/v1/typing"))).toBe(true), {
			timeout: 2000,
		});
		const typing = log.find((entry) => entry.url.endsWith("/api/v1/typing"))!;
		expect(typing.body).toMatchObject({ recipient: ["+15551234567"], typing: true });
		await channel.send({ channel: "signal", chatId: "+15551234567", content: "done" } as OutboundMessage);
		await vi.waitFor(
			() =>
				expect(log.some((entry) => entry.url.endsWith("/api/v1/typing") && entry.body?.typing === false)).toBe(
					true,
				),
			{ timeout: 2000 },
		);
	});

	it("surfaces unsupported outbound media as a note without sending", async () => {
		const { fetchFn, log } = makeDaemon();
		const bus = new MessageBus();
		const channel = new SignalChannel({ phoneNumber: "+15550000000", allowFrom: ["*"], reconnectDelayMs: 50 }, bus, {
			fetchFn,
		});
		await channel.start();
		running.push(async () => void channel.stop());
		await channel.send({
			channel: "signal",
			chatId: "+15551234567",
			content: "text",
			media: ["/tmp/pic.png"],
		} as OutboundMessage);
		const send = log.find((entry) => entry.url.endsWith("/api/v1/send"));
		expect(send!.body).toMatchObject({ message: expect.stringContaining("附件发送失败") });
	});
});
