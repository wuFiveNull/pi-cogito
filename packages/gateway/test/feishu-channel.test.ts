import { createCipheriv, createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAgent } from "../src/agent.ts";
import { MessageBus } from "../src/bus.ts";
import { OutboundDispatcher } from "../src/channels/dispatcher.ts";
import { decodeFeishuFrame, encodeFeishuFrame, FeishuChannel } from "../src/channels/feishu.ts";
import type { WsLike } from "../src/channels/ws-common.ts";
import type { OutboundDelta, OutboundMessage } from "../src/types.ts";

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of running.splice(0)) await cleanup();
});

class FakeWs implements WsLike {
	url = "";
	sent: Uint8Array[] = [];
	private messageHandler: ((text: string) => void) | undefined;
	private binaryHandler: ((data: Uint8Array) => void) | undefined;
	private closeHandler: (() => void) | undefined;

	async connect(url: string): Promise<void> {
		this.url = url;
	}

	send(text: string): void {
		this.messageHandler?.(text);
	}

	sendBinary(data: Uint8Array): void {
		this.sent.push(data);
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

	emitBinary(hex: string): void {
		this.binaryHandler?.(Buffer.from(hex, "hex"));
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

async function startChannel(fetchFn: typeof fetch, config: Record<string, unknown> = {}) {
	const bus = new MessageBus();
	const ws = new FakeWs();
	const channel = new FeishuChannel({ appId: "cli_test", appSecret: "secret", allowFrom: ["*"], ...config }, bus, {
		socket: ws,
		fetchFn,
	});
	await channel.start();
	const dispatcher = new OutboundDispatcher(bus, {
		get: (name: string) => (name === "feishu" ? channel : undefined),
	});
	dispatcher.start();
	running.push(async () => {
		dispatcher.stop();
		await channel.stop();
	});
	return { bus, channel, ws };
}

// ---------------------------------------------------------------------------
// protobuf 黄金字节(由官方 lark-oapi SDK v1.7.1 生成)
// ---------------------------------------------------------------------------

const DATA_FRAME_HEX =
	"08001000187b20012a0d0a047479706512056576656e742a140a0a6d6573736167655f696412066f6d5f3132332a080a0373756d1201312a080a037365711201302a100a0874726163655f6964120474725f3142107b22736368656d61223a22322e30227d";
const PING_FRAME_HEX = "08001000187b20002a0c0a0474797065120470696e674200";

describe("feishu protobuf frames", () => {
	it("decodes the golden DATA frame from the official SDK", () => {
		const frame = decodeFeishuFrame(Buffer.from(DATA_FRAME_HEX, "hex"));
		expect(frame.SeqID).toBe(0);
		expect(frame.LogID).toBe(0);
		expect(frame.service).toBe(123);
		expect(frame.method).toBe(1); // DATA
		expect(frame.headers).toEqual([
			["type", "event"],
			["message_id", "om_123"],
			["sum", "1"],
			["seq", "0"],
			["trace_id", "tr_1"],
		]);
		expect(Buffer.from(frame.payload).toString("utf-8")).toBe('{"schema":"2.0"}');
	});

	it("encodes the golden PING frame byte-for-byte", () => {
		const frame = encodeFeishuFrame({
			SeqID: 0,
			LogID: 0,
			service: 123,
			method: 0,
			headers: [["type", "ping"]],
			payload: new Uint8Array(0),
		});
		expect(Buffer.from(frame).toString("hex")).toBe(PING_FRAME_HEX);
	});
});

// ---------------------------------------------------------------------------
// 通道
// ---------------------------------------------------------------------------

function textEventFrame(overrides: Record<string, unknown> = {}): string {
	const event = {
		sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
		message: {
			message_id: "om_123",
			chat_id: "oc_chat1",
			chat_type: "p2p",
			message_type: "text",
			content: JSON.stringify({ text: "你好飞书" }),
			mentions: [],
		},
		...overrides,
	};
	const envelope = {
		schema: "2.0",
		header: { event_id: "evt_1", event_type: "im.message.receive_v1" },
		event,
	};
	return encodeFeishuFrame({
		SeqID: 0,
		LogID: 0,
		service: 123,
		method: 1,
		headers: [
			["type", "event"],
			["message_id", "om_123"],
			["sum", "1"],
			["seq", "0"],
			["trace_id", "tr_1"],
		],
		payload: Buffer.from(JSON.stringify(envelope), "utf-8"),
	}).toString("hex");
}

describe("FeishuChannel streaming (CardKit)", () => {
	function apiChannel(requests: Array<{ url: string; method: string; body: unknown }>) {
		const bus = new MessageBus();
		const channel = new FeishuChannel(
			{ appId: "cli_test", appSecret: "s", allowFrom: ["*"], streamEditIntervalMs: 0 },
			bus,
			{
				socket: new FakeWs(),
				fetchFn: async (url, init) => {
					const u = String(url);
					requests.push({ url: u, method: String(init?.method), body: JSON.parse(String(init?.body)) });
					if (u.includes("/auth/v3/tenant_access_token")) {
						return jsonResponse({ code: 0, tenant_access_token: "t-abc", expire: 7200 });
					}
					if (u.includes("/cardkit/v1/cards")) return jsonResponse({ code: 0, data: { card_id: "card-1" } });
					return jsonResponse({ code: 0, data: { message_id: "om_x" } });
				},
			},
		);
		return { bus, channel };
	}

	it("creates a streaming card on the first delta and updates it", async () => {
		const requests: Array<{ url: string; method: string; body: unknown }> = [];
		const { channel } = apiChannel(requests);
		await channel.sendDelta({ channel: "feishu", chatId: "oc_c", delta: "你好", streamId: "s1" } as OutboundDelta);
		// 卡片创建是后台进行的,等它完成后第二个 delta 才走更新分支
		await vi.waitFor(() => expect(requests.some((r) => r.url.endsWith("/cardkit/v1/cards"))).toBe(true), {
			timeout: 2000,
		});
		await channel.sendDelta({ channel: "feishu", chatId: "oc_c", delta: "，飞书", streamId: "s1" } as OutboundDelta);

		const create = requests.find((r) => r.url.endsWith("/cardkit/v1/cards"))!;
		expect(create.method).toBe("POST");
		const cardJson = JSON.parse(String((create.body as { data: string }).data)) as {
			config: { streaming_mode: boolean };
			body: { elements: Array<{ tag: string; content: string }> };
		};
		expect(cardJson.config.streaming_mode).toBe(true);
		expect(cardJson.body.elements[0]).toMatchObject({ tag: "markdown", content: "你好" });

		const send = requests.find((r) => r.url.includes("/im/v1/messages"))!;
		expect(send.body).toMatchObject({ receive_id: "oc_c", msg_type: "interactive" });

		const update = requests.find((r) => r.url.includes("/elements/streaming_md/content"))!;
		expect(update.method).toBe("PUT");
		expect(update.body).toMatchObject({ content: "你好，飞书", sequence: 2 });
	});

	it("finalizes with the full text and disables streaming mode on stream end", async () => {
		const requests: Array<{ url: string; method: string; body: unknown }> = [];
		const { channel } = apiChannel(requests);
		await channel.sendDelta({ channel: "feishu", chatId: "oc_c", delta: "你好", streamId: "s1" } as OutboundDelta);
		await channel.sendDelta({
			channel: "feishu",
			chatId: "oc_c",
			delta: "",
			streamId: "s1",
			streamEnd: true,
		} as OutboundDelta);

		const settings = requests.find((r) => r.url.includes("/settings"))!;
		expect(settings.method).toBe("PATCH");
		expect(settings.body).toMatchObject({ sequence: 3 });
		expect(JSON.parse(String((settings.body as { settings: string }).settings))).toEqual({
			config: { streaming_mode: false },
		});
	});

	it("skips the duplicate full message right after a stream ended", async () => {
		const requests: Array<{ url: string; method: string; body: unknown }> = [];
		const { channel } = apiChannel(requests);
		await channel.sendDelta({ channel: "feishu", chatId: "oc_c", delta: "hi", streamId: "s1" } as OutboundDelta);
		await channel.sendDelta({
			channel: "feishu",
			chatId: "oc_c",
			delta: "",
			streamId: "s1",
			streamEnd: true,
		} as OutboundDelta);
		const before = requests.filter((r) => r.url.includes("/im/v1/messages")).length;

		// 流式回复的完整版带 streamId -> 跳过
		await channel.send({
			channel: "feishu",
			chatId: "oc_c",
			content: "hi",
			metadata: { streamId: "s1" },
		} as OutboundMessage);
		const after = requests.filter((r) => r.url.includes("/im/v1/messages")).length;
		expect(after).toBe(before); // 不重复发送

		// 非流式回复(错误/推送)不带 streamId -> 正常发送
		await channel.send({ channel: "feishu", chatId: "oc_c", content: "错误" } as OutboundMessage);
		const afterError = requests.filter((r) => r.url.includes("/im/v1/messages")).length;
		expect(afterError).toBe(before + 1);
	});

	it("falls back to a plain text message when card creation fails", async () => {
		const requests: Array<{ url: string; method: string; body: unknown }> = [];
		const bus = new MessageBus();
		const channel = new FeishuChannel(
			{ appId: "cli_test", appSecret: "s", allowFrom: ["*"], streamEditIntervalMs: 0 },
			bus,
			{
				socket: new FakeWs(),
				fetchFn: async (url, init) => {
					const u = String(url);
					requests.push({ url: u, method: String(init?.method), body: JSON.parse(String(init?.body)) });
					if (u.includes("/auth/v3/tenant_access_token"))
						return jsonResponse({ code: 0, tenant_access_token: "t", expire: 7200 });
					if (u.includes("/cardkit/v1/cards")) return jsonResponse({ code: 999, msg: "permission denied" });
					return jsonResponse({ code: 0 });
				},
			},
		);
		await channel.sendDelta({ channel: "feishu", chatId: "oc_c", delta: "hi", streamId: "s1" } as OutboundDelta);
		await channel.sendDelta({
			channel: "feishu",
			chatId: "oc_c",
			delta: "",
			streamId: "s1",
			streamEnd: true,
		} as OutboundDelta);
		const text = requests.find((r) => r.url.includes("/im/v1/messages"))!;
		expect(text.body).toMatchObject({
			receive_id: "oc_c",
			msg_type: "text",
			content: JSON.stringify({ text: "hi" }),
		});
	});
});

describe("FeishuChannel reply (引用回复)", () => {
	it("replies to the original message via the Reply API for plain text", async () => {
		const requests: Array<{ url: string; method: string; body: unknown }> = [];
		const bus = new MessageBus();
		const channel = new FeishuChannel({ appId: "cli_test", appSecret: "s", allowFrom: ["*"] }, bus, {
			socket: new FakeWs(),
			fetchFn: async (url, init) => {
				const u = String(url);
				requests.push({ url: u, method: String(init?.method), body: JSON.parse(String(init?.body)) });
				if (u.includes("/auth/v3/tenant_access_token"))
					return jsonResponse({ code: 0, tenant_access_token: "t", expire: 7200 });
				return jsonResponse({ code: 0 });
			},
		});
		await channel.send({
			channel: "feishu",
			chatId: "oc_c",
			content: "hi",
			replyTo: "om_user_msg",
			messageId: "proactive_delivery_target",
		} as OutboundMessage);
		const reply = requests.find((r) => r.url.includes("/messages/om_user_msg/reply"))!;
		expect(reply).toBeDefined();
		expect(reply.body).toMatchObject({
			msg_type: "text",
			content: JSON.stringify({ text: "hi" }),
			uuid: "proactive_delivery_target:text",
		});
	});

	it("replies with the streaming card to the original message", async () => {
		const requests: Array<{ url: string; method: string; body: unknown }> = [];
		const { channel } = {
			channel: new FeishuChannel(
				{ appId: "cli_test", appSecret: "s", allowFrom: ["*"], streamEditIntervalMs: 0 },
				new MessageBus(),
				{
					socket: new FakeWs(),
					fetchFn: async (url, init) => {
						const u = String(url);
						requests.push({ url: u, method: String(init?.method), body: JSON.parse(String(init?.body)) });
						if (u.includes("/auth/v3/tenant_access_token"))
							return jsonResponse({ code: 0, tenant_access_token: "t", expire: 7200 });
						if (u.includes("/cardkit/v1/cards")) return jsonResponse({ code: 0, data: { card_id: "card-9" } });
						return jsonResponse({ code: 0 });
					},
				},
			),
		};
		await channel.sendDelta({
			channel: "feishu",
			chatId: "oc_c",
			delta: "hi",
			streamId: "s1",
			replyTo: "om_user_msg",
		} as OutboundDelta);
		await vi.waitFor(() => expect(requests.some((r) => r.url.endsWith("/cardkit/v1/cards"))).toBe(true), {
			timeout: 2000,
		});
		await channel.sendDelta({
			channel: "feishu",
			chatId: "oc_c",
			delta: "",
			streamId: "s1",
			streamEnd: true,
			replyTo: "om_user_msg",
		} as OutboundDelta);
		const reply = requests.find((r) => r.url.includes("/messages/om_user_msg/reply"))!;
		expect(reply).toBeDefined();
		expect(reply.body).toMatchObject({ msg_type: "interactive" });
	});
});

describe("FeishuChannel images (图片消息)", () => {
	it("downloads image messages and passes base64 into inbound images", async () => {
		const bus = new MessageBus();
		const ws = new FakeWs();
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		const channel = new FeishuChannel({ appId: "cli_test", appSecret: "s", allowFrom: ["*"] }, bus, {
			socket: ws,
			fetchFn: async (url, _init) => {
				const u = String(url);
				if (u.includes("/auth/v3/tenant_access_token"))
					return jsonResponse({ code: 0, tenant_access_token: "t", expire: 7200 });
				if (u.includes("/resources/img_v2_abc")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({}),
						text: async () => "",
						arrayBuffer: async () => png,
					} as unknown as Response;
				}
				return jsonResponse({ code: 0, data: { URL: "wss://ws.example?service_id=1" } });
			},
		});
		await channel.start();
		running.push(async () => {
			await channel.stop();
		});
		await vi.waitFor(() => expect(ws.url).toBe("wss://ws.example?service_id=1"), { timeout: 2000 });

		const envelope = {
			schema: "2.0",
			header: { event_id: "evt_img", event_type: "im.message.receive_v1" },
			event: {
				sender: { sender_id: { open_id: "ou_user1" } },
				message: {
					message_id: "om_img",
					chat_id: "oc_c",
					chat_type: "p2p",
					message_type: "image",
					content: JSON.stringify({ image_key: "img_v2_abc" }),
				},
			},
		};
		ws.emitBinary(
			encodeFeishuFrame({
				SeqID: 0,
				LogID: 0,
				service: 1,
				method: 1,
				headers: [
					["type", "event"],
					["message_id", "om_img"],
					["sum", "1"],
					["seq", "0"],
				],
				payload: Buffer.from(JSON.stringify(envelope), "utf-8"),
			}).toString("hex"),
		);
		const inbound = await bus.consumeInbound();
		expect(inbound.content).toBe("[图片]");
		expect(inbound.images).toEqual([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
		expect(inbound.metadata?.images).toEqual([
			{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
		]);
	});

	it("uploads and sends outbound media, including media-only messages", async () => {
		const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
		const channel = new FeishuChannel({ appId: "cli_test", appSecret: "s", allowFrom: ["*"] }, new MessageBus(), {
			socket: new FakeWs(),
			fetchFn: async (url, init) => {
				const requestUrl = String(url);
				requests.push({ url: requestUrl, init });
				if (requestUrl.includes("/auth/v3/tenant_access_token")) {
					return jsonResponse({ code: 0, tenant_access_token: "t", expire: 7200 });
				}
				if (requestUrl.includes("/im/v1/images")) {
					return jsonResponse({ code: 0, data: { image_key: "img_outbound" } });
				}
				return jsonResponse({ code: 0 });
			},
		});

		await channel.send({
			channel: "feishu",
			chatId: "oc_media",
			content: "",
			media: ["data:image/png;base64,iVBORw0KGgo="],
		});

		expect(requests).toHaveLength(3);
		expect(requests[1]?.init?.body).toBeInstanceOf(FormData);
		const upload = requests[1]?.init?.body as FormData;
		expect(upload.get("image_type")).toBe("message");
		expect(upload.get("image")).not.toBeNull();
		expect(JSON.parse(String(requests[2]?.init?.body))).toMatchObject({
			receive_id: "oc_media",
			msg_type: "image",
			content: JSON.stringify({ image_key: "img_outbound" }),
		});
	});

	it("uploads and sends outbound file attachments", async () => {
		const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
		const channel = new FeishuChannel({ appId: "cli_test", appSecret: "s", allowFrom: ["*"] }, new MessageBus(), {
			socket: new FakeWs(),
			fetchFn: async (url, init) => {
				const requestUrl = String(url);
				requests.push({ url: requestUrl, init });
				if (requestUrl.includes("/auth/v3/tenant_access_token")) {
					return jsonResponse({ code: 0, tenant_access_token: "t", expire: 7200 });
				}
				if (requestUrl.includes("/im/v1/files")) {
					return jsonResponse({ code: 0, data: { file_key: "file_outbound" } });
				}
				return jsonResponse({ code: 0 });
			},
		});

		await channel.send({
			channel: "feishu",
			chatId: "oc_file",
			content: "",
			attachments: [
				{
					kind: "file",
					source: "data:application/pdf;base64,JVBERi0xLjQ=",
					filename: "report.pdf",
					mimeType: "application/pdf",
				},
			],
		});

		expect(requests).toHaveLength(3);
		expect(requests[1]?.init?.body).toBeInstanceOf(FormData);
		const upload = requests[1]?.init?.body as FormData;
		expect(upload.get("file_type")).toBe("stream");
		expect(upload.get("file_name")).toBe("report.pdf");
		expect(upload.get("file")).not.toBeNull();
		expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
			receive_id: "oc_file",
			msg_type: "file",
			content: JSON.stringify({ file_key: "file_outbound" }),
		});
	});
});

describe("FeishuChannel", () => {
	it("discovers the endpoint and connects", async () => {
		const { ws } = await startChannel(async (url) => {
			expect(String(url)).toContain("/callback/ws/endpoint");
			return jsonResponse({
				code: 0,
				data: { URL: "wss://feishu-ws.example?device_id=d1&service_id=456", ClientConfig: { PingInterval: 30 } },
			});
		});
		await vi.waitFor(() => expect(ws.url).toBe("wss://feishu-ws.example?device_id=d1&service_id=456"), {
			timeout: 2000,
		});
	});

	it("normalizes p2p text events and acks", async () => {
		const { bus, ws } = await startChannel(async () =>
			jsonResponse({ code: 0, data: { URL: "wss://ws.example?service_id=1" } }),
		);
		await vi.waitFor(() => expect(ws.url).toBe("wss://ws.example?service_id=1"), { timeout: 2000 });

		ws.emitBinary(textEventFrame());
		const inbound = await bus.consumeInbound();
		expect(inbound).toMatchObject({
			channel: "feishu",
			senderId: "ou_user1",
			chatId: "oc_chat1",
			content: "你好飞书",
		});
		// ack 帧:同帧回 payload {"code":200}
		const ack = decodeFeishuFrame(ws.sent[ws.sent.length - 1]!);
		expect(Buffer.from(ack.payload).toString("utf-8")).toBe('{"code":200}');
		expect(headerOf(ack, "type")).toBe("event");
	});

	it("skips group messages without a bot mention and strips @ placeholders", async () => {
		const { bus, ws } = await startChannel(
			async () => jsonResponse({ code: 0, data: { URL: "wss://ws.example?service_id=1" } }),
			{ botOpenId: "ou_bot" },
		);
		await vi.waitFor(() => expect(ws.url).toBe("wss://ws.example?service_id=1"), { timeout: 2000 });

		// 群聊,无 mention -> 跳过
		ws.emitBinary(
			textEventFrame({
				message: {
					message_id: "om_1",
					chat_id: "oc_g1",
					chat_type: "group",
					message_type: "text",
					content: JSON.stringify({ text: "大家好" }),
					mentions: [],
				},
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(bus.inboundSize).toBe(0);

		// @机器人 -> 响应,且清除 @占位符
		ws.emitBinary(
			textEventFrame({
				message: {
					message_id: "om_2",
					chat_id: "oc_g1",
					chat_type: "group",
					message_type: "text",
					content: JSON.stringify({ text: "@_user_1 帮我查一下 @_user_2 的事情" }),
					mentions: [
						{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "bot" },
						{ key: "@_user_2", id: { open_id: "ou_other" }, name: "alice" },
					],
				},
			}),
		);
		const inbound = await bus.consumeInbound();
		expect(inbound.content).toBe("帮我查一下 的事情");
	});

	it("reassembles fragmented events by message_id", async () => {
		const { bus, ws } = await startChannel(async () =>
			jsonResponse({ code: 0, data: { URL: "wss://ws.example?service_id=1" } }),
		);
		await vi.waitFor(() => expect(ws.url).toBe("wss://ws.example?service_id=1"), { timeout: 2000 });

		const envelope = JSON.stringify({
			schema: "2.0",
			header: { event_id: "evt_frag", event_type: "im.message.receive_v1" },
			event: {
				sender: { sender_id: { open_id: "ou_user1" } },
				message: {
					message_id: "om_frag",
					chat_id: "oc_c",
					chat_type: "p2p",
					message_type: "text",
					content: JSON.stringify({ text: "分片消息" }),
				},
			},
		});
		const half = Buffer.byteLength(envelope) / 2;
		const part1 = envelope.slice(0, half);
		const part2 = envelope.slice(half);
		const frame = (payload: string, seq: string) =>
			encodeFeishuFrame({
				SeqID: 0,
				LogID: 0,
				service: 1,
				method: 1,
				headers: [
					["type", "event"],
					["message_id", "om_frag"],
					["sum", "2"],
					["seq", seq],
					["trace_id", "tr"],
				],
				payload: Buffer.from(payload, "utf-8"),
			}).toString("hex");

		ws.emitBinary(frame(part1, "0"));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(bus.inboundSize).toBe(0); // 分片未齐
		ws.emitBinary(frame(part2, "1"));
		const inbound = await bus.consumeInbound();
		expect(inbound.content).toBe("分片消息");
	});

	it("sends replies via the im/v1/messages API with a cached token", async () => {
		const calls: Array<{ url: string; body: unknown; auth?: string }> = [];
		const { bus } = await startChannel(async (url, init) => {
			const u = String(url);
			calls.push({
				url: u,
				body: JSON.parse(String(init?.body)),
				auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""),
			});
			if (u.includes("/auth/v3/tenant_access_token")) {
				return jsonResponse({ code: 0, tenant_access_token: "t-abc", expire: 7200 });
			}
			if (u.includes("/im/v1/messages")) {
				return jsonResponse({ code: 0, data: { message_id: "om_reply" } });
			}
			return jsonResponse({ code: 0, data: { URL: "wss://ws.example?service_id=1" } });
		});
		const agent = new FakeAgent(bus);
		agent.start();

		// 手动注入 inbound,让 agent 回复,dispatcher 路由到 feishu send
		await bus.publishInbound({
			messageId: "om_inbound",
			channel: "feishu",
			senderId: "ou_user1",
			chatId: "oc_chat1",
			content: "hi",
			timestamp: Date.now(),
			sessionKey: "feishu:oc_chat1",
		});
		await vi.waitFor(() => expect(calls.some((c) => c.url.includes("/im/v1/messages"))).toBe(true), {
			timeout: 2000,
		});
		const send = calls.find((c) => c.url.includes("/im/v1/messages"))!;
		expect(send.auth).toBe("Bearer t-abc");
		expect(send.url).toContain("/im/v1/messages/om_inbound/reply");
		expect(send.body).toMatchObject({ msg_type: "text" });
		agent.stop();
	});

	it("decrypts events when encryptKey is set", async () => {
		const { bus, ws } = await startChannel(
			async () => jsonResponse({ code: 0, data: { URL: "wss://ws.example?service_id=1" } }),
			{ encryptKey: "test-encrypt-key-123456" },
		);
		await vi.waitFor(() => expect(ws.url).toBe("wss://ws.example?service_id=1"), { timeout: 2000 });

		// 用同一套算法加密事件
		const envelope = JSON.stringify({
			schema: "2.0",
			header: { event_id: "evt_enc", event_type: "im.message.receive_v1" },
			event: {
				sender: { sender_id: { open_id: "ou_user1" } },
				message: {
					message_id: "om_enc",
					chat_id: "oc_c",
					chat_type: "p2p",
					message_type: "text",
					content: JSON.stringify({ text: "加密消息" }),
				},
			},
		});
		const key = createHash("sha256").update("test-encrypt-key-123456").digest();
		const iv = Buffer.alloc(16, 7);
		const cipher = createCipheriv("aes-256-cbc", key, iv);
		const encrypted = Buffer.concat([iv, cipher.update(Buffer.from(envelope, "utf-8")), cipher.final()]).toString(
			"base64",
		);
		ws.emitBinary(
			encodeFeishuFrame({
				SeqID: 0,
				LogID: 0,
				service: 1,
				method: 1,
				headers: [
					["type", "event"],
					["message_id", "om_enc"],
					["sum", "1"],
					["seq", "0"],
				],
				payload: Buffer.from(encrypted, "utf-8"),
			}).toString("hex"),
		);
		const inbound = await bus.consumeInbound();
		expect(inbound.content).toBe("加密消息");
	});
});

describe("FeishuChannel W2-M3 rich messages and reactions", () => {
	function richChannel(requests: Array<{ url: string; method: string; body: unknown }>) {
		const bus = new MessageBus();
		const ws = new FakeWs();
		const channel = new FeishuChannel({ appId: "cli_test", appSecret: "s", allowFrom: ["*"] }, bus, {
			socket: ws,
			fetchFn: async (url, init) => {
				const u = String(url);
				let body: unknown;
				try {
					body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
				} catch {
					body = String(init?.body);
				}
				requests.push({ url: u, method: String(init?.method), body });
				if (u.includes("/auth/v3/tenant_access_token")) {
					return jsonResponse({ code: 0, tenant_access_token: "t-abc", expire: 7200 });
				}
				if (u.includes("/callback/ws/endpoint")) {
					return jsonResponse({ code: 0, data: { URL: "wss://ws.example" } });
				}
				if (u.includes("/reactions")) {
					return jsonResponse({ code: 0, data: { reaction_id: "re_1" } });
				}
				return jsonResponse({ code: 0, data: { message_id: "om_x" } });
			},
		});
		return { bus, channel, ws };
	}

	function emitTextMessage(ws: FakeWs, overrides: Record<string, unknown> = {}) {
		const frameHex = textEventFrame({
			sender: { sender_id: { open_id: "ou_user1" } },
			message: {
				message_id: "om_rich",
				chat_id: "oc_c",
				chat_type: "p2p",
				message_type: "text",
				content: JSON.stringify({ text: "你好飞书" }),
				mentions: [],
			},
			...overrides,
		});
		ws.emitBinary(frameHex);
	}

	it("adds a reaction on accepted inbound and removes it after the reply", async () => {
		const requests: Array<{ url: string; method: string; body: unknown }> = [];
		const { bus, channel, ws } = richChannel(requests);
		await channel.start();
		running.push(async () => void channel.stop());
		// 等长连接建立(endpoint 发现需要 token)
		await vi.waitFor(() => expect(ws.url.length > 0).toBe(true), { timeout: 2000 });
		const inbound = bus.consumeInbound();
		emitTextMessage(ws);
		const received = await inbound;
		expect(received.content).toBe("你好飞书");

		await vi.waitFor(
			() => expect(requests.some((r) => r.url.includes("/reactions") && r.method === "POST")).toBe(true),
			{ timeout: 2000 },
		);
		const add = requests.find((r) => r.url.includes("/reactions") && r.method === "POST")!;
		expect(add.body).toMatchObject({ reaction_type: { type: "emoji", emoji: "THUMBSUP" } });

		// 回复完成后移除 reaction
		await channel.send({ channel: "feishu", chatId: "oc_c", content: "done" } as OutboundMessage);
		await vi.waitFor(
			() => expect(requests.some((r) => r.url.includes("/reactions/re_1") && r.method === "DELETE")).toBe(true),
			{ timeout: 2000 },
		);
	});

	it("does not react when reactEmoji is disabled", async () => {
		const requests: Array<{ url: string; method: string; body: unknown }> = [];
		const bus = new MessageBus();
		const ws = new FakeWs();
		const channel = new FeishuChannel({ appId: "cli_test", appSecret: "s", allowFrom: ["*"], reactEmoji: "" }, bus, {
			socket: ws,
			fetchFn: async (url, init) => {
				const u = String(url);
				requests.push({ url: u, method: String(init?.method), body: init?.body });
				if (u.includes("/auth/v3/tenant_access_token")) {
					return jsonResponse({ code: 0, tenant_access_token: "t-abc", expire: 7200 });
				}
				return jsonResponse({ code: 0, data: { URL: "wss://ws.example" } });
			},
		});
		await channel.start();
		running.push(async () => void channel.stop());
		await vi.waitFor(() => expect(ws.url.length > 0).toBe(true), { timeout: 2000 });
		const inbound = bus.consumeInbound();
		emitTextMessage(ws);
		await inbound;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(requests.some((r) => r.url.includes("/reactions"))).toBe(false);
	});

	it("extracts rich text post messages as plain content", async () => {
		const requests: Array<{ url: string; method: string; body: unknown }> = [];
		const { bus, channel, ws } = richChannel(requests);
		await channel.start();
		running.push(async () => void channel.stop());
		await vi.waitFor(() => expect(ws.url.length > 0).toBe(true), { timeout: 2000 });
		const inbound = bus.consumeInbound();
		emitTextMessage(ws, {
			message: {
				message_id: "om_post",
				chat_id: "oc_c",
				chat_type: "p2p",
				message_type: "post",
				content: JSON.stringify({
					title: "标题",
					content: [
						[
							{ tag: "text", text: "正文 " },
							{ tag: "a", text: "链接", href: "https://example.com" },
						],
						[{ tag: "text", text: "第二行" }],
					],
				}),
			},
		});
		const received = await inbound;
		expect(received.content).toBe("标题\n正文 链接 (https://example.com)\n第二行");
	});

	it("extracts share cards (interactive) as readable text", async () => {
		const requests: Array<{ url: string; method: string; body: unknown }> = [];
		const { bus, channel, ws } = richChannel(requests);
		await channel.start();
		running.push(async () => void channel.stop());
		await vi.waitFor(() => expect(ws.url.length > 0).toBe(true), { timeout: 2000 });
		const inbound = bus.consumeInbound();
		emitTextMessage(ws, {
			message: {
				message_id: "om_card",
				chat_id: "oc_c",
				chat_type: "p2p",
				message_type: "interactive",
				content: JSON.stringify({
					link: { title: "分享标题", desc: "分享描述", link: "https://example.com/x" },
				}),
			},
		});
		const received = await inbound;
		expect(received.content).toBe("分享标题\n分享描述\nhttps://example.com/x");
	});

	it("renders markdown tables as a monospace box on outbound text", async () => {
		const requests: Array<{ url: string; method: string; body: unknown }> = [];
		const { channel } = richChannel(requests);
		await channel.send({
			channel: "feishu",
			chatId: "oc_c",
			content: "先看表:\n| a | b |\n| 1 | 22 |\n然后继续",
		} as OutboundMessage);
		const send = requests.find((r) => r.url.includes("/im/v1/messages"))!;
		const content = JSON.parse(String((send.body as { content: string }).content)) as { text: string };
		expect(content.text).toContain("```");
		expect(content.text).toContain("| a | b  |");
		expect(content.text).toContain("| 1 | 22 |");
		expect(content.text).toContain("先看表:");
		expect(content.text).toContain("然后继续");
	});

	it("login fails clearly when app credentials are missing", async () => {
		const requests: Array<{ url: string; method: string; body: unknown }> = [];
		const { channel } = richChannel(requests);
		expect(await channel.login()).toBe(true);
		const empty = new FeishuChannel({ allowFrom: ["*"] }, new MessageBus(), {
			socket: new FakeWs(),
			fetchFn: async () => jsonResponse({ code: 0 }),
		});
		expect(await empty.login()).toBe(false);
	});
});

function headerOf(frame: { headers: Array<[string, string]> }, key: string): string | undefined {
	return frame.headers.find(([k]) => k === key)?.[1];
}
