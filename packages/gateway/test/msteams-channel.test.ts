import { createSign, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { MSTeamsChannel } from "../src/channels/msteams.ts";
import type { OutboundMessage } from "../src/types.ts";

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of running.splice(0)) await cleanup();
});

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string; kid: string };

function base64url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

function mintJwt(payload: Record<string, unknown>, kid = "key-1"): string {
	const header = base64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
	const body = base64url(JSON.stringify(payload));
	const sign = createSign("RSA-SHA256");
	sign.update(`${header}.${body}`);
	const signature = sign.sign(privateKey, "base64url");
	return `${header}.${body}.${signature}`;
}

/** fetchFn serving the OpenID config, JWKS and outbound endpoints. */
function makeFetch(serviceCalls: Array<{ url: string; body?: unknown }>) {
	return vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const u = String(url);
		if (u.includes("/v1/.well-known/openidconfiguration")) {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					issuer: "https://api.botframework.com",
					jwks_uri: "https://login.botframework.com/v1/.well-known/keys",
				}),
			} as Response;
		}
		if (u.includes("/v1/.well-known/keys")) {
			return { ok: true, status: 200, json: async () => ({ keys: [{ ...jwk, kid: "key-1" }] }) } as Response;
		}
		if (u.includes("/oauth2/v2.0/token")) {
			return {
				ok: true,
				status: 200,
				json: async () => ({ access_token: "outbound-token", expires_in: 3600 }),
			} as Response;
		}
		serviceCalls.push({ url: u, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
		return { ok: true, status: 200, json: async () => ({ id: "act-1" }) } as Response;
	});
}

async function startTeams(fetchFn: typeof fetch, overrides: Record<string, unknown> = {}) {
	const bus = new MessageBus();
	const channel = new MSTeamsChannel(
		{
			appId: "app-1",
			appPassword: "pw",
			tenantId: "tenant-1",
			callbackPort: 0,
			allowFrom: ["*"],
			...overrides,
		},
		bus,
		{ fetchFn },
	);
	await channel.start();
	running.push(async () => void channel.stop());
	return { bus, channel };
}

function activity(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "message",
		id: "a-100",
		from: { id: "user:alice", name: "Alice" },
		conversation: { id: "conv:19:chat" },
		text: "hello teams",
		serviceUrl: "https://smba.example.com",
		channelId: "msteams",
		...overrides,
	});
}

describe("MSTeamsChannel", () => {
	it("rejects activities without a valid Bearer JWT", async () => {
		const { channel } = await startTeams(makeFetch([]));
		const response = await fetch(`http://127.0.0.1:${channel.port}/api/messages`, {
			method: "POST",
			body: activity(),
		});
		expect(response.status).toBe(401);
	});

	it("normalizes verified activities into inbound messages", async () => {
		const { bus, channel } = await startTeams(makeFetch([]));
		const token = mintJwt({ iss: "https://api.botframework.com", aud: "app-1" });
		const inbound = bus.consumeInbound();
		const response = await fetch(`http://127.0.0.1:${channel.port}/api/messages`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: activity(),
		});
		expect(response.status).toBe(200);
		const received = await inbound;
		expect(received).toMatchObject({
			channel: "msteams",
			senderId: "user:alice",
			chatId: "conv:19:chat",
			content: "hello teams",
		});
		expect(received.metadata).toMatchObject({ channelId: "msteams", serviceUrl: "https://smba.example.com" });
	});

	it("rejects tokens signed by an unknown key", async () => {
		const { channel } = await startTeams(makeFetch([]));
		const token = mintJwt({ iss: "https://api.botframework.com", aud: "app-1" }, "unknown-kid");
		const response = await fetch(`http://127.0.0.1:${channel.port}/api/messages`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: activity(),
		});
		expect(response.status).toBe(401);
	});

	it("replies to the conversation via the learned serviceUrl", async () => {
		const serviceCalls: Array<{ url: string; body?: unknown }> = [];
		const { bus, channel } = await startTeams(makeFetch(serviceCalls));
		const token = mintJwt({ iss: "https://api.botframework.com", aud: "app-1" });
		await fetch(`http://127.0.0.1:${channel.port}/api/messages`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: activity(),
		});
		await bus.consumeInbound();
		await channel.send({
			channel: "msteams",
			chatId: "conv:19:chat",
			content: "reply",
			replyTo: "a-100",
		} as OutboundMessage);
		expect(serviceCalls).toHaveLength(1);
		expect(serviceCalls[0]!.url).toBe(
			"https://smba.example.com/v3/conversations/conv%3A19%3Achat/activities/a-100/replyTo",
		);
		expect(serviceCalls[0]!.body).toMatchObject({ type: "message", text: "reply" });
	});

	it("throws for unknown conversations (proactive without prior activity)", async () => {
		const { channel } = await startTeams(makeFetch([]));
		await expect(
			channel.send({ channel: "msteams", chatId: "conv:unknown", content: "hi" } as OutboundMessage),
		).rejects.toThrow(/unknown conversation/);
	});
});
