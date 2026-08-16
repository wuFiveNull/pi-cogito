/**
 * ConsoleChannel — terminal interaction channel.
 *
 * Reads lines from an input stream (default stdin) and prints replies to an
 * output stream (default stdout). Ideal for local demos and testing.
 */

import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { MessageBus } from "../bus.ts";
import type { OutboundMessage } from "../types.ts";
import { BaseChannel, type ChannelConfig } from "./base.ts";

export class ConsoleChannel extends BaseChannel {
	name = "console";
	displayName = "Console";

	private readline: Interface | undefined;
	private readonly input: Readable;
	private readonly output: Writable;

	constructor(
		config: ChannelConfig | undefined,
		bus: MessageBus,
		options: { input?: Readable; output?: Writable; prompt?: string } = {},
	) {
		super(config, bus);
		this.input = options.input ?? process.stdin;
		this.output = options.output ?? process.stdout;
		this.prompt = options.prompt ?? "you> ";
	}

	private readonly prompt: string;

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.readline = createInterface({ input: this.input, output: this.output });
		this.readline.setPrompt(this.prompt);
		this.readline.on("line", (line) => {
			const text = line.trim();
			if (!text) return;
			void this.handleMessage({
				senderId: "console-user",
				chatId: "console",
				content: text,
			});
		});
		this.readline.prompt();
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		this.readline?.close();
		this.readline = undefined;
	}

	async send(message: OutboundMessage): Promise<void> {
		this.output.write(`bot> ${message.content}\n`);
	}
}
