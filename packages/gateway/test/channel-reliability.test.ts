import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BaseChannel,
	ChannelAgentRuntime,
	ChannelContextScope,
	ChannelRegistry,
	createChannelSdk,
	FileAttachmentStore,
	FileChannelOffsetStore,
	FileChannelSessionStore,
	FileInboundDeadLetterStore,
	FileInboundDedupStore,
	FileInboundHandoffStore,
	FileOutboundOutbox,
	type InboundMessage,
	MessageBus,
	MessageBusClosedError,
	MessageBusConsumerAbortedError,
	MessageBusOverflowError,
	OutboundDispatcher,
	type OutboundMessage,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function inbound(messageId: string): InboundMessage {
	return {
		messageId,
		channel: "web",
		senderId: "user",
		chatId: "chat",
		content: messageId,
		timestamp: Date.now(),
		sessionKey: "web:chat",
	};
}

class FlakyChannel extends BaseChannel {
	readonly name = "flaky";
	readonly displayName = "Flaky";
	attempts = 0;

	async start(): Promise<void> {
		this.running = true;
	}

	async stop(): Promise<void> {
		this.running = false;
	}

	async send(_message: OutboundMessage): Promise<{ providerMessageId: string }> {
		this.attempts++;
		if (this.attempts < 3) throw new Error("temporary failure");
		return { providerMessageId: "provider-1" };
	}
}

class SwitchChannel extends BaseChannel {
	readonly name = "switch";
	readonly displayName = "Switch";
	starts = 0;
	stops = 0;
	private readonly failStart: boolean;

	constructor(bus: MessageBus, config: Record<string, unknown> = {}, failStart = false) {
		super(config, bus);
		this.failStart = failStart;
	}

	async start(): Promise<void> {
		this.starts++;
		if (this.failStart) throw new Error("replacement failed to start");
		this.running = true;
	}

	async stop(): Promise<void> {
		this.stops++;
		this.running = false;
	}

	async send(_message: OutboundMessage): Promise<void> {}
}

describe("channel reliability primitives", () => {
	it("suppresses duplicate inbound ids and enforces queue bounds", async () => {
		const bus = new MessageBus({ maxInbound: 1 });
		expect(bus.publishInbound(inbound("m1"))).toBe(true);
		expect(bus.publishInbound(inbound("m1"))).toBe(false);
		expect(() => bus.publishInbound(inbound("m2"))).toThrow(MessageBusOverflowError);
		expect(await bus.consumeInbound()).toMatchObject({ messageId: "m1" });

		const pending = bus.consumeInbound();
		bus.close();
		await expect(pending).rejects.toBeInstanceOf(MessageBusClosedError);
	});

	it("cancels an individual consumer without affecting the bus", async () => {
		const bus = new MessageBus();
		const controller = new AbortController();
		const pending = bus.consumeInbound(controller.signal);
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(MessageBusConsumerAbortedError);
		expect(bus.publishInbound(inbound("m1"))).toBe(true);
	});

	it("keeps inbound duplicate suppression across store instances", () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-state-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "dedup.json");
		const first = new FileInboundDedupStore(path);
		const firstBus = new MessageBus({ inboundDedupStore: first });
		expect(firstBus.publishInbound(inbound("persistent-1"))).toBe(true);

		const second = new FileInboundDedupStore(path);
		const secondBus = new MessageBus({ inboundDedupStore: second });
		expect(secondBus.publishInbound(inbound("persistent-1"))).toBe(false);
	});

	it("persists session metadata and turn admission", () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-session-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "sessions.json");
		const first = new FileChannelSessionStore(path);
		first.recordInbound(inbound("session-1"));
		expect(first.beginTurn("web:chat", "turn-1")).toBe(true);

		const second = new FileChannelSessionStore(path);
		expect(second.beginTurn("web:chat", "turn-2")).toBe(false);
		second.completeTurn("web:chat", "turn-1", "completed");
		expect(second.getSession("web:chat")).toMatchObject({
			lastInboundMessageId: "session-1",
			lastTurnStatus: "completed",
		});
	});

	it("merges file-backed session writes from separate store instances", () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-session-concurrent-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "sessions.json");
		const first = new FileChannelSessionStore(path);
		const second = new FileChannelSessionStore(path);
		first.recordInbound({ ...inbound("session-a"), chatId: "a", sessionKey: "web:a" });
		second.recordInbound({ ...inbound("session-b"), chatId: "b", sessionKey: "web:b" });
		const merged = new FileChannelSessionStore(path);
		expect(merged.getSession("web:a")?.lastInboundMessageId).toBe("session-a");
		expect(merged.getSession("web:b")?.lastInboundMessageId).toBe("session-b");
	});

	it("persists provider offsets across store instances", () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-offset-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "offsets.json");
		const first = new FileChannelOffsetStore(path);
		first.set("telegram", "updateId", "42");
		first.set("matrix", "since", "s-1");
		const second = new FileChannelOffsetStore(path);
		expect(second.get("telegram", "updateId")).toBe("42");
		expect(second.get("matrix", "since")).toBe("s-1");
	});

	it("recovers an interrupted durable outbound attempt", () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-outbox-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "outbox.json");
		const first = new FileOutboundOutbox(path);
		const message: OutboundMessage = { messageId: "durable-1", channel: "web", chatId: "chat", content: "hello" };
		expect(first.enqueue(message)).toBe(true);
		first.markAttempt("durable-1", 1);

		const second = new FileOutboundOutbox(path);
		expect(second.recoverPending()).toEqual([message]);
		const receipt = {
			messageId: "durable-1",
			channel: "web",
			chatId: "chat",
			status: "success" as const,
			attempts: 1,
			acceptedAt: Date.now(),
		};
		second.markDelivered(receipt);
		const third = new FileOutboundOutbox(path);
		expect(third.recoverPending()).toEqual([]);
		expect(third.get("durable-1")?.status).toBe("delivered");
	});

	it("exposes failed outbox records for manual retry", () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-outbox-retry-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "outbox.json");
		const store = new FileOutboundOutbox(path);
		const message: OutboundMessage = { messageId: "retry-1", channel: "web", chatId: "chat", content: "retry" };
		store.enqueue(message);
		store.markFailed({
			messageId: message.messageId!,
			channel: message.channel,
			chatId: message.chatId,
			status: "failed",
			attempts: 3,
			acceptedAt: Date.now(),
			detail: "temporary",
		});
		expect(store.list("failed")).toHaveLength(1);
		expect(store.retry("retry-1")).toEqual(message);
		expect(store.recoverPending()).toEqual([message]);
	});

	it("cleans terminal outbox records by retention age", () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-outbox-cleanup-"));
		temporaryDirectories.push(directory);
		const store = new FileOutboundOutbox(join(directory, "outbox.json"));
		const message: OutboundMessage = { messageId: "cleanup-1", channel: "web", chatId: "chat", content: "cleanup" };
		store.enqueue(message);
		store.markDelivered({
			messageId: message.messageId!,
			channel: message.channel,
			chatId: message.chatId,
			status: "success",
			attempts: 1,
			acceptedAt: Date.now(),
		});
		const updatedAt = store.get(message.messageId!)?.updatedAt ?? Date.now();
		expect(store.cleanup({ olderThanMs: 1, now: updatedAt + 2 })).toBe(1);
		expect(store.list()).toEqual([]);
	});

	it("persists inbound handoff until the draining application finishes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-inbound-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "inbound.json");
		const first = new FileInboundHandoffStore(path);
		const message = inbound("handoff-1");
		expect(first.accept(message)).toBe(true);
		expect(first.accept(message)).toBe(false);

		const bus = new MessageBus({ inboundHandoffStore: first });
		let release: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			bus.onInbound(
				async () => {
					resolve();
					await new Promise<void>((complete) => {
						release = complete;
					});
				},
				{ consume: true },
			);
		});
		// The message already exists in the durable store, so a fresh bus recovers it.
		bus.recoverInbound();
		await started;
		expect(new FileInboundHandoffStore(path).recoverPending()).toEqual([message]);
		release?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(new FileInboundHandoffStore(path).recoverPending()).toEqual([]);
	});

	it("retries failed inbound handlers and persists exhausted attempts in the DLQ", async () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-inbound-retry-"));
		temporaryDirectories.push(directory);
		const handoff = new FileInboundHandoffStore(join(directory, "inbound.json"));
		const deadLetters = new FileInboundDeadLetterStore(join(directory, "inbound-dlq.json"));
		const bus = new MessageBus({
			inboundHandoffStore: handoff,
			inboundDeadLetterStore: deadLetters,
			inboundRetry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
		});
		let attempts = 0;
		bus.onInbound(
			async () => {
				attempts++;
				throw new Error("agent unavailable");
			},
			{ consume: true },
		);
		const message = inbound("failed-inbound");
		bus.publishInbound(message);
		await vi.waitFor(() => expect(deadLetters.list()).toHaveLength(1), { timeout: 2000, interval: 10 });
		expect(attempts).toBe(2);
		expect(bus.snapshot()).toMatchObject({ inboundFailures: 2, inboundRetries: 1, inboundDeadLetters: 1 });
		expect(handoff.recoverPending()).toEqual([]);
		expect(bus.retryInbound(message)).toBe(true);
		expect(deadLetters.list()).toEqual([]);
		bus.close();
	});

	it("hot-swaps channels and restores the old channel on startup failure", async () => {
		const bus = new MessageBus();
		const registry = new ChannelRegistry();
		const oldChannel = new SwitchChannel(bus);
		registry.register(oldChannel);
		await registry.startAll({ channels: { web: { enabled: false } } }, bus);

		const replacement = new SwitchChannel(bus);
		await registry.replaceChannel("switch", replacement);
		expect(registry.get("switch")).toBe(replacement);
		expect(oldChannel.isRunning).toBe(false);
		expect(replacement.isRunning).toBe(true);

		const failing = new SwitchChannel(bus, {}, true);
		await expect(registry.replaceChannel("switch", failing)).rejects.toThrow("replacement failed to start");
		expect(registry.get("switch")).toBe(replacement);
		expect(replacement.isRunning).toBe(true);
		expect(failing.isRunning).toBe(false);
		await registry.stopAll();
	});

	it("keeps a ChannelSdk inbound message durable until its handler resolves", async () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-sdk-inbound-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "inbound.json");
		const sdk = createChannelSdk({
			config: { channels: { web: { enabled: true, allowFrom: ["*"] } }, web: { host: "127.0.0.1", port: 0 } },
			channels: ["web"],
			inboundHandoffStatePath: path,
		});
		let release: (() => void) | undefined;
		let startedResolve: (() => void) | undefined;
		let completedResolve: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve;
		});
		const completed = new Promise<void>((resolve) => {
			completedResolve = resolve;
		});
		sdk.onMessage(async () => {
			startedResolve?.();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			completedResolve?.();
		});
		try {
			await sdk.start();
			const port = sdk.status()[0]?.port;
			await fetch(`http://127.0.0.1:${port}/api/messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ senderId: "u", chatId: "c", content: "durable" }),
			});
			await started;
			expect(new FileInboundHandoffStore(path).recoverPending()).toHaveLength(1);
			release?.();
			await completed;
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(new FileInboundHandoffStore(path).recoverPending()).toEqual([]);
		} finally {
			await sdk.stop();
		}
	});

	it("writes attachments atomically and rejects unsafe references", () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-attachments-"));
		temporaryDirectories.push(directory);
		const store = new FileAttachmentStore(directory);
		const saved = store.save(Buffer.from("payload"), { filename: "../payload.txt", mimeType: "text/plain" });
		expect(saved.filename).toBe("payload.txt");
		expect(store.resolve(saved.id)).toBe(saved.path);
		expect(store.read(saved.id)?.toString()).toBe("payload");
		expect(store.resolve("../payload.txt")).toBeUndefined();
	});

	it("closes channel context cleanups in reverse order", async () => {
		const order: string[] = [];
		const context = new ChannelContextScope(new MessageBus());
		context.registerCleanup(() => {
			order.push("first");
		});
		context.registerCleanup(() => {
			order.push("second");
		});
		await context.close();
		expect(order).toEqual(["second", "first"]);
	});

	it("publishes a receipt after bounded outbound retry", async () => {
		const bus = new MessageBus();
		const channel = new FlakyChannel({}, bus);
		await channel.start();
		const dispatcher = new OutboundDispatcher(bus, { get: () => channel }, { baseDelayMs: 0, maxAttempts: 3 });
		const receiptPromise = new Promise<unknown>((resolve) => {
			bus.onDelivery(resolve);
		});
		dispatcher.start();
		bus.publishOutbound({ messageId: "out-1", channel: "flaky", chatId: "chat", content: "hello" });
		await expect(receiptPromise).resolves.toMatchObject({
			messageId: "out-1",
			status: "success",
			attempts: 3,
			providerMessageId: "provider-1",
		});
		dispatcher.stop();
		await channel.stop();
	});

	it("interrupts the active runtime turn through the Web channel", async () => {
		const sdk = createChannelSdk({
			config: { channels: { web: { enabled: true, allowFrom: ["*"] } }, web: { host: "127.0.0.1", port: 0 } },
			channels: ["web"],
		});
		let startedResolve: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve;
		});
		const runtime = new ChannelAgentRuntime({
			sdk,
			handleMessage: async (_message, signal) => {
				startedResolve?.();
				await new Promise<never>((_resolve, reject) => {
					const abort = (): void => reject(new Error("aborted"));
					if (signal?.aborted) abort();
					else signal?.addEventListener("abort", abort, { once: true });
				});
				return "unreachable";
			},
		});
		try {
			await runtime.start();
			const port = sdk.status()[0]?.port;
			expect(port).toBeTypeOf("number");
			await fetch(`http://127.0.0.1:${port}/api/messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ senderId: "user", chatId: "chat", content: "long" }),
			});
			await started;
			const response = await fetch(`http://127.0.0.1:${port}/api/stop`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId: "chat" }),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ ok: true, interrupted: true, status: "interrupted" });
		} finally {
			await runtime.stop();
		}
	});
});
