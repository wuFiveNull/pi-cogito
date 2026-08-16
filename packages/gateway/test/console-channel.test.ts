import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent } from "../src/agent.ts";
import { MessageBus } from "../src/bus.ts";
import { ConsoleChannel } from "../src/channels/console.ts";
import { OutboundDispatcher } from "../src/channels/dispatcher.ts";

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of running.splice(0)) await cleanup();
});

async function startConsole(): Promise<{
	bus: MessageBus;
	input: PassThrough;
	output: PassThrough;
}> {
	const bus = new MessageBus();
	const input = new PassThrough();
	const output = new PassThrough();
	const channel = new ConsoleChannel({ allowFrom: ["*"] }, bus, { input, output });
	await channel.start();
	const dispatcher = new OutboundDispatcher(bus, {
		get: (name: string) => (name === "console" ? channel : undefined),
	});
	dispatcher.start();
	running.push(async () => {
		dispatcher.stop();
		await channel.stop();
	});
	return { bus, input, output };
}

function readUntil(stream: PassThrough, marker: string, timeoutMs = 3000): Promise<string> {
	return new Promise((resolve, reject) => {
		let text = "";
		const timer = setTimeout(() => reject(new Error(`timeout waiting for ${marker}`)), timeoutMs);
		stream.on("data", (chunk: Buffer) => {
			text += chunk.toString();
			if (text.includes(marker)) {
				clearTimeout(timer);
				resolve(text);
			}
		});
	});
}

describe("ConsoleChannel", () => {
	it("reads a line, delivers it to the agent and prints the reply", async () => {
		const { bus, input, output } = await startConsole();
		const agent = new FakeAgent(bus);
		agent.start();

		const replyPromise = readUntil(output, "bot> ");
		input.write("你好 console\n");

		const text = await replyPromise;
		expect(text).toContain("收到");
		expect(text).toContain("你好 console");
		agent.stop();
	});

	it("ignores blank lines (no reply is printed)", async () => {
		const { input, output } = await startConsole();
		let replySeen = false;
		output.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("bot> ")) replySeen = true;
		});
		input.write("   \n");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(replySeen).toBe(false);
	});
});
