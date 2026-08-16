/**
 * Minimal WebSocket server for tests: HTTP upgrade + unmasked text frames.
 * Speaks enough OneBot-like protocol to exercise WebSocketClient.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";

export interface FakeWsServer {
	server: Server;
	port: number;
	/** Messages received from clients. */
	received: string[];
	close(): Promise<void>;
}

export function startFakeWsServer(): Promise<FakeWsServer> {
	const received: string[] = [];
	const clientSockets = new Set<Duplex>();
	let clientBuffer = Buffer.alloc(0);

	const server = createServer((_req, res) => {
		res.writeHead(404);
		res.end();
	});
	server.on("upgrade", (req, socket) => {
		const key = req.headers["sec-websocket-key"] ?? "";
		const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		clientSockets.add(socket);
		socket.on("data", (chunk: Buffer) => {
			clientBuffer = Buffer.concat([clientBuffer, chunk]);
			// Server receives masked frames: parse opcode + length, unmask.
			for (;;) {
				if (clientBuffer.length < 2) return;
				const opcode = clientBuffer[0]! & 0x0f;
				const masked = (clientBuffer[1]! & 0x80) !== 0;
				let length = clientBuffer[1]! & 0x7f;
				let offset = 2;
				if (length === 126) {
					if (clientBuffer.length < 4) return;
					length = clientBuffer.readUInt16BE(2);
					offset = 4;
				} else if (length === 127) {
					if (clientBuffer.length < 10) return;
					length = Number(clientBuffer.readBigUInt64BE(2));
					offset = 10;
				}
				let maskKey = Buffer.alloc(0);
				if (masked) {
					if (clientBuffer.length < offset + 4) return;
					maskKey = clientBuffer.subarray(offset, offset + 4);
					offset += 4;
				}
				if (clientBuffer.length < offset + length) return;
				let payload = clientBuffer.subarray(offset, offset + length);
				if (masked) {
					const unmasked = Buffer.alloc(length);
					for (let i = 0; i < length; i++) unmasked[i] = payload[i]! ^ maskKey[i % 4]!;
					payload = unmasked;
				}
				clientBuffer = clientBuffer.subarray(offset + length);
				if (opcode === 0x1) {
					received.push(payload.toString("utf-8"));
					// Auto-respond to a "ping" action with an echo response.
					try {
						const message = JSON.parse(payload.toString("utf-8"));
						if (message.action === "ping") {
							sendText(
								socket,
								JSON.stringify({ status: "ok", retcode: 0, echo: message.echo, data: { pong: true } }),
							);
						}
					} catch {
						// ignore
					}
				}
			}
		});
		socket.on("close", () => {
			clientSockets.delete(socket);
		});
	});

	function sendText(socket: Duplex, text: string): void {
		const payload = Buffer.from(text, "utf-8");
		let header: Buffer;
		if (payload.length < 126) {
			header = Buffer.from([0x81, payload.length]);
		} else {
			header = Buffer.alloc(4);
			header[0] = 0x81;
			header[1] = 126;
			header.writeUInt16BE(payload.length, 2);
		}
		socket.write(Buffer.concat([header, payload]));
	}

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			resolve({
				server,
				port,
				received,
				close: () =>
					new Promise<void>((done) => {
						for (const socket of clientSockets) socket.destroy();
						server.closeAllConnections();
						server.close(() => done());
					}),
			});
		});
	});
}
