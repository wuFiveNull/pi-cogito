import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { DiscordChannel } from "../src/channels/discord.ts";
import { EmailChannel } from "../src/channels/email.ts";
import { MatrixChannel } from "../src/channels/matrix.ts";
import { MattermostChannel } from "../src/channels/mattermost.ts";
import { SlackChannel } from "../src/channels/slack.ts";
import { TelegramChannel } from "../src/channels/telegram.ts";
import {
	attachmentFromMediaSource,
	type ChannelMediaCapabilities,
	collectOutboundMedia,
	mediaSourceKind,
	resolveOutboundMedia,
	withMediaFailureNote,
} from "../src/media.ts";

function jsonResponse(body: unknown, ok = true) {
	return {
		ok,
		status: ok ? 200 : 500,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as Response;
}

function mediaResponse(mimeType: string, bytes: Buffer) {
	return {
		ok: true,
		status: 200,
		headers: new Headers({ "content-type": mimeType }),
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
		json: async () => ({}),
		text: async () => "",
		arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	} as unknown as Response;
}

// ---------------------------------------------------------------------------
// 公共媒体管线
// ---------------------------------------------------------------------------

describe("collectOutboundMedia", () => {
	it("normalizes bare media strings with kind inference", () => {
		const items = collectOutboundMedia({
			channel: "x",
			chatId: "c",
			content: "",
			media: ["https://example.com/a.png", "/tmp/note.pdf", "audio.mp3", ""],
		});
		expect(items).toHaveLength(3);
		expect(items[0]).toMatchObject({ kind: "image", filename: "a.png", mimeType: "image/png" });
		expect(items[1]).toMatchObject({ kind: "file", filename: "note.pdf" });
		expect(items[2]).toMatchObject({ kind: "audio", filename: "audio.mp3" });
	});

	it("merges media before structured attachments and skips empty sources", () => {
		const items = collectOutboundMedia({
			channel: "x",
			chatId: "c",
			content: "",
			media: ["pic.png"],
			attachments: [
				{ kind: "video", source: "clip.mp4" },
				{ kind: "file", source: "  " },
			],
		});
		expect(items.map((item) => item.kind)).toEqual(["image", "video"]);
	});

	it("guesses kind from URL path ignoring query", () => {
		expect(attachmentFromMediaSource("https://example.com/pic.gif?token=1").kind).toBe("image");
		expect(mediaSourceKind("data:image/png;base64,AA==")).toBe("data");
		expect(mediaSourceKind("/tmp/a.png")).toBe("file");
	});

	it("appends a failure note to content", () => {
		expect(withMediaFailureNote("hello", ["a.png"])).toContain("[附件发送失败: a.png]");
		expect(withMediaFailureNote("", ["a.png"])).toBe("[附件发送失败: a.png]");
		expect(withMediaFailureNote("hello", [])).toBe("hello");
	});
});

describe("resolveOutboundMedia", () => {
	it("decodes data URLs", async () => {
		const resolved = await resolveOutboundMedia({
			kind: "image",
			source: "data:image/png;base64,aGVsbG8=",
			filename: "x.png",
		});
		expect(resolved.data.toString("utf-8")).toBe("hello");
		expect(resolved.mimeType).toBe("image/png");
	});

	it("downloads URLs with the injected fetch and sniffs image mime", async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
		const fetchFn = async (url: string | URL | Request) => {
			expect(String(url)).toBe("https://example.com/pic");
			return mediaResponse("application/octet-stream", png);
		};
		const resolved = await resolveOutboundMedia(
			{ kind: "image", source: "https://example.com/pic" },
			{ fetchFn: fetchFn as typeof fetch },
		);
		expect(resolved.mimeType).toBe("image/png");
		expect(resolved.data).toEqual(png);
	});

	it("reads local files and rejects oversized media", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gateway-media-"));
		try {
			const path = join(dir, "a.txt");
			writeFileSync(path, "content");
			const resolved = await resolveOutboundMedia({ kind: "file", source: path });
			expect(resolved.data.toString("utf-8")).toBe("content");
			expect(resolved.filename).toBe("a.txt");
			await expect(resolveOutboundMedia({ kind: "file", source: path }, { maxBytes: 3 })).rejects.toThrow(
				/size limit/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 渠道多模态发送(直接调用 send,不启动轮询)
// ---------------------------------------------------------------------------

describe("TelegramChannel media", () => {
	it("sends URL media directly via the typed Bot API method", async () => {
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		const bus = new MessageBus();
		const channel = new TelegramChannel({ token: "tok", allowFrom: ["*"] }, bus, {
			post: async (url, body) => {
				calls.push({ url: String(url), body });
				return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) };
			},
		});
		const receipt = await channel.send({
			channel: "telegram",
			chatId: "42",
			content: "hi",
			media: ["https://example.com/a.png"],
		});
		expect(calls.map((call) => call.url)).toEqual([
			"https://api.telegram.org/bottok/sendPhoto",
			"https://api.telegram.org/bottok/sendMessage",
		]);
		expect(calls[0]!.body).toMatchObject({ chat_id: 42, photo: "https://example.com/a.png" });
		expect(receipt.status).toBe("success");
	});

	it("uploads local media via multipart and reports partial on failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gateway-tg-"));
		try {
			const path = join(dir, "photo.png");
			writeFileSync(path, "fake-png");
			const calls: Array<{ url: string; form: FormData | undefined }> = [];
			const bus = new MessageBus();
			const channel = new TelegramChannel({ token: "tok", allowFrom: ["*"] }, bus, {
				// URL 直传(broken.png)走 JSON post,故意失败以触发 partial
				post: async (url) => {
					calls.push({ url: String(url), form: undefined });
					const isText = String(url).includes("/sendMessage");
					return isText
						? { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 9 } }) }
						: { ok: false, status: 400, json: async () => ({ ok: false }) };
				},
				fetchFn: async (url, init) => {
					calls.push({ url: String(url), form: init?.body instanceof FormData ? init.body : undefined });
					return jsonResponse({ ok: true, result: { message_id: 1 } });
				},
			});
			const receipt = await channel.send({
				channel: "telegram",
				chatId: "42",
				content: "done",
				media: [path, "https://example.com/broken.png"],
			});
			expect(calls[0]!.url).toContain("/sendPhoto");
			expect(calls[0]!.form).toBeInstanceOf(FormData);
			const form = calls[0]!.form!;
			expect(form.get("chat_id")).toBe("42");
			expect(String(form.get("photo"))).toBe("[object File]");
			expect(receipt.status).toBe("partial");
			expect(receipt.detail).toContain("broken.png");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("DiscordChannel media", () => {
	it("uploads files via multipart with payload_json", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gateway-dc-"));
		try {
			const path = join(dir, "a.png");
			writeFileSync(path, "png-data");
			let form: FormData | undefined;
			const bus = new MessageBus();
			const channel = new DiscordChannel({ token: "tok", allowFrom: ["*"] }, bus, {
				socket: {
					connect: async () => {},
					send: () => {},
					onMessage: () => {},
					onClose: () => {},
					close: () => {},
				},
				fetchFn: async (_url, init) => {
					form = init?.body instanceof FormData ? init.body : undefined;
					return jsonResponse({ id: "m1" });
				},
			});
			const receipt = await channel.send({
				channel: "discord",
				chatId: "123",
				content: "with file",
				media: [path],
			});
			expect(form).toBeInstanceOf(FormData);
			const payload = JSON.parse(String(form!.get("payload_json"))) as {
				content: string;
				attachments: Array<{ id: number; filename: string }>;
			};
			expect(payload.content).toBe("with file");
			expect(payload.attachments).toEqual([{ id: 0, filename: "a.png" }]);
			expect(form!.get("files[0]")).toBeInstanceOf(Blob);
			expect(receipt.status).toBe("success");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the JSON path for text-only messages", async () => {
		const calls: Array<{ body: string }> = [];
		const bus = new MessageBus();
		const channel = new DiscordChannel({ token: "tok", allowFrom: ["*"] }, bus, {
			socket: { connect: async () => {}, send: () => {}, onMessage: () => {}, onClose: () => {}, close: () => {} },
			fetchFn: async (_url, init) => {
				calls.push({ body: String(init?.body) });
				return jsonResponse({ id: "m1" });
			},
		});
		await channel.send({ channel: "discord", chatId: "123", content: "plain" });
		expect(JSON.parse(calls[0]!.body)).toEqual({ content: "plain" });
	});
});

describe("SlackChannel media", () => {
	it("uploads files.upload with channel_id and posts text", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gateway-slack-"));
		try {
			const path = join(dir, "a.png");
			writeFileSync(path, "png-data");
			const urls: string[] = [];
			const forms: Array<FormData | undefined> = [];
			const bus = new MessageBus();
			const channel = new SlackChannel({ appToken: "xapp", botToken: "xoxb", allowFrom: ["*"] }, bus, {
				socket: {
					connect: async () => {},
					send: () => {},
					onMessage: () => {},
					onClose: () => {},
					close: () => {},
				},
				fetchFn: async (url, init) => {
					urls.push(String(url));
					forms.push(init?.body instanceof FormData ? init.body : undefined);
					return jsonResponse(
						String(url).includes("files.upload") ? { ok: true, file: { id: "f1" } } : { ok: true, ts: "1" },
					);
				},
			});
			const receipt = await channel.send({
				channel: "slack",
				chatId: "C1",
				content: "text",
				media: [path],
			});
			expect(urls).toEqual(["https://slack.com/api/files.upload", "https://slack.com/api/chat.postMessage"]);
			expect(forms[0]!.get("channel_id")).toBe("C1");
			expect(forms[0]!.get("filename")).toBe("a.png");
			expect(receipt.status).toBe("success");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("MatrixChannel media", () => {
	it("uploads media then sends m.image with the mxc url", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gateway-mx-"));
		try {
			const path = join(dir, "a.png");
			writeFileSync(path, "png-data");
			const calls: Array<{ url: string; body?: string }> = [];
			const bus = new MessageBus();
			const channel = new MatrixChannel(
				{ homeserver: "https://matrix.example", accessToken: "tok", allowFrom: ["*"] },
				bus,
				{
					fetchFn: async (url, init) => {
						calls.push({ url: String(url), body: String(init?.body ?? "") });
						if (String(url).includes("/upload")) return jsonResponse({ content_uri: "mxc://host/abc" });
						return jsonResponse({ event_id: "$e1" });
					},
				},
			);
			const receipt = await channel.send({
				channel: "matrix",
				chatId: "!room:example",
				content: "see",
				media: [path],
			});
			expect(calls[0]!.url).toContain("/_matrix/media/v3/upload");
			expect(calls[1]!.url).toContain("/send/m.room.message/");
			const sent = JSON.parse(calls[1]!.body!) as {
				msgtype: string;
				url: string;
				body: string;
				info: { mimetype: string };
			};
			expect(sent.msgtype).toBe("m.image");
			expect(sent.url).toBe("mxc://host/abc");
			expect(sent.body).toBe("a.png");
			expect(sent.info.mimetype).toBe("image/png");
			expect(receipt.status).toBe("success");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("MattermostChannel media", () => {
	it("uploads files and posts with file_ids", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gateway-mm-"));
		try {
			const path = join(dir, "a.png");
			writeFileSync(path, "png-data");
			const posts: Array<{ url: string; body: unknown }> = [];
			const bus = new MessageBus();
			const channel = new MattermostChannel(
				{ serverUrl: "https://mm.example", token: "tok", allowFrom: ["*"] },
				bus,
				{
					socket: {
						connect: async () => {},
						send: () => {},
						onMessage: () => {},
						onClose: () => {},
						close: () => {},
					},
					fetchFn: async (url, init) => {
						if (String(url).endsWith("/api/v4/files")) return jsonResponse({ file_infos: [{ id: "fid-1" }] });
						posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
						return jsonResponse({ id: "p1" });
					},
				},
			);
			const receipt = await channel.send({
				channel: "mattermost",
				chatId: "ch-1",
				content: "attached",
				media: [path],
			});
			expect(posts).toHaveLength(1);
			expect(posts[0]).toMatchObject({
				url: "https://mm.example/api/v4/posts",
				body: { channel_id: "ch-1", message: "attached", file_ids: ["fid-1"] },
			});
			expect(receipt.status).toBe("success");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("EmailChannel media", () => {
	it("attaches MIME parts over SMTP and reports partial on missing files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gateway-mail-"));
		try {
			const path = join(dir, "a.txt");
			writeFileSync(path, "hello attachment");
			let written = "";
			const socket = new (class extends Duplex {
				_write(chunk: Buffer, _enc: BufferEncoding, callback: () => void): void {
					written += chunk.toString("utf-8");
					callback();
				}
				_read(): void {}
			})();
			const script = [
				"220 smtp.test ESMTP\r\n",
				"250-smtp.test\r\n250 AUTH LOGIN\r\n",
				"334 VXNlcm5hbWU6\r\n",
				"334 UGFzc3dvcmQ6\r\n",
				"235 2.7.0 Authentication successful\r\n",
				"250 2.1.0 ok\r\n",
				"250 2.1.5 ok\r\n",
				"354 End data with <CR><LF>.<CR><LF>\r\n",
				"250 2.0.0 ok\r\n",
				"221 2.0.0 bye\r\n",
			];
			for (const chunk of script) setImmediate(() => socket.push(chunk));
			const bus = new MessageBus();
			const channel = new EmailChannel(
				{ smtpHost: "smtp.test", smtpUser: "bot@example.com", smtpPassword: "secret", allowFrom: ["*"] },
				bus,
				{ socketFactory: () => socket },
			);
			const receipt = await channel.send({
				channel: "email",
				chatId: "alice@example.com",
				content: "see attachment",
				media: [path, "/nonexistent/missing.bin"],
			});
			expect(written).toContain("Content-Type: multipart/mixed;");
			expect(written).toContain('Content-Disposition: attachment; filename="a.txt"');
			expect(written).toContain(Buffer.from("hello attachment").toString("base64"));
			expect(written).toContain("[附件发送失败: missing.bin]");
			expect(receipt.status).toBe("partial");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 能力矩阵:不支持的媒体显式报错
// ---------------------------------------------------------------------------

describe("media capabilities", () => {
	it("throws on media kinds the channel does not declare", async () => {
		const bus = new MessageBus();
		const channel = new (class extends TelegramChannel {
			override get mediaCapabilities(): ChannelMediaCapabilities {
				return { kinds: ["image"], urlDirect: true };
			}
		})({ token: "tok", allowFrom: ["*"] }, bus, {
			post: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
		});
		await expect(
			channel.send({ channel: "telegram", chatId: "1", content: "x", media: ["doc.pdf"] }),
		).rejects.toThrow("telegram channel does not support file media");
	});
});
