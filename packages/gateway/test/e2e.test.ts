import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent } from "../src/agent.ts";
import { MessageBus } from "../src/bus.ts";
import { ChannelRegistry, type GatewayConfig } from "../src/channels/registry.ts";
import { WebChannel } from "../src/channels/web.ts";

let registry: ChannelRegistry | undefined;
let bus: MessageBus | undefined;

async function startGateway(config?: GatewayConfig): Promise<{ registry: ChannelRegistry; bus: MessageBus }> {
	bus = new MessageBus();
	registry = new ChannelRegistry();
	await registry.startAll(config ?? {}, bus);
	return { registry, bus };
}

afterEach(async () => {
	await registry?.stopAll();
	registry = undefined;
	bus = undefined;
});

describe("end-to-end gateway", () => {
	it("web client -> bus -> fake agent -> bus -> web client (full reply)", async () => {
		const { registry, bus } = await startGateway({ channels: { web: { allowFrom: ["*"] } } });
		const channel = registry.get("web") as WebChannel;
		expect(channel).toBeInstanceOf(WebChannel);

		const agent = new FakeAgent(bus);
		agent.start();

		// Subscribe over SSE, then send a message over HTTP.
		const response = await fetch(`http://127.0.0.1:${channel.port}/api/stream?chatId=e2e-1`);
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let received: { event: string; data: unknown } | undefined;

		const done = new Promise<void>((resolve) => {
			void (async () => {
				for (;;) {
					const { done: finished, value } = await reader.read();
					if (finished) break;
					buffer += decoder.decode(value, { stream: true });
					const boundary = buffer.indexOf("\n\n");
					if (boundary !== -1) {
						const frame = buffer.slice(0, boundary);
						buffer = buffer.slice(boundary + 2);
						let event = "message";
						let data = "";
						for (const line of frame.split("\n")) {
							if (line.startsWith("event: ")) event = line.slice(7);
							else if (line.startsWith("data: ")) data += line.slice(6);
						}
						if (data && event === "message") {
							received = { event, data: JSON.parse(data) };
							resolve();
							return;
						}
					}
				}
			})();
		});

		const post = await fetch(`http://127.0.0.1:${channel.port}/api/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ senderId: "e2e-user", chatId: "e2e-1", content: "完整链路测试" }),
		});
		expect(post.status).toBe(202);

		await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("e2e timeout")), 5000))]);
		await reader.cancel().catch(() => {});

		expect(received?.data).toMatchObject({
			channel: "web",
			chatId: "e2e-1",
			content: "[web] 收到: 完整链路测试",
		});
		agent.stop();
	});

	it("startAll creates the web channel by default", async () => {
		const { registry } = await startGateway();
		expect(registry.get("web")).toBeInstanceOf(WebChannel);
	});

	it("respects channels.web.enabled=false", async () => {
		const { registry } = await startGateway({ channels: { web: { enabled: false } } });
		expect(registry.get("web")).toBeUndefined();
	});
});
