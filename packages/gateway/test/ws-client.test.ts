import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketClient } from "../src/channels/onebot.ts";
import { GenericWsClient, WebSocketServer } from "../src/channels/ws-common.ts";
import { type FakeWsServer, startFakeWsServer } from "./fixtures/ws-server.ts";

let server: FakeWsServer | undefined;
let proxy: Server | undefined;
let secureServer: WebSocketServer | undefined;
let tlsDirectory: string | undefined;

afterEach(async () => {
	await server?.close();
	server = undefined;
	if (proxy) await new Promise<void>((resolve) => proxy?.close(() => resolve()));
	proxy = undefined;
	await secureServer?.close();
	secureServer = undefined;
	if (tlsDirectory) rmSync(tlsDirectory, { recursive: true, force: true });
	tlsDirectory = undefined;
	vi.unstubAllEnvs();
});

describe("WebSocketClient (zero-dependency)", () => {
	it("handshakes, sends masked actions and receives responses", async () => {
		server = await startFakeWsServer();
		const client = new WebSocketClient();
		await client.connect(`ws://127.0.0.1:${server.port}/onebot`);

		// Send an action; the fake server auto-responds with the echo.
		const result = await client.sendAction("ping", {});
		expect(result).toEqual({ pong: true });

		// The server received the masked frame with the action payload.
		expect(server.received.length).toBe(1);
		const parsed = JSON.parse(server.received[0]!) as { action: string; echo: number };
		expect(parsed.action).toBe("ping");
		expect(typeof parsed.echo).toBe("number");

		// Server-initiated events flow to the onEvent handler.
		client.close();
	});

	it("delivers server events to the event handler", async () => {
		server = await startFakeWsServer();
		const client = new WebSocketClient();
		const events: Record<string, unknown>[] = [];
		client.onEvent((event) => events.push(event));
		await client.connect(`ws://127.0.0.1:${server.port}/ws`);
		client.close();
		expect(events.length).toBe(0); // no server-initiated events in this fixture
	});

	it("can handshake again after reconnecting the same client", async () => {
		server = await startFakeWsServer();
		const client = new WebSocketClient();
		const url = `ws://127.0.0.1:${server.port}/reconnect`;

		await client.connect(url);
		expect(await client.sendAction("ping", {})).toEqual({ pong: true });
		client.close();
		await new Promise((resolve) => setTimeout(resolve, 20));

		await client.connect(url);
		expect(await client.sendAction("ping", {})).toEqual({ pong: true });
		client.close();
	});

	it("can handshake again after reconnecting the generic client", async () => {
		server = await startFakeWsServer();
		const client = new GenericWsClient();
		const url = `ws://127.0.0.1:${server.port}/reconnect`;

		await client.connect(url);
		client.close();
		await new Promise((resolve) => setTimeout(resolve, 20));

		await client.connect(url);
		client.close();
	});

	it("connects over WSS and forwards handshake authorization", async () => {
		tlsDirectory = mkdtempSync(join(tmpdir(), "gateway-onebot-wss-"));
		const keyFile = join(tlsDirectory, "key.pem");
		const certFile = join(tlsDirectory, "cert.pem");
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				keyFile,
				"-out",
				certFile,
				"-days",
				"1",
				"-subj",
				"/CN=localhost",
				"-addext",
				"subjectAltName=DNS:localhost",
			],
			{ stdio: "ignore" },
		);
		let authorization: string | undefined;
		secureServer = new WebSocketServer();
		secureServer.onUpgrade = (request) => {
			const header = request.headers.authorization;
			authorization = Array.isArray(header) ? header[0] : header;
			return true;
		};
		const port = await secureServer.listen(0, "127.0.0.1", { keyFile, certFile });
		const client = new WebSocketClient({ caFile: certFile, serverName: "localhost" });
		await client.connect(`wss://127.0.0.1:${port}/onebot`, { Authorization: "Bearer test-access-token" });

		expect(authorization).toBe("Bearer test-access-token");
		client.close();
	});

	it("uses the HTTP proxy for non-local WebSocket connections", async () => {
		server = await startFakeWsServer();
		let connectRequest = "";
		proxy = createServer((socket) => {
			let buffer = Buffer.alloc(0);
			const onData = (chunk: Buffer): void => {
				buffer = Buffer.concat([buffer, chunk]);
				const headerEnd = buffer.indexOf("\r\n\r\n");
				if (headerEnd === -1) return;
				connectRequest = buffer.subarray(0, headerEnd).toString("utf-8").split("\r\n")[0] ?? "";
				socket.removeListener("data", onData);
				const upstream = createConnection({ host: "127.0.0.1", port: server!.port });
				upstream.once("connect", () => {
					socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					socket.pipe(upstream);
					upstream.pipe(socket);
				});
				upstream.once("error", () => socket.destroy());
				socket.once("error", () => upstream.destroy());
			};
			socket.on("data", onData);
		});
		const proxyPort = await new Promise<number>((resolve, reject) => {
			proxy!.once("error", reject);
			proxy!.listen(0, "127.0.0.1", () => {
				const address = proxy!.address();
				if (address && typeof address !== "string") resolve(address.port);
				else reject(new Error("proxy did not bind to a TCP port"));
			});
		});
		vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${proxyPort}`);
		vi.stubEnv("http_proxy", "");
		vi.stubEnv("HTTPS_PROXY", "");
		vi.stubEnv("https_proxy", "");
		vi.stubEnv("ALL_PROXY", "");
		vi.stubEnv("all_proxy", "");
		vi.stubEnv("NO_PROXY", "");
		vi.stubEnv("no_proxy", "");

		const client = new GenericWsClient();
		await client.connect(`ws://127.0.0.1:${server.port}/proxy`);
		expect(connectRequest).toBe(`CONNECT 127.0.0.1:${server.port} HTTP/1.1`);
		client.close();
	});
});
