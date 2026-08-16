import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent } from "../src/agent.ts";
import { MessageBus } from "../src/bus.ts";
import { OutboundDispatcher } from "../src/channels/dispatcher.ts";
import { WebSocketChannel } from "../src/channels/websocket.ts";
import { GenericWsClient } from "../src/channels/ws-common.ts";

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of running.splice(0)) await cleanup();
});

async function startChannel(config?: Record<string, unknown>) {
	const bus = new MessageBus();
	const channel = new WebSocketChannel({ allowFrom: ["*"], streaming: true, ...config }, bus);
	await channel.start();
	const dispatcher = new OutboundDispatcher(bus, {
		get: (name: string) => (name === "websocket" ? channel : undefined),
	});
	dispatcher.start();
	running.push(async () => {
		dispatcher.stop();
		await channel.stop();
	});
	return { bus, channel };
}

/** Collect JSON frames from a client until `until` matches. */
async function collect(client: GenericWsClient, until: (frames: unknown[]) => boolean, timeoutMs = 3000) {
	const frames: unknown[] = [];
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
		client.onMessage((text) => {
			const frame = JSON.parse(text) as unknown;
			frames.push(frame);
			if (until(frames)) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	return frames;
}

describe("WebSocketChannel", () => {
	it("subscribes, sends, and receives the reply over WS", async () => {
		const { bus, channel } = await startChannel();
		const agent = new FakeAgent(bus, { replyDelayMs: 5 });
		agent.start();

		const client = new GenericWsClient();
		await client.connect(`ws://127.0.0.1:${channel.port}`);

		const stream = collect(client, (frames) => frames.some((f) => (f as { type?: string }).type === "message"));

		client.send(JSON.stringify({ type: "subscribe", chatId: "ws-chat-1" }));
		client.send(JSON.stringify({ type: "message", chatId: "ws-chat-1", content: "你好", senderId: "u1" }));

		const frames = await stream;
		const message = frames.find((f) => (f as { type?: string }).type === "message");
		expect(message).toMatchObject({ chatId: "ws-chat-1", content: "[websocket] 收到: 你好" });

		client.close();
		agent.stop();
	});

	it("streams deltas when streaming is enabled", async () => {
		const { bus, channel } = await startChannel();
		const agent = new FakeAgent(bus, { stream: true, replyDelayMs: 5 });
		agent.start();

		const client = new GenericWsClient();
		await client.connect(`ws://127.0.0.1:${channel.port}`);

		const stream = collect(client, (frames) =>
			frames.some(
				(f) => (f as { type?: string }).type === "delta" && (f as { streamEnd?: boolean }).streamEnd === true,
			),
		);

		client.send(JSON.stringify({ type: "subscribe", chatId: "ws-chat-1" }));
		client.send(JSON.stringify({ type: "message", chatId: "ws-chat-1", content: "你好", senderId: "u1" }));

		const frames = await stream;
		const deltas = frames.filter((f) => (f as { type?: string }).type === "delta");
		expect(deltas.length).toBeGreaterThan(1);
		expect(deltas.map((d) => (d as { delta?: string }).delta ?? "").join("")).toContain("你好");

		client.close();
		agent.stop();
	});

	it("rejects invalid payloads and isolates per-chat subscriptions", async () => {
		const { channel } = await startChannel();
		const client = new GenericWsClient();
		await client.connect(`ws://127.0.0.1:${channel.port}`);

		const frames: unknown[] = [];
		client.onMessage((text) => frames.push(JSON.parse(text) as unknown));

		client.send("not-json");
		client.send(JSON.stringify({ type: "message", chatId: "c1" })); // missing content
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(frames).toHaveLength(2);
		expect(frames[0]).toMatchObject({ type: "system", text: "invalid JSON" });
		expect(frames[1]).toMatchObject({ type: "system", text: "chatId and content are required" });
		client.close();
	});
});
