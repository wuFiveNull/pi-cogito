/**
 * Zero-dependency WebSocket primitives shared by channels:
 * - frame encode/decode (RFC 6455, client<->server masking rules)
 * - GenericWsClient (client with custom headers)
 * - WebSocketServer (server over node:http upgrade)
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { type ChannelTlsOptions, readTlsOptions } from "../tls.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKey(key: string): string {
	return createHash("sha1")
		.update(key + WS_GUID)
		.digest("base64");
}

/** Decode frames from incoming data. `clientToServer` enforces masking rules. */
function readFrames(
	state: { buffer: Buffer },
	data: Buffer,
	clientToServer: boolean,
): { texts: string[]; binaries: Buffer[]; pings: Buffer[]; close: boolean } {
	state.buffer = Buffer.concat([state.buffer, data]);
	const texts: string[] = [];
	const binaries: Buffer[] = [];
	const pings: Buffer[] = [];
	let close = false;
	for (;;) {
		const b = state.buffer;
		if (b.length < 2) break;
		const fin = (b[0]! & 0x80) !== 0;
		const opcode = b[0]! & 0x0f;
		const masked = (b[1]! & 0x80) !== 0;
		let length = b[1]! & 0x7f;
		let offset = 2;
		if (length === 126) {
			if (b.length < 4) break;
			length = b.readUInt16BE(2);
			offset = 4;
		} else if (length === 127) {
			if (b.length < 10) break;
			length = Number(b.readBigUInt64BE(2));
			offset = 10;
		}
		if (clientToServer && !masked) return { texts, binaries, pings, close: true };
		if (!clientToServer && masked) return { texts, binaries, pings, close: true };
		let maskKey: Buffer | undefined;
		if (clientToServer) {
			if (b.length < offset + 4) break;
			maskKey = b.subarray(offset, offset + 4);
			offset += 4;
		}
		if (b.length < offset + length) break;
		const payload = b.subarray(offset, offset + length);
		if (maskKey) {
			for (let i = 0; i < payload.length; i++) payload[i]! ^= maskKey[i % 4];
		}
		if (opcode === 0x1 && fin) texts.push(payload.toString("utf-8"));
		else if (opcode === 0x2 && fin) binaries.push(Buffer.from(payload));
		else if (opcode === 0x8) close = true;
		else if (opcode === 0x9) pings.push(Buffer.from(payload));
		state.buffer = b.subarray(offset + length);
	}
	return { texts, binaries, pings, close };
}

/** Encode one frame. Client frames must be masked, server frames must not. */
export function encodeFrame(opcode: number, payload: Buffer, masked: boolean): Buffer {
	let header: Buffer;
	if (payload.length < 126) {
		header = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | payload.length]);
	} else if (payload.length < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = (masked ? 0x80 : 0) | 126;
		header.writeUInt16BE(payload.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = (masked ? 0x80 : 0) | 127;
		header.writeBigUInt64BE(BigInt(payload.length), 2);
	}
	if (!masked) return Buffer.concat([header, payload]);
	const mask = randomBytes(4);
	const maskedPayload = Buffer.alloc(payload.length);
	for (let i = 0; i < payload.length; i++) maskedPayload[i] = payload[i]! ^ mask[i % 4]!;
	return Buffer.concat([header, mask, maskedPayload]);
}

/** Minimal WebSocket client interface (also satisfied by test doubles). */
export interface WsLike {
	connect(url: string, headers?: Record<string, string>): Promise<void>;
	send(text: string): void;
	/** Optional binary frame support (e.g. Feishu protobuf frames). */
	sendBinary?(data: Uint8Array): void;
	onMessage(handler: (text: string) => void): void;
	/** Optional binary frame handler. */
	onBinary?(handler: (data: Uint8Array) => void): void;
	onClose(handler: () => void): void;
	close(): void;
}

type NetworkSocket = Socket | TLSSocket;

const WS_CONNECT_TIMEOUT_MS = 15_000;

function firstEnv(...names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function targetAuthority(target: URL): string {
	const host = target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname;
	const port = target.port || (target.protocol === "wss:" ? "443" : "80");
	return `${host}:${port}`;
}

function matchesNoProxy(target: URL, entry: string): boolean {
	const value = entry.trim().toLowerCase();
	if (!value || value === "*") return true;

	const separator = value.lastIndexOf(":");
	const hasPort = separator > -1 && value.indexOf(":") === separator;
	const host = (hasPort ? value.slice(0, separator) : value).replace(/^\[|\]$/g, "").replace(/^\./, "");
	const port = hasPort ? value.slice(separator + 1) : undefined;
	const targetHost = target.hostname.toLowerCase().replace(/\.$/, "");
	const targetPort = target.port || (target.protocol === "wss:" ? "443" : "80");
	return (!port || port === targetPort) && (targetHost === host || targetHost.endsWith(`.${host}`));
}

function resolveProxy(target: URL): URL | undefined {
	const noProxy = firstEnv("NO_PROXY", "no_proxy");
	if (noProxy?.split(",").some((entry) => matchesNoProxy(target, entry))) return undefined;

	const proxyValue =
		target.protocol === "wss:"
			? firstEnv("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy")
			: firstEnv("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy");
	if (!proxyValue) return undefined;

	const proxy = new URL(proxyValue);
	if (proxy.protocol !== "http:") {
		throw new Error(`unsupported WebSocket proxy protocol: ${proxy.protocol}`);
	}
	return proxy;
}

function connectDirect(target: URL): Promise<NetworkSocket> {
	return new Promise((resolve, reject) => {
		const isTls = target.protocol === "wss:";
		const socket = isTls
			? tlsConnect({
					host: target.hostname,
					port: Number(target.port || 443),
					servername: target.hostname,
				})
			: createConnection({ host: target.hostname, port: Number(target.port || 80) });
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error) {
				socket.destroy();
				reject(error);
			} else {
				resolve(socket);
			}
		};
		const timeout = setTimeout(
			() => finish(new Error(`WebSocket connection timed out after ${WS_CONNECT_TIMEOUT_MS}ms`)),
			WS_CONNECT_TIMEOUT_MS,
		);
		socket.once(isTls ? "secureConnect" : "connect", () => finish());
		socket.once("error", (error) => finish(error));
	});
}

function connectViaHttpProxy(target: URL, proxy: URL): Promise<NetworkSocket> {
	return new Promise((resolve, reject) => {
		const proxySocket = createConnection({ host: proxy.hostname, port: Number(proxy.port || 80) });
		let responseBuffer = Buffer.alloc(0);
		let settled = false;
		const finish = (error?: Error, socket?: NetworkSocket): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error) {
				proxySocket.destroy();
				reject(error);
			} else if (socket) {
				resolve(socket);
			} else {
				reject(new Error("WebSocket proxy connection closed before CONNECT completed"));
			}
		};
		const timeout = setTimeout(
			() => finish(new Error(`WebSocket proxy connection timed out after ${WS_CONNECT_TIMEOUT_MS}ms`)),
			WS_CONNECT_TIMEOUT_MS,
		);
		const onData = (chunk: Buffer): void => {
			responseBuffer = Buffer.concat([responseBuffer, chunk]);
			const headerEnd = responseBuffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;

			proxySocket.removeListener("data", onData);
			const header = responseBuffer.subarray(0, headerEnd).toString("utf-8");
			const statusCode = Number(header.match(/^HTTP\/\d\.\d\s+(\d+)/)?.[1] ?? 0);
			if (statusCode < 200 || statusCode >= 300) {
				finish(new Error(`WebSocket proxy CONNECT failed: ${header.split("\r\n")[0] ?? "unknown response"}`));
				return;
			}

			const remainder = responseBuffer.subarray(headerEnd + 4);
			proxySocket.pause();
			if (remainder.length > 0) proxySocket.unshift(remainder);
			if (target.protocol === "wss:") {
				const secureSocket = tlsConnect({ socket: proxySocket, servername: target.hostname });
				secureSocket.once("secureConnect", () => finish(undefined, secureSocket));
				secureSocket.once("error", (error) => finish(error));
				return;
			}
			proxySocket.resume();
			finish(undefined, proxySocket);
		};

		proxySocket.on("connect", () => {
			const auth =
				proxy.username || proxy.password
					? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
					: "";
			proxySocket.write(
				`CONNECT ${targetAuthority(target)} HTTP/1.1\r\nHost: ${targetAuthority(target)}\r\n${auth}\r\n`,
			);
		});
		proxySocket.on("data", onData);
		proxySocket.once("error", (error) => finish(error));
		proxySocket.once("close", () => finish());
	});
}

async function openNetworkSocket(target: URL): Promise<NetworkSocket> {
	const proxy = resolveProxy(target);
	return proxy ? connectViaHttpProxy(target, proxy) : connectDirect(target);
}

/** RFC 6455 client with custom headers (used by mattermost/slack/discord). */
export class GenericWsClient implements WsLike {
	private socket: Socket | TLSSocket | undefined;
	private messageHandler: ((text: string) => void) | undefined;
	private binaryHandler: ((data: Uint8Array) => void) | undefined;
	private closeHandler: (() => void) | undefined;
	private closed = false;

	connect(url: string, headers: Record<string, string> = {}): Promise<void> {
		this.closed = false;
		this.handshakeDone = false;
		this.buffer = Buffer.alloc(0);
		return new Promise((resolve, reject) => {
			const parsed = new URL(url);
			void openNetworkSocket(parsed).then((socket) => {
				this.socket = socket;
				const key = randomBytes(16).toString("base64");
				const headerLines = [
					`GET ${parsed.pathname || "/"}${parsed.search} HTTP/1.1`,
					`Host: ${parsed.host}`,
					"Upgrade: websocket",
					"Connection: Upgrade",
					`Sec-WebSocket-Key: ${key}`,
					"Sec-WebSocket-Version: 13",
				];
				for (const [name, value] of Object.entries(headers)) {
					headerLines.push(`${name}: ${value}`);
				}
				socket.write(`${headerLines.join("\r\n")}\r\n\r\n`);
				socket.on("data", (chunk: Buffer) => {
					if (this.socket !== socket) return;
					this.buffer = Buffer.concat([this.buffer, chunk]);
					this.processBuffer(resolve, reject);
				});
				socket.on("error", reject);
				socket.on("close", () => {
					if (this.socket !== socket) return;
					this.handshakeDone = false;
					this.buffer = Buffer.alloc(0);
					this.closed = true;
					this.closeHandler?.();
				});
				socket.resume();
			}, reject);
		});
	}

	private buffer = Buffer.alloc(0);
	private handshakeDone = false;

	private processBuffer(resolve: () => void, reject: (error: Error) => void): void {
		if (!this.handshakeDone) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const header = this.buffer.subarray(0, headerEnd).toString("utf-8");
			if (!header.startsWith("HTTP/1.1 101")) {
				reject(new Error(`WebSocket handshake failed: ${header.split("\n")[0]}`));
				this.socket?.destroy();
				return;
			}
			this.buffer = this.buffer.subarray(headerEnd + 4);
			this.handshakeDone = true;
			resolve();
		}
		const state = { buffer: this.buffer };
		const { texts, binaries, pings, close } = readFrames(state, Buffer.alloc(0), false);
		this.buffer = state.buffer;
		for (const ping of pings) {
			this.socket?.write(encodeFrame(0xa, ping, true));
		}
		for (const text of texts) this.messageHandler?.(text);
		for (const binary of binaries) this.binaryHandler?.(binary);
		if (close) {
			this.closed = true;
			this.socket?.destroy();
			this.closeHandler?.();
		}
	}

	send(text: string): void {
		this.socket?.write(encodeFrame(0x1, Buffer.from(text, "utf-8"), true));
	}

	sendBinary(data: Uint8Array): void {
		this.socket?.write(encodeFrame(0x2, Buffer.from(data), true));
	}

	onMessage(handler: (text: string) => void): void {
		this.messageHandler = handler;
	}

	onBinary(handler: (data: Uint8Array) => void): void {
		this.binaryHandler = handler;
	}

	onClose(handler: () => void): void {
		this.closeHandler = handler;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.socket?.write(encodeFrame(0x8, Buffer.alloc(0), true));
		} catch {
			// ignore
		}
		this.socket?.destroy();
	}
}

// ---------------------------------------------------------------------------
// WebSocket server (RFC 6455 over node:http upgrade)
// ---------------------------------------------------------------------------

export class WsServerConnection {
	onMessage: ((text: string) => void) | undefined;
	onBinary: ((data: Uint8Array) => void) | undefined;
	onClose: (() => void) | undefined;
	private readonly decoder = { buffer: Buffer.alloc(0) };
	private readonly socket: Duplex;

	constructor(socket: Duplex) {
		this.socket = socket;

		socket.on("data", (chunk: Buffer) => {
			const { texts, binaries, pings, close } = readFrames(this.decoder, chunk, true);
			for (const ping of pings) {
				socket.write(encodeFrame(0xa, ping, false));
			}
			for (const text of texts) this.onMessage?.(text);
			for (const binary of binaries) this.onBinary?.(binary);
			if (close) {
				socket.end(encodeFrame(0x8, Buffer.alloc(0), false));
				this.onClose?.();
			}
		});
		socket.on("close", () => this.onClose?.());
		socket.on("error", () => this.onClose?.());
	}

	send(text: string): void {
		this.socket.write(encodeFrame(0x1, Buffer.from(text, "utf-8"), false));
	}

	close(): void {
		try {
			this.socket.end(encodeFrame(0x8, Buffer.alloc(0), false));
		} catch {
			// ignore
		}
		this.socket.destroy();
	}
}

/** Zero-dependency WebSocket server: HTTP upgrade -> RFC 6455 frames. */
export class WebSocketServer {
	private server: Server | undefined;
	private readonly connections = new Set<WsServerConnection>();
	onConnection: ((connection: WsServerConnection) => void) | undefined;
	onUpgrade: ((request: IncomingMessage) => boolean) | undefined;

	async listen(port: number, host = "127.0.0.1", tlsOptions?: ChannelTlsOptions): Promise<number> {
		const handler = (_req: IncomingMessage, res: ServerResponse): void => {
			res.writeHead(400);
			res.end("websocket only");
		};
		this.server = tlsOptions ? createHttpsServer(readTlsOptions(tlsOptions), handler) : createServer(handler);
		this.server.on("upgrade", (req, socket, head) => {
			if (this.onUpgrade && !this.onUpgrade(req)) {
				socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
			const key = req.headers["sec-websocket-key"];
			if (!key || req.headers.upgrade?.toLowerCase() !== "websocket") {
				socket.destroy();
				return;
			}
			socket.write(
				"HTTP/1.1 101 Switching Protocols\r\n" +
					"Upgrade: websocket\r\n" +
					"Connection: Upgrade\r\n" +
					`Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
			);
			if (head.length > 0) socket.unshift(head);
			const connection = new WsServerConnection(socket);
			this.connections.add(connection);
			connection.onClose = () => {
				this.connections.delete(connection);
			};
			this.onConnection?.(connection);
		});
		await new Promise<void>((resolve) => {
			this.server!.listen(port, host, resolve);
		});
		const address = this.server.address();
		return typeof address === "object" && address !== null ? address.port : port;
	}

	async close(): Promise<void> {
		for (const connection of this.connections) connection.close();
		this.connections.clear();
		await new Promise<void>((resolve) => {
			if (!this.server) return resolve();
			this.server.close(() => resolve());
			this.server = undefined;
		});
	}

	get connectionCount(): number {
		return this.connections.size;
	}
}
