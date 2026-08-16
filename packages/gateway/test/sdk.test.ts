import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChannelSdk, createChannelSdk } from "../src/sdk.ts";

let sdk: ChannelSdk | undefined;

afterEach(async () => {
	await sdk?.stop();
	sdk = undefined;
});

describe("ChannelSdk", () => {
	it("normalizes inbound messages and sends replies without exposing channel internals", async () => {
		sdk = createChannelSdk({
			config: {
				channels: { web: { enabled: true, allowFrom: ["*"] } },
				web: { host: "127.0.0.1", port: 0 },
			},
			channels: ["web"],
		});

		const inbound = new Promise<{ channel: string; chatId: string; content: string }>((resolve) => {
			sdk?.onMessage((message) => resolve(message));
		});
		await sdk.start();

		const status = sdk.status();
		expect(status).toHaveLength(1);
		expect(status[0]).toMatchObject({ name: "web", running: true, ready: true, receives: true, sends: true });
		await expect(sdk.waitForReadiness({ timeoutMs: 100 })).resolves.toMatchObject([{ name: "web", ready: true }]);
		const port = status[0]?.port;
		expect(port).toBeTypeOf("number");

		const response = await fetch(`http://127.0.0.1:${port}/api/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ senderId: "user-1", chatId: "chat-1", content: "hello" }),
		});
		expect(response.status).toBe(202);
		expect(await inbound).toMatchObject({ channel: "web", chatId: "chat-1", content: "hello" });

		const receipt = await sdk.send({ channel: "web", chatId: "chat-1", content: "reply" });
		expect(receipt).toMatchObject({ channel: "web", chatId: "chat-1" });
		const history = await fetch(`http://127.0.0.1:${port}/api/history?chatId=chat-1`);
		expect(await history.json()).toMatchObject({
			items: expect.arrayContaining([expect.objectContaining({ role: "assistant", content: "reply" })]),
		});

		expect(sdk.capabilities("web")).toEqual({
			receives: true,
			sends: true,
			streaming: false,
			reasoning: false,
			fileEdits: false,
			progress: true,
			buttons: false,
		});
		await sdk.stop();
		expect(sdk.status()).toEqual([]);
	});

	it("does not start channels outside the selected set", async () => {
		sdk = createChannelSdk({
			config: { channels: { web: { enabled: true }, console: { enabled: true } } },
			channels: ["web"],
		});
		await sdk.start();

		expect(sdk.status().map((channel) => channel.name)).toEqual(["web"]);
	});

	it("hot-reloads channel policy and exposes management metrics", async () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-sdk-watch-"));
		const configPath = join(directory, "config.json");
		const config = (allowFrom: string[]) => ({
			channels: { web: { enabled: true, allowFrom } },
			web: { host: "127.0.0.1", port: 0 },
		});
		writeFileSync(configPath, JSON.stringify(config(["one"])));
		sdk = createChannelSdk({ configPath, watchConfig: { debounceMs: 10 } });
		try {
			await sdk.start();
			const initialPort = sdk.status()[0]?.port;
			const initial = await fetch(`http://127.0.0.1:${initialPort}/api/messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ senderId: "one", chatId: "c", content: "before" }),
			});
			expect(initial.status).toBe(202);
			writeFileSync(configPath, JSON.stringify(config(["two"])));
			await vi.waitFor(
				async () => {
					const port = sdk?.status()[0]?.port;
					const response = await fetch(`http://127.0.0.1:${port}/api/messages`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ senderId: "one", chatId: "c", content: "after" }),
					});
					expect((await response.json()) as { accepted?: boolean }).toMatchObject({ accepted: false });
				},
				{ timeout: 3000, interval: 20 },
			);

			const port = sdk.status()[0]?.port;
			const metrics = await fetch(`http://127.0.0.1:${port}/api/metrics`);
			expect(metrics.status).toBe(200);
			const metricsBody = (await metrics.json()) as { ok?: boolean; metrics?: { inboundAccepted?: number } };
			expect(metricsBody.ok).toBe(true);
			expect(metricsBody.metrics?.inboundAccepted).toBeGreaterThanOrEqual(1);
			const prometheus = await fetch(`http://127.0.0.1:${port}/metrics`);
			expect(await prometheus.text()).toContain("gateway_inbound_accepted");
		} finally {
			await sdk?.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
