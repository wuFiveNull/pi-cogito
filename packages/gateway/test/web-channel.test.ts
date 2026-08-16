import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent } from "../src/agent.ts";
import { MessageBus } from "../src/bus.ts";
import { OutboundDispatcher } from "../src/channels/dispatcher.ts";
import { WebChannel } from "../src/channels/web.ts";

const running: WebChannel[] = [];
const runningDispatchers: OutboundDispatcher[] = [];

async function startWebChannel(config?: Record<string, unknown>): Promise<WebChannel> {
	const bus = new MessageBus();
	const channel = new WebChannel(config, bus);
	await channel.start();
	running.push(channel);
	// Direct-channel tests still need the outbound dispatcher to route replies.
	const dispatcher = new OutboundDispatcher(bus, {
		get: (name: string) => (name === "web" ? channel : undefined),
	});
	dispatcher.start();
	runningDispatchers.push(dispatcher);
	return channel;
}

afterEach(async () => {
	for (const dispatcher of runningDispatchers.splice(0)) dispatcher.stop();
	for (const channel of running.splice(0)) await channel.stop();
});

/** POST a message to the web channel. */
async function postMessage(
	channel: WebChannel,
	body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
	const response = await fetch(`http://127.0.0.1:${channel.port}/api/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.text() };
}

describe("metadata passthrough", () => {
	it("forwards metadata (replyTo) on inbound messages", async () => {
		const bus = new MessageBus();
		const channel = new WebChannel({ allowFrom: ["*"] }, bus);
		await channel.start();
		running.push(channel);
		const inbound = bus.consumeInbound();
		const response = await fetch(`http://127.0.0.1:${channel.port}/api/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ senderId: "u", chatId: "c", content: "hi", metadata: { replyTo: "msg-1" } }),
		});
		expect(response.status).toBe(202);
		const message = await inbound;
		expect(message.content).toBe("hi");
		expect(message.metadata).toEqual({ replyTo: "msg-1" });
	});

	it("drops non-object metadata", async () => {
		const bus = new MessageBus();
		const channel = new WebChannel({ allowFrom: ["*"] }, bus);
		await channel.start();
		running.push(channel);
		const inbound = bus.consumeInbound();
		const response = await fetch(`http://127.0.0.1:${channel.port}/api/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ senderId: "u", chatId: "c", content: "hi", metadata: "nope" }),
		});
		expect(response.status).toBe(202);
		const message = await inbound;
		// Non-object metadata is dropped; the normalized message still carries
		// an empty metadata object (nanobot _handle_message always passes a dict).
		expect(message.metadata).toEqual({});
	});
});

describe("uploads", () => {
	it("stores an upload and serves it back via /api/media", async () => {
		const dir = mkdtempSync(join(tmpdir(), "uploads-"));
		const bus = new MessageBus();
		const channel = new WebChannel({ allowFrom: ["*"] }, bus, { uploadsDir: dir });
		await channel.start();
		running.push(channel);
		const base = `http://127.0.0.1:${channel.port}`;

		const upload = await fetch(`${base}/api/uploads`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				filename: "pic.png",
				mimeType: "image/png",
				data: Buffer.from("PNGDATA").toString("base64"),
			}),
		});
		expect(upload.status).toBe(200);
		const body = (await upload.json()) as { path: string; filename: string };
		expect(body.filename).toBe("pic.png");
		expect(body.path).toContain("/api/media?path=");

		const media = await fetch(`${base}${body.path}`);
		expect(media.status).toBe(200);
		expect(media.headers.get("content-type")).toContain("image/png");
		expect(await media.text()).toBe("PNGDATA");

		// 路径穿越被拒
		const evil = await fetch(`${base}/api/media?path=${encodeURIComponent("../x")}`);
		expect(evil.status).toBe(403);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("stop", () => {
	it("broadcasts a stopped event to the chat's SSE subscribers", async () => {
		const bus = new MessageBus();
		const channel = new WebChannel({ allowFrom: ["*"] }, bus);
		await channel.start();
		running.push(channel);
		const base = `http://127.0.0.1:${channel.port}`;

		const events: string[] = [];
		const response = await fetch(`${base}/api/stream?chatId=stop-1`);
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const readLoop = (async () => {
			while (true) {
				const { done, value } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				for (const line of buffer.split("\n")) {
					if (line.startsWith("event: ")) events.push(line.slice(7));
				}
			}
		})();

		const stop = await fetch(`${base}/api/stop`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId: "stop-1" }),
		});
		expect(stop.status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 100));
		reader.cancel();
		await readLoop.catch(() => undefined);
		expect(events).toContain("stopped");

		// 缺 chatId → 400
		const bad = await fetch(`${base}/api/stop`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(bad.status).toBe(400);
	});
});

/** Open an SSE subscription and collect events until `until` matches. */
async function collectStream(
	channel: WebChannel,
	chatId: string,
	until: (events: Array<{ event: string; data: unknown }>) => boolean,
	timeoutMs = 5000,
): Promise<Array<{ event: string; data: unknown }>> {
	const events: Array<{ event: string; data: unknown }> = [];
	let buffer = "";

	const response = await fetch(`http://127.0.0.1:${channel.port}/api/stream?chatId=${encodeURIComponent(chatId)}`);
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();

	const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timeout")), timeoutMs));

	try {
		await Promise.race([
			(async () => {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					let boundary = buffer.indexOf("\n\n");
					while (boundary !== -1) {
						const frame = buffer.slice(0, boundary);
						buffer = buffer.slice(boundary + 2);
						boundary = buffer.indexOf("\n\n");
						let event = "message";
						let data = "";
						for (const line of frame.split("\n")) {
							if (line.startsWith("event: ")) event = line.slice(7);
							else if (line.startsWith("data: ")) data += line.slice(6);
						}
						if (data) {
							events.push({ event, data: JSON.parse(data) });
							if (until(events)) return;
						}
					}
				}
			})(),
			timeout,
		]);
	} finally {
		reader.cancel().catch(() => {});
	}
	return events;
}

describe("WebChannel", () => {
	it("protects API routes with a configured token and limits request bursts", async () => {
		const bus = new MessageBus();
		const channel = new WebChannel(
			{
				allowFrom: ["*"],
				auth: { token: "secret" },
				rateLimit: { maxRequests: 1, windowMs: 10_000 },
			},
			bus,
		);
		await channel.start();
		running.push(channel);
		const base = `http://127.0.0.1:${channel.port}`;

		const unauthorized = await fetch(`${base}/api/status`);
		expect(unauthorized.status).toBe(401);
		const headers = { "Content-Type": "application/json", Authorization: "Bearer secret" };
		const first = await fetch(`${base}/api/messages`, {
			method: "POST",
			headers,
			body: JSON.stringify({ senderId: "u", chatId: "c", content: "one" }),
		});
		expect(first.status).toBe(202);
		const limited = await fetch(`${base}/api/messages`, {
			method: "POST",
			headers,
			body: JSON.stringify({ senderId: "u", chatId: "c", content: "two" }),
		});
		expect(limited.status).toBe(429);
	});

	it("verifies signed webhook bodies with a replay window", async () => {
		const bus = new MessageBus();
		const channel = new WebChannel(
			{
				allowFrom: ["*"],
				auth: { signature: { secret: "webhook-secret", timestampHeader: "x-webhook-timestamp" } },
			},
			bus,
		);
		await channel.start();
		running.push(channel);
		const body = JSON.stringify({ senderId: "u", chatId: "signed", content: "hello" });
		const timestamp = String(Date.now());
		const signature = createHmac("sha256", "webhook-secret").update(`${timestamp}.${body}`).digest("hex");
		const headers = {
			"Content-Type": "application/json",
			"x-webhook-timestamp": timestamp,
			"x-webhook-signature": `sha256=${signature}`,
		};
		const accepted = await fetch(`http://127.0.0.1:${channel.port}/api/messages`, {
			method: "POST",
			headers,
			body,
		});
		expect(accepted.status).toBe(202);

		const rejected = await fetch(`http://127.0.0.1:${channel.port}/api/messages`, {
			method: "POST",
			headers: { ...headers, "x-webhook-signature": "sha256=bad" },
			body,
		});
		expect(rejected.status).toBe(401);
	});

	it("exposes health and validates message bodies", async () => {
		const channel = await startWebChannel({ allowFrom: ["*"] });

		const health = await fetch(`http://127.0.0.1:${channel.port}/api/health`);
		expect(health.status).toBe(200);
		await expect(health.json()).resolves.toEqual({ ok: true });

		const bad = await postMessage(channel, { senderId: "u1" }); // missing chatId/content
		expect(bad.status).toBe(400);

		const notJson = await fetch(`http://127.0.0.1:${channel.port}/api/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not-json",
		});
		expect(notJson.status).toBe(400);
	});

	it("delivers a full agent reply to the subscribed chat", async () => {
		const channel = await startWebChannel({ allowFrom: ["*"] });
		const bus = (channel as unknown as { bus: MessageBus }).bus;
		const agent = new FakeAgent(bus);
		agent.start();

		const stream = collectStream(channel, "chat-1", (events) => events.some((event) => event.event === "message"));

		await postMessage(channel, { senderId: "u1", chatId: "chat-1", content: "你好" });

		const events = await stream;
		const reply = events.find((event) => event.event === "message");
		expect(reply?.data).toMatchObject({
			channel: "web",
			chatId: "chat-1",
			content: "[web] 收到: 你好",
		});
		agent.stop();
	});

	it("isolates replies per chatId", async () => {
		const channel = await startWebChannel({ allowFrom: ["*"] });
		const bus = (channel as unknown as { bus: MessageBus }).bus;
		const agent = new FakeAgent(bus);
		agent.start();

		const streamA = collectStream(channel, "chat-a", (events) => events.length >= 1);
		await postMessage(channel, { senderId: "u1", chatId: "chat-a", content: "A" });
		await streamA; // chat-a got its reply

		// A new subscription to chat-b must NOT receive chat-a's reply.
		const eventsB: Array<{ event: string; data: unknown }> = [];
		const response = await fetch(`http://127.0.0.1:${channel.port}/api/stream?chatId=chat-b`);
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000));
		await Promise.race([
			(async () => {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					const text = decoder.decode(value, { stream: true });
					if (text.includes("event: message")) {
						eventsB.push({ event: "message", data: null });
						break;
					}
				}
			})(),
			timeout.catch(() => {}),
		]);
		await reader.cancel().catch(() => {});
		expect(eventsB.length).toBe(0);
		agent.stop();
	});

	it("denies unauthorized senders", async () => {
		const channel = await startWebChannel({ allowFrom: ["trusted"] });
		const bus = (channel as unknown as { bus: MessageBus }).bus;
		const agent = new FakeAgent(bus);
		agent.start();

		const stream = collectStream(channel, "chat-x", (events) => events.length >= 1);
		// Unauthorized sender: message accepted by HTTP but dropped by the channel.
		await postMessage(channel, { senderId: "stranger", chatId: "chat-x", content: "hi" });
		const events = await Promise.race([
			stream,
			new Promise<Array<{ event: string; data: unknown }>>((resolve) => setTimeout(() => resolve([]), 800)),
		]);
		expect(events.length).toBe(0);
		agent.stop();
	});

	it("streams deltas when streaming is enabled", async () => {
		const channel = await startWebChannel({ allowFrom: ["*"], streaming: true });
		const bus = (channel as unknown as { bus: MessageBus }).bus;
		const agent = new FakeAgent(bus, { stream: true, replyDelayMs: 5 });
		agent.start();

		const stream = collectStream(channel, "chat-s", (events) =>
			events.some(
				(event) => event.event === "delta" && (event.data as { streamEnd?: boolean } | null)?.streamEnd === true,
			),
		);

		await postMessage(channel, { senderId: "u1", chatId: "chat-s", content: "流式回复" });

		const events = await stream;
		const deltas = events.filter((event) => event.event === "delta");
		expect(deltas.length).toBeGreaterThan(1);
		const full = deltas.map((event) => (event.data as { delta?: string }).delta ?? "").join("");
		expect(full).toContain("流式回复");
		agent.stop();
	});
});
