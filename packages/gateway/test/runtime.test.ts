import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelAgentRuntime } from "../src/runtime.ts";
import { type ChannelSdk, createChannelSdk } from "../src/sdk.ts";

let runtime: ChannelAgentRuntime | undefined;
let sdk: ChannelSdk | undefined;

afterEach(async () => {
	await runtime?.stop();
	runtime = undefined;
	sdk = undefined;
});

describe("ChannelAgentRuntime", () => {
	it("routes replies through the originating channel", async () => {
		sdk = createChannelSdk({
			config: { channels: { web: { enabled: true, allowFrom: ["*"] } }, web: { host: "127.0.0.1", port: 0 } },
			channels: ["web"],
		});
		runtime = new ChannelAgentRuntime({
			sdk,
			handleMessage: async (message) => `reply:${message.content}`,
		});
		await runtime.start();

		const port = sdk.status()[0]?.port;
		expect(port).toBeTypeOf("number");
		const response = await fetch(`http://127.0.0.1:${port}/api/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ senderId: "user-1", chatId: "chat-1", content: "hello" }),
		});
		expect(response.status).toBe(202);

		await vi.waitFor(
			async () => {
				const history = await fetch(`http://127.0.0.1:${port}/api/history?chatId=chat-1`);
				const body = (await history.json()) as { items?: unknown };
				expect(body.items).toEqual(
					expect.arrayContaining([expect.objectContaining({ role: "assistant", content: "reply:hello" })]),
				);
			},
			{ timeout: 2000, interval: 20 },
		);
	});

	it("serializes messages in the same chat", async () => {
		sdk = createChannelSdk({
			config: { channels: { web: { enabled: true, allowFrom: ["*"] } }, web: { host: "127.0.0.1", port: 0 } },
			channels: ["web"],
		});
		let active = 0;
		let maximumActive = 0;
		runtime = new ChannelAgentRuntime({
			sdk,
			handleMessage: async (message) => {
				active++;
				maximumActive = Math.max(maximumActive, active);
				await new Promise((resolve) => setTimeout(resolve, 30));
				active--;
				return message.content;
			},
		});
		await runtime.start();
		const port = sdk.status()[0]?.port;
		expect(port).toBeTypeOf("number");

		const post = (content: string) =>
			fetch(`http://127.0.0.1:${port}/api/messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ senderId: "user-1", chatId: "chat-1", content }),
			});
		await Promise.all([post("first"), post("second")]);

		await vi.waitFor(
			async () => {
				const history = await fetch(`http://127.0.0.1:${port}/api/history?chatId=chat-1`);
				const body = (await history.json()) as { items?: unknown };
				expect(body.items).toHaveLength(4);
			},
			{ timeout: 2000, interval: 20 },
		);
		expect(maximumActive).toBe(1);
	});
});
