/**
 * EmailChannel — IMAP polling (inbound) + SMTP (outbound), zero-dependency.
 *
 * Polls the INBOX for unseen messages, normalizes them into InboundMessage
 * (chatId = sender email address, so every correspondent is one chat), and
 * replies via SMTP.
 *
 * The socket layer is injectable for tests: `connect()` must return a Duplex
 * speaking the IMAP/SMTP line protocol.
 */

import { randomUUID } from "node:crypto";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import type { MessageBus } from "../bus.ts";
import {
	type ChannelMediaCapabilities,
	type ResolvedOutboundMedia,
	resolveOutboundMedia,
	withMediaFailureNote,
} from "../media.ts";
import type { ChannelSendResult, OutboundMessage } from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";

export interface EmailConfig extends ChannelConfig {
	imapHost?: string;
	imapPort?: number;
	imapUser?: string;
	imapPassword?: string;
	imapTls?: boolean;
	smtpHost?: string;
	smtpPort?: number;
	smtpUser?: string;
	smtpPassword?: string;
	/** From header used on outbound replies. */
	from?: string;
	/** Poll interval in ms. Default 30000. */
	pollIntervalMs?: number;
	/** Maximum attachments per outbound email. Default 5. */
	maxAttachments?: number;
	/** Maximum attachment size in bytes. Default 10MiB. */
	maxAttachmentBytes?: number;
}

type SocketFactory = (options: { host: string; port: number; tls: boolean }) => Duplex;

/**
 * Minimal IMAP/SMTP line protocol client over a Duplex.
 * Supports line reads and exact-size literal reads (IMAP FETCH BODY[]).
 */
class LineProtocol {
	private buffer = Buffer.alloc(0);
	private pendingLines: string[] = [];
	private lineWaiters: Array<(line: string) => void> = [];
	private byteWaiters: Array<{ size: number; resolve: (data: Buffer) => void }> = [];
	/** Set when a literal header line ({N}) was dispatched; line parsing pauses until the literal is consumed. */
	private literalPending: number | null = null;

	private readonly socket: Duplex;
	private readonly tagPrefix: string;

	constructor(socket: Duplex, tagPrefix: string) {
		this.socket = socket;
		this.tagPrefix = tagPrefix;

		socket.on("data", (chunk: Buffer) => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			console.log("LP DATA:", JSON.stringify(chunk.toString("utf-8").slice(0, 60)));
			this.pump();
		});
	}

	private pump(): void {
		for (;;) {
			// Satisfy pending literal reads first (raw bytes, may contain \r\n).
			const byteWaiter = this.byteWaiters[0];
			if (byteWaiter) {
				if (this.buffer.length < byteWaiter.size) break;
				const data = this.buffer.subarray(0, byteWaiter.size);
				this.buffer = this.buffer.subarray(byteWaiter.size);
				this.byteWaiters.shift();
				this.literalPending = null;
				byteWaiter.resolve(Buffer.from(data));
				continue;
			}
			// A literal header line was dispatched; do not line-split its bytes.
			if (this.literalPending !== null) break;
			const idx = this.buffer.indexOf("\r\n");
			if (idx === -1) break;
			const line = this.buffer.subarray(0, idx).toString("utf-8");
			this.buffer = this.buffer.subarray(idx + 2);
			const waiter = this.lineWaiters.shift();
			if (waiter) {
				waiter(line);
			} else {
				this.pendingLines.push(line);
			}
			const literal = line.match(/\{(\d+)\}$/);
			if (literal) this.literalPending = Number(literal[1]);
		}
	}

	async readLine(predicate?: (line: string) => boolean): Promise<string> {
		for (;;) {
			const idx = this.pendingLines.findIndex((line) => !predicate || predicate(line));
			if (idx !== -1) return this.pendingLines.splice(idx, 1)[0]!;
			const line = await new Promise<string>((resolve) => this.lineWaiters.push(resolve));
			if (!predicate || predicate(line)) return line;
		}
	}

	async readBytes(size: number): Promise<Buffer> {
		if (this.buffer.length >= size) {
			const data = this.buffer.subarray(0, size);
			this.buffer = this.buffer.subarray(size);
			this.literalPending = null;
			this.pump(); // resume line parsing for the trailing part
			return Buffer.from(data);
		}
		return new Promise((resolve) => this.byteWaiters.push({ size, resolve }));
	}

	/** Read one response: a plain line, or a FETCH header line + literal + closing paren. */
	async nextResponse(): Promise<{ line: string; literal?: Buffer }> {
		const line = await this.readLine();
		const match = line.match(/\{(\d+)\}$/);
		if (!match) return { line };
		const literal = await this.readBytes(Number(match[1]));
		await this.readLine(); // trailing ")" line
		return { line, literal };
	}

	send(line: string): void {
		this.socket.write(`${line}\r\n`);
	}

	/** Write a raw multi-line payload (used for the SMTP DATA body). */
	sendRaw(data: string): void {
		this.socket.write(data);
	}

	/** Allocate the next tagged command id. */
	nextTag(): string {
		return `${this.tagPrefix}${++this.tagCounter}`;
	}

	/** Send a tagged IMAP command and wait for the tagged OK/NO/BAD response. */
	async command(command: string): Promise<string[]> {
		const tag = this.nextTag();
		const lines: string[] = [];
		this.send(`${tag} ${command}`);
		for (;;) {
			const { line } = await this.nextResponse();
			lines.push(line);
			if (line.startsWith(`${tag} `)) return lines;
		}
	}

	private tagCounter = 0;

	close(): void {
		this.socket.destroy();
	}
}

function decodeQuotedPrintable(text: string): string {
	return text
		.replace(/=\r?\n/g, "")
		.replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Crude HTML→text: drop tags, keep text, decode common entities, collapse blanks. */
function htmlToText(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?\s*>/gi, "\n")
		.replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function decodeHeaderValue(value: string): string {
	// Decode RFC 2047 encoded words: =?charset?B|Q?text?=
	return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, _charset: string, encoding: string, text: string) => {
		if (encoding.toLowerCase() === "b") return Buffer.from(text, "base64").toString("utf-8");
		return decodeQuotedPrintable(text);
	});
}

interface ParsedMessage {
	from: string;
	subject: string;
	messageId: string;
	body: string;
}

function parseMessage(raw: string): ParsedMessage {
	// Split headers / body at the first blank line.
	const headerEnd = raw.indexOf("\r\n\r\n");
	const headerText = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
	let body = headerEnd === -1 ? "" : raw.slice(headerEnd + 4);

	// MIME: prefer the first text/plain part (crude but sufficient for chat).
	const partMatch = body.match(/Content-Type:\s*text\/plain[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n/);
	if (partMatch) {
		body = body.slice((partMatch.index ?? 0) + partMatch[0].length);
		const nextBoundary = body.search(/\r\n--[^\r\n]+--/);
		if (nextBoundary !== -1) body = body.slice(0, nextBoundary);
	} else if (/Content-Type:\s*text\/html/i.test(body)) {
		// HTML-only mail: take the html part and strip tags.
		const htmlPart = body.match(
			/Content-Type:\s*text\/html[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n([\s\S]*?)(?=\r\n--[^\r\n]+--|\r\n$|$)/i,
		);
		if (htmlPart) body = htmlToText(htmlPart[1]!);
	}
	if (/^Content-Transfer-Encoding:\s*base64/im.test(raw)) {
		body = Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf-8");
	} else {
		body = decodeQuotedPrintable(body);
	}
	if (/<[a-zA-Z/!][^>]*>/.test(body)) body = htmlToText(body);

	const header = (name: string): string => {
		const lines = headerText.split("\r\n");
		const start = lines.findIndex((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`));
		if (start === -1) return "";
		let value = lines[start]!.slice(name.length + 1).trim();
		for (let i = start + 1; i < lines.length && /^[ \t]/.test(lines[i]!); i++) {
			value += ` ${lines[i]!.trim()}`;
		}
		return value;
	};

	return {
		from: decodeHeaderValue(header("From")),
		subject: decodeHeaderValue(header("Subject")),
		messageId: header("Message-ID") || header("Message-Id"),
		body: body.trim(),
	};
}

function extractAddress(from: string): string {
	const match = from.match(/<([^<>]+)>/);
	return (match ? match[1] : (from.trim().split(/\s+/).pop() ?? from)).trim();
}

export class EmailChannel extends BaseChannel {
	name = "email";
	displayName = "Email";

	private timer: NodeJS.Timeout | undefined;
	private readonly cfg: EmailConfig;
	private readonly socketFactory: SocketFactory;
	private readonly fetchFn: typeof fetch;

	constructor(
		config: ChannelConfig | undefined,
		bus: MessageBus,
		options: { socketFactory?: SocketFactory; fetchFn?: typeof fetch } = {},
	) {
		super(config, bus);
		this.cfg = (config ?? {}) as EmailConfig;
		this.fetchFn = options.fetchFn ?? fetch;
		this.socketFactory =
			options.socketFactory ??
			(({ host, port, tls }) => (tls ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port })));
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		void this.pollOnce();
		this.timer = setInterval(() => void this.pollOnce(), this.cfg.pollIntervalMs ?? 30_000);
		this.timer.unref?.();
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	override get mediaCapabilities(): ChannelMediaCapabilities {
		return {
			kinds: ["file", "image", "audio", "video"],
			urlDirect: false,
			maxBytes: this.cfg.maxAttachmentBytes ?? 10 * 1024 * 1024,
		};
	}

	async send(message: OutboundMessage): Promise<ChannelSendResult> {
		const to = message.chatId;
		if (!to || !to.includes("@")) return { status: "failed", detail: "no valid recipient address" };
		const maxAttachments = positiveInteger(this.cfg.maxAttachments, 5);
		const attachments: ResolvedOutboundMedia[] = [];
		const failedMedia: string[] = [];
		for (const item of this.collectOutboundMedia(message)) {
			if (attachments.length >= maxAttachments) {
				failedMedia.push(`${item.filename ?? item.source} - 附件数量超限`);
				continue;
			}
			try {
				attachments.push(
					await resolveOutboundMedia(item, {
						fetchFn: this.fetchFn,
						maxBytes: this.mediaCapabilities.maxBytes,
					}),
				);
			} catch (error) {
				this.channelContext.logger?.error(`[email] attachment failed source=${item.source}: ${formatError(error)}`);
				failedMedia.push(item.filename ?? item.source);
			}
		}
		const content = withMediaFailureNote(message.content, failedMedia);
		const from = this.cfg.from ?? this.cfg.smtpUser ?? "agent@gateway.local";
		const raw = buildMimeEmail(from, to, content, attachments);

		const socket = this.socketFactory({
			host: this.cfg.smtpHost ?? "",
			port: this.cfg.smtpPort ?? 465,
			tls: this.cfg.smtpPort !== undefined && this.cfg.smtpPort !== 25,
		});
		const proto = new LineProtocol(socket, "s");
		try {
			await proto.readLine(); // 220 greeting
			proto.send(`EHLO agent-gateway`);
			await proto.readLine((line) => line.startsWith("250"));
			if (this.cfg.smtpUser) {
				proto.send(`AUTH LOGIN`);
				await proto.readLine((line) => line.startsWith("334"));
				proto.send(Buffer.from(this.cfg.smtpUser, "utf-8").toString("base64"));
				await proto.readLine((line) => line.startsWith("334"));
				proto.send(Buffer.from(this.cfg.smtpPassword ?? "", "utf-8").toString("base64"));
				await proto.readLine((line) => line.startsWith("235"));
			}
			proto.send(`MAIL FROM:<${from}>`);
			await proto.readLine((line) => /^250|^2/.test(line));
			proto.send(`RCPT TO:<${to}>`);
			await proto.readLine((line) => /^250|^2/.test(line));
			proto.send("DATA");
			await proto.readLine((line) => line.startsWith("354"));
			proto.sendRaw(raw);
			proto.send(".");
			await proto.readLine((line) => /^250|^2/.test(line));
			proto.send("QUIT");
		} finally {
			proto.close();
		}
		return failedMedia.length > 0
			? { status: "partial", detail: `attachments failed: ${failedMedia.join(", ")}` }
			: { status: "success" };
	}

	// ------------------------------------------------------------------
	// Inbound: IMAP polling
	// ------------------------------------------------------------------

	private async pollOnce(): Promise<void> {
		if (!this.running) return;
		try {
			const messages = await this.fetchInbound();
			const processed = new Set<number>();
			let maxUid = 0;
			for (const { uid, raw } of messages) {
				if (processed.has(uid)) continue;
				processed.add(uid);
				maxUid = Math.max(maxUid, uid);
				const parsed = parseMessage(raw);
				const from = extractAddress(parsed.from);
				if (!from || !from.includes("@")) continue;
				await this.handleMessage({
					senderId: from,
					chatId: from,
					content: parsed.body || parsed.subject,
					metadata: { messageId: parsed.messageId, subject: parsed.subject },
				});
			}
			if (maxUid > 0) {
				this.channelContext.offsetStore?.set(this.name, "lastUid", String(maxUid));
			}
			// Marking \Seen is politeness for other clients, never a delivery
			// guarantee — run it best-effort and out of the critical path.
			for (const uid of processed) void this.markSeen(uid).catch(() => undefined);
		} catch {
			// Poll errors are non-fatal.
		}
	}

	/**
	 * Fetch new messages: once a UID watermark exists, everything above it is
	 * delivered exactly once (restart-safe, no reliance on \Seen); on the first
	 * run the whole unseen backlog is delivered instead.
	 */
	private async fetchInbound(): Promise<Array<{ uid: number; raw: string }>> {
		const proto = await this.imap();
		try {
			const login = await proto.command(`LOGIN ${this.cfg.imapUser ?? ""} ${this.cfg.imapPassword ?? ""}`);
			if (!login.some((line) => line.includes(" OK") || line.startsWith("OK"))) return [];
			await proto.command("SELECT INBOX");
			const saved = this.channelContext.offsetStore?.get(this.name, "lastUid");
			const watermark = saved === undefined ? undefined : Number(saved);
			const searchCommand =
				watermark !== undefined && Number.isSafeInteger(watermark) && watermark >= 0
					? `UID SEARCH UID ${watermark + 1}:*`
					: "UID SEARCH UNSEEN";
			const search = await proto.command(searchCommand);
			const ids = (search.find((line) => line.startsWith("* SEARCH")) ?? "")
				.replace("* SEARCH", "")
				.trim()
				.split(/\s+/)
				.filter(Boolean)
				.map(Number);
			if (ids.length === 0) return [];

			const tag = proto.nextTag();
			const results: Array<{ uid: number; raw: string }> = [];
			proto.send(`${tag} UID FETCH ${ids.join(",")} (UID BODY.PEEK[])`);
			for (;;) {
				const { line, literal } = await proto.nextResponse();
				if (line.startsWith(`${tag} `)) break;
				const idMatch = line.match(/^\* \d+ FETCH \(UID (\d+)/);
				if (idMatch && literal) {
					results.push({ uid: Number(idMatch[1]), raw: literal.toString("utf-8") });
				}
			}
			return results;
		} finally {
			proto.close();
		}
	}

	private async markSeen(uid: number): Promise<void> {
		const proto = await this.imap();
		try {
			await proto.command(`LOGIN ${this.cfg.imapUser ?? ""} ${this.cfg.imapPassword ?? ""}`);
			await proto.command(`UID STORE ${uid} +FLAGS (\\Seen)`);
		} finally {
			proto.close();
		}
	}

	private async imap(): Promise<LineProtocol> {
		const socket = this.socketFactory({
			host: this.cfg.imapHost ?? "",
			port: this.cfg.imapPort ?? 993,
			tls: this.cfg.imapTls ?? true,
		});
		const proto = new LineProtocol(socket, "i");
		await proto.readLine(); // greeting
		return proto;
	}
}

/**
 * Build a MIME email: plain-text body plus optional base64 attachments.
 * Line-start dots are stuffed per RFC 5321 so the message never looks like
 * the SMTP DATA terminator.
 */
function buildMimeEmail(
	from: string,
	to: string,
	content: string,
	attachments: readonly ResolvedOutboundMedia[],
): string {
	if (attachments.length === 0) {
		const plain = [
			`From: ${from}`,
			`To: ${to}`,
			"Subject: pi reply",
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"",
			content,
		].join("\r\n");
		return `${dotStuff(plain)}\r\n`;
	}
	const boundary = `cogito-${randomUUID()}`;
	const lines: string[] = [
		`From: ${from}`,
		`To: ${to}`,
		"Subject: pi reply",
		"MIME-Version: 1.0",
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
		"",
		`--${boundary}`,
		"Content-Type: text/plain; charset=utf-8",
		"",
		content,
	];
	for (const attachment of attachments) {
		const filename = safeHeaderValue(attachment.filename);
		lines.push(
			`--${boundary}`,
			`Content-Type: ${attachment.mimeType}; name="${filename}"`,
			"Content-Transfer-Encoding: base64",
			`Content-Disposition: attachment; filename="${filename}"`,
			"",
		);
		const encoded = attachment.data.toString("base64");
		for (let offset = 0; offset < encoded.length; offset += 76) {
			lines.push(encoded.slice(offset, offset + 76));
		}
	}
	lines.push(`--${boundary}--`);
	return `${dotStuff(lines.join("\r\n"))}\r\n`;
}

/** RFC 5321 dot-stuffing: escape a leading dot on every line. */
function dotStuff(text: string): string {
	return text.replace(/(^|\r\n)\./g, "$1..");
}

/** Keep header values on one line and free of quotes. */
function safeHeaderValue(value: string): string {
	return value.replace(/[\r\n"]/g, "").trim() || "attachment";
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}
