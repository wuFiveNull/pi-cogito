import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { ChannelContextScope } from "../src/channels/context.ts";
import { WeixinChannel } from "../src/channels/weixin.ts";
import { FileChannelOffsetStore } from "../src/state.ts";
import type { OutboundMessage } from "../src/types.ts";

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of running.splice(0)) await cleanup();
});

interface RestLogEntry {
	url: string;
	body?: unknown;
	headers?: Record<string, string>;
}

function makeApi(updates: Array<Record<string, unknown>> = []) {
	const log: RestLogEntry[] = [];
	let updatesCall = 0;
	const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const u = String(url);
		const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
		const headers = (init?.headers ?? {}) as Record<string, string>;
		log.push({ url: u, body, headers });
		if (u.endsWith("/ilink/bot/get_bot_qrcode")) {
			return jsonResponse({ ret: 0, data: { qrcode: "qr-1", qrcode_img_content: "https://weixin.example/scan" } });
		}
		if (u.endsWith("/ilink/bot/get_qrcode_status")) {
			return jsonResponse({ ret: 0, data: { token: "token-1" } });
		}
		if (u.endsWith("/ilink/bot/getupdates")) {
			const current = updates[Math.min(updatesCall, Math.max(0, updates.length - 1))];
			updatesCall++;
			return jsonResponse({ ret: 0, get_updates_buf: `buf-${updatesCall}`, msgs: current?.msgs ?? [] });
		}
		if (u.endsWith("/ilink/bot/sendmessage")) {
			return jsonResponse({ ret: 0 });
		}
		return jsonResponse({});
	});
	return { fetchFn, log };
}

function jsonResponse(data: unknown, status = 200) {
	return { ok: status < 400, status, text: async () => JSON.stringify(data), json: async () => data } as Response;
}

function textMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		message_type: 1,
		from_user_id: "user-1",
		msg_id: "msg-1",
		item_list: [{ type: 1, text_item: { text: "你好微信" } }],
		context_token: "ctx-1",
		...overrides,
	};
}

async function startWeixin(fetchFn: typeof fetch, config: Record<string, unknown> = {}) {
	const bus = new MessageBus();
	const channel = new WeixinChannel({ token: "token-1", allowFrom: ["*"], pollIntervalMs: 60000, ...config }, bus, {
		fetchFn,
	});
	await channel.start();
	running.push(async () => void channel.stop());
	return { bus, channel };
}

describe("WeixinChannel", () => {
	it("polls getupdates and normalizes inbound text messages", async () => {
		const { fetchFn, log } = makeApi([{ msgs: [textMsg()] }]);
		const { bus } = await startWeixin(fetchFn);
		const inbound = await bus.consumeInbound();
		expect(inbound).toMatchObject({
			channel: "weixin",
			senderId: "user-1",
			chatId: "user-1",
			content: "你好微信",
			isDm: true,
		});
		expect(log.some((entry) => entry.url.endsWith("/ilink/bot/getupdates"))).toBe(true);
		const updates = log.find((entry) => entry.url.endsWith("/ilink/bot/getupdates"))!;
		expect(updates.headers!.Authorization).toBe("Bearer token-1");
		expect(updates.headers!["iLink-App-ClientVersion"]).toBe("2.1.1");
	});

	it("skips the bot's own messages", async () => {
		const { fetchFn } = makeApi([{ msgs: [textMsg({ message_type: 2 })] }]);
		const { bus } = await startWeixin(fetchFn);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(bus.inboundSize).toBe(0);
	});

	it("sends replies via sendmessage with the context token", async () => {
		const { fetchFn, log } = makeApi([{ msgs: [textMsg()] }]);
		const { bus, channel } = await startWeixin(fetchFn);
		await bus.consumeInbound(); // Learns the context token for user-1.
		await channel.send({ channel: "weixin", chatId: "user-1", content: "reply" } as OutboundMessage);
		const send = log.find((entry) => entry.url.endsWith("/ilink/bot/sendmessage"))!;
		expect(send.body).toMatchObject({
			msg: {
				to_user_id: "user-1",
				message_type: 2,
				message_state: 2,
				context_token: "ctx-1",
				item_list: [{ type: 1, text_item: { text: "reply" } }],
			},
		});
	});

	it("logs in via QR code when no token is configured", async () => {
		const { fetchFn } = makeApi([]);
		const bus = new MessageBus();
		const store = new FileChannelOffsetStore(
			`${tmpdir()}/gateway-weixin-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
		);
		const channel = new WeixinChannel({ allowFrom: ["*"], pollIntervalMs: 60000 }, bus, { fetchFn });
		await channel.bindContext(new ChannelContextScope(bus, { offsetStore: store }));
		expect(await channel.login()).toBe(true);
		// Token was persisted and is reused by a fresh channel over the store.
		const channel2 = new WeixinChannel({ allowFrom: ["*"], pollIntervalMs: 60000 }, bus, { fetchFn });
		await channel2.bindContext(new ChannelContextScope(bus, { offsetStore: store }));
		await channel2.start();
		running.push(async () => void channel2.stop());
		// biome-ignore lint/complexity/useLiteralKeys: protected member access in tests
		expect(channel2["token"]).toBe("token-1");
	});

	it("does not poll before login", async () => {
		const { fetchFn, log } = makeApi([]);
		const bus = new MessageBus();
		const channel = new WeixinChannel({ allowFrom: ["*"], pollIntervalMs: 60000 }, bus, { fetchFn });
		await channel.start();
		running.push(async () => void channel.stop());
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(log.some((entry) => entry.url.endsWith("/getupdates"))).toBe(false);
	});
});
