import { createCipheriv, createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { WecomChannel } from "../src/channels/wecom.ts";
import type { OutboundMessage } from "../src/types.ts";

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of running.splice(0)) await cleanup();
});

const TOKEN = "callback-token";
// 43-char EncodingAESKey; the SDK appends "=" before base64-decoding.
const AES_KEY = "0123456789abcdef0123456789abcdef0123456789A";

/** Encrypt a callback payload the way 企业微信 does. */
function encryptCallback(msg: string): string {
	const key = Buffer.from(`${AES_KEY}=`, "base64");
	const random = Buffer.alloc(16, 1);
	const msgBuf = Buffer.from(msg, "utf-8");
	const len = Buffer.alloc(4);
	len.writeUInt32BE(msgBuf.length, 0);
	const receiveId = Buffer.from("ww-corpid", "utf-8");
	const plain = Buffer.concat([random, len, msgBuf, receiveId]);
	const padded = pkcs7(plain, 32);
	const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
	return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

function pkcs7(data: Buffer, block: number): Buffer {
	const pad = block - (data.length % block);
	return Buffer.concat([data, Buffer.alloc(pad, pad)]);
}

function signature(timestamp: string, nonce: string, _encrypted: string): string {
	return createHash("sha1").update([TOKEN, timestamp, nonce].sort().join(""), "utf8").digest("hex");
}

function callbackXml(overrides: Record<string, string> = {}): string {
	const fields = {
		ToUserName: "ww-corpid",
		FromUserName: "zhangsan",
		CreateTime: "1700000000",
		MsgType: "text",
		Content: "你好企业微信",
		MsgId: "msg-100",
		...overrides,
	};
	return `<xml>${Object.entries(fields)
		.map(([name, value]) => `<${name}><![CDATA[${value}]]></${name}>`)
		.join("")}</xml>`;
}

async function startWecom(fetchFn: typeof fetch) {
	const bus = new MessageBus();
	const channel = new WecomChannel(
		{
			corpId: "ww-corpid",
			corpSecret: "secret",
			agentId: "1000002",
			token: TOKEN,
			encodingAESKey: AES_KEY,
			callbackPort: 0,
			allowFrom: ["*"],
		},
		bus,
		{ fetchFn },
	);
	await channel.start();
	running.push(async () => void channel.stop());
	return { bus, channel };
}

describe("WecomChannel", () => {
	it("answers the GET verification with the decrypted echostr", async () => {
		const { channel } = await startWecom(
			vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response),
		);
		const timestamp = "1700000000";
		const nonce = "nonce1";
		const echostr = encryptCallback("echo-123");
		const response = await fetch(
			`http://127.0.0.1:${channel.port}/wecom?msg_signature=${signature(timestamp, nonce, echostr)}&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`,
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("echo-123");
	});

	it("rejects callbacks with a bad signature", async () => {
		const { channel } = await startWecom(
			vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response),
		);
		const response = await fetch(`http://127.0.0.1:${channel.port}/wecom?msg_signature=deadbeef&timestamp=1&nonce=2`);
		expect(response.status).toBe(403);
	});

	it("normalizes encrypted text callbacks into inbound messages", async () => {
		const { bus, channel } = await startWecom(
			vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response),
		);
		const encrypted = encryptCallback(callbackXml());
		const timestamp = "1700000000";
		const nonce = "nonce1";
		const inbound = bus.consumeInbound();
		const response = await fetch(
			`http://127.0.0.1:${channel.port}/wecom?msg_signature=${signature(timestamp, nonce, encrypted)}&timestamp=${timestamp}&nonce=${nonce}`,
			{ method: "POST", body: encrypted },
		);
		expect(response.status).toBe(200);
		const received = await inbound;
		expect(received).toMatchObject({
			channel: "wecom",
			senderId: "zhangsan",
			chatId: "zhangsan",
			content: "你好企业微信",
			isDm: true,
		});
		expect(received.metadata).toMatchObject({ msgType: "text" });
	});

	it("sends replies via message/send with a cached access token", async () => {
		const calls: Array<{ url: string; body?: unknown }> = [];
		const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/cgi-bin/gettoken")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({ errcode: 0, access_token: "tok-1", expires_in: 7200 }),
				} as Response;
			}
			calls.push({ url: u, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
			return { ok: true, status: 200, json: async () => ({ errcode: 0, errmsg: "ok" }) } as Response;
		});
		const { channel } = await startWecom(fetchFn as unknown as typeof fetch);
		await channel.send({ channel: "wecom", chatId: "lisi", content: "reply" } as OutboundMessage);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toContain("message/send?access_token=tok-1");
		expect(calls[0]!.body).toMatchObject({
			touser: "lisi",
			msgtype: "text",
			agentid: 1000002,
			text: { content: "reply" },
		});

		// Second send reuses the cached token (no new gettoken call).
		await channel.send({ channel: "wecom", chatId: "lisi", content: "again" } as OutboundMessage);
		expect(calls).toHaveLength(2);
	});

	it("surfaces unsupported outbound media as a note", async () => {
		const calls: Array<{ url: string; body?: unknown }> = [];
		const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/cgi-bin/gettoken")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({ errcode: 0, access_token: "tok-1", expires_in: 7200 }),
				} as Response;
			}
			calls.push({ url: u, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
			return { ok: true, status: 200, json: async () => ({ errcode: 0, errmsg: "ok" }) } as Response;
		});
		const { channel } = await startWecom(fetchFn as unknown as typeof fetch);
		await channel.send({
			channel: "wecom",
			chatId: "lisi",
			content: "text",
			media: ["/tmp/a.png"],
		} as OutboundMessage);
		const text = (calls[0]!.body as { text: { content: string } }).text.content;
		expect(text).toContain("附件发送失败");
	});
});
