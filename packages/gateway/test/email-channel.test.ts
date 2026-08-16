import { tmpdir } from "node:os";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAgent } from "../src/agent.ts";
import { MessageBus } from "../src/bus.ts";
import { ChannelContextScope } from "../src/channels/context.ts";
import { OutboundDispatcher } from "../src/channels/dispatcher.ts";
import { EmailChannel, type EmailConfig } from "../src/channels/email.ts";
import { FileChannelOffsetStore } from "../src/state.ts";

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of running.splice(0)) await cleanup();
});

/** Duplex that pushes a script of response chunks and records written lines. */
class FakeSocket extends Duplex {
	written: string[] = [];

	constructor(script: string[]) {
		super();
		for (const chunk of script) {
			setImmediate(() => {
				if (!this.destroyed) this.push(chunk);
			});
		}
	}

	_write(chunk: Buffer, _enc: BufferEncoding, callback: () => void): void {
		this.written.push(chunk.toString("utf-8").trim());
		callback();
	}

	_read(): void {}
}

const MARK_SEEN_SCRIPT = [
	"* OK IMAP ready\r\n",
	"i1 OK LOGIN completed\r\n",
	"* 1 FETCH (FLAGS (\\Seen))\r\ni2 OK STORE done\r\n",
];

function imapScript(body: string): string[] {
	const literal = `From: "Alice" <alice@example.com>\r\nTo: bot@example.com\r\nSubject: Hello\r\nMessage-ID: <msg-1@example.com>\r\n\r\n${body}`;
	return [
		"* OK IMAP ready\r\n",
		"* OK LOGIN succeeded\r\ni1 OK LOGIN completed\r\n",
		"* FLAGS (\\Seen \\Answered)\r\ni2 OK [READ-WRITE] SELECT done\r\n",
		"* SEARCH 1\r\ni3 OK SEARCH done\r\n",
		`* 1 FETCH (UID 1 BODY[] {${Buffer.byteLength(literal)}}\r\n${literal})\r\ni4 OK FETCH done\r\n`,
	];
}

const SMTP_SCRIPT = [
	"220 smtp.test ESMTP\r\n",
	"250-smtp.test\r\n250 AUTH LOGIN\r\n",
	"334 VXNlcm5hbWU6\r\n",
	"334 UGFzc3dvcmQ6\r\n",
	"235 2.7.0 Authentication successful\r\n",
	"250 2.1.0 ok\r\n",
	"250 2.1.5 ok\r\n",
	"354 End data with <CR><LF>.<CR><LF>\r\n",
	"250 2.0.0 ok\r\n",
	"221 2.0.0 bye\r\n",
];

async function startEmail(
	config: Partial<EmailConfig>,
	socketFactory: (opts: { host: string; port: number; tls: boolean }) => Duplex,
) {
	const bus = new MessageBus();
	const channel = new EmailChannel(
		{
			imapHost: "imap.test",
			imapUser: "bot@example.com",
			imapPassword: "secret",
			smtpHost: "smtp.test",
			smtpUser: "bot@example.com",
			smtpPassword: "secret",
			allowFrom: ["*"],
			pollIntervalMs: 60000,
			...config,
		},
		bus,
		{ socketFactory },
	);
	await channel.start();
	const dispatcher = new OutboundDispatcher(bus, {
		get: (name: string) => (name === "email" ? channel : undefined),
	});
	dispatcher.start();
	running.push(async () => {
		dispatcher.stop();
		await channel.stop();
	});
	return { bus, channel };
}

describe("EmailChannel", () => {
	it("polls IMAP for unseen messages and normalizes them", async () => {
		const scripts = [imapScript("你好,这是正文"), MARK_SEEN_SCRIPT];
		const sockets: FakeSocket[] = [];
		const { bus } = await startEmail({}, () => {
			const socket = new FakeSocket(scripts.shift() ?? []);
			sockets.push(socket);
			return socket;
		});

		const inbound = await bus.consumeInbound();
		expect(inbound).toMatchObject({
			channel: "email",
			senderId: "alice@example.com",
			chatId: "alice@example.com",
			content: "你好,这是正文",
		});
		expect(inbound.metadata).toMatchObject({ messageId: "<msg-1@example.com>", subject: "Hello" });
		// First run: unseen backlog, fetched by UID.
		const written = sockets[0]!.written.join("\n");
		expect(written).toContain("UID SEARCH UNSEEN");
		expect(written).toContain("UID FETCH 1 (UID BODY.PEEK[])");
		// \Seen marking runs best-effort on a second connection.
		await vi.waitFor(
			() => expect(sockets.some((socket) => socket.written.join("\n").includes("UID STORE 1"))).toBe(true),
			{ timeout: 2000 },
		);
	});

	it("uses the UID watermark after the first poll (restart-safe delivery)", async () => {
		const statePath = `${tmpdir()}/gateway-email-uid-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
		const store = new FileChannelOffsetStore(statePath);
		const scripts = [imapScript("first"), MARK_SEEN_SCRIPT];
		const sockets: FakeSocket[] = [];
		const bus = new MessageBus();
		const channel = new EmailChannel(
			{
				imapHost: "imap.test",
				imapUser: "bot@example.com",
				imapPassword: "secret",
				allowFrom: ["*"],
				pollIntervalMs: 60000,
			},
			bus,
			{
				socketFactory: () => {
					const socket = new FakeSocket(scripts.shift() ?? []);
					sockets.push(socket);
					return socket;
				},
			},
		);
		await channel.bindContext(new ChannelContextScope(bus, { offsetStore: store }));
		await channel.start();
		running.push(async () => void channel.stop());
		await bus.consumeInbound();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(sockets[0]!.written.join("\n")).toContain("UID SEARCH UNSEEN");

		// Fresh channel over the same offset store: the watermark scopes the fetch.
		const literal2 = `From: "Bob" <bob@example.com>\r\nTo: bot@example.com\r\nSubject: Second\r\nMessage-ID: <msg-2@example.com>\r\n\r\nsecond body`;
		const watermarkScripts = [
			[
				"* OK IMAP ready\r\n",
				"* OK LOGIN succeeded\r\ni1 OK LOGIN completed\r\n",
				"* FLAGS (\\Seen)\r\ni2 OK [READ-WRITE] SELECT done\r\n",
				"* SEARCH 2\r\ni3 OK SEARCH done\r\n",
				`* 2 FETCH (UID 2 BODY[] {${Buffer.byteLength(literal2)}}\r\n${literal2})\r\ni4 OK FETCH done\r\n`,
			],
			MARK_SEEN_SCRIPT,
		];
		const written2Sockets: FakeSocket[] = [];
		const bus2 = new MessageBus();
		const channel2 = new EmailChannel(
			{
				imapHost: "imap.test",
				imapUser: "bot@example.com",
				imapPassword: "secret",
				allowFrom: ["*"],
				pollIntervalMs: 60000,
			},
			bus2,
			{
				socketFactory: () => {
					const socket = new FakeSocket(watermarkScripts.shift() ?? []);
					written2Sockets.push(socket);
					return socket;
				},
			},
		);
		await channel2.bindContext(new ChannelContextScope(bus2, { offsetStore: store }));
		await channel2.start();
		running.push(async () => void channel2.stop());
		const inbound2 = await bus2.consumeInbound();
		expect(inbound2.content).toBe("second body");
		expect(inbound2.senderId).toBe("bob@example.com");
		const secondSocket = written2Sockets[0]!;
		expect(secondSocket.written.join("\n")).toContain("UID SEARCH UID 2:*");
	});

	it("extracts plain text from HTML bodies as a fallback", async () => {
		const html = "<html><body><div>hello <b>bold</b> &amp; world</div></body></html>";
		const scripts = [imapScript(html), MARK_SEEN_SCRIPT];
		const { bus } = await startEmail({}, () => new FakeSocket(scripts.shift() ?? []));
		const inbound = await bus.consumeInbound();
		expect(inbound.content).toContain("hello bold & world");
	});

	it("replies via SMTP when the agent answers", async () => {
		const smtpSocket = new FakeSocket(SMTP_SCRIPT);
		const scripts = [imapScript("trigger"), MARK_SEEN_SCRIPT];
		const { bus } = await startEmail({}, () => {
			if (scripts.length > 0) return new FakeSocket(scripts.shift()!);
			return smtpSocket;
		});

		const agent = new FakeAgent(bus);
		agent.start();

		await vi.waitFor(() => expect(smtpSocket.written).toContain("MAIL FROM:<bot@example.com>"), {
			timeout: 3000,
		});
		expect(smtpSocket.written).toContain("RCPT TO:<alice@example.com>");
		expect(smtpSocket.written.some((line) => line.includes("Subject: pi reply"))).toBe(true);
		agent.stop();
	});
});
