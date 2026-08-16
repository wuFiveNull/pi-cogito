import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type FeishuDeliveryConfig, FeishuDeliveryOutlet, parseFeishuDeliveryConfig } from "../src/feishu-delivery.ts";
import type { DeliveryInput } from "../src/store.ts";
import { ProactiveStore } from "../src/store.ts";

let tempDir = "";

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = "";
});

function makeDelivery(
	message: string,
	options: Pick<DeliveryInput, "media" | "attachments" | "target_channel" | "target_chat_id"> = {},
): DeliveryInput {
	return {
		session_key: "test",
		message,
		message_hash: `hash-${message}`,
		source_refs: "[]",
		evidence: "[]",
		action: "send",
		state_summary_tag: "test",
		delivered_at: Date.now(),
		...options,
	};
}

function makeConfig(): FeishuDeliveryConfig {
	return {
		appId: "cli_test",
		appSecret: "secret_test",
		domain: "https://open.feishu.test",
		targets: [{ chatId: "oc_test" }],
	};
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("Feishu delivery outlet", () => {
	it("replays persisted failed deliveries after an outlet restart", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "feishu-delivery-"));
		const fetchFn: typeof fetch = async (input) => {
			const url = String(input);
			if (url.includes("tenant_access_token")) {
				return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant_test", expire: 7200 }), {
					status: 200,
				});
			}
			return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
		};
		const store = new ProactiveStore(join(tempDir, "proactive.sqlite"));
		const deliveryId = store.insertDelivery(makeDelivery("replay me"), { notify: false });
		store.recordDeliveryFailure(deliveryId, "failed", "previous process stopped");

		const outlet = new FeishuDeliveryOutlet(store, makeConfig(), { fetchFn, replayPending: true });
		await outlet.start();
		await outlet.stop();

		expect(store.listPendingDeliveries()).toHaveLength(0);
		store.close();
	});

	it("sends a new delivery and acknowledges it after Feishu accepts it", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "feishu-delivery-"));
		const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchFn: typeof fetch = async (input, init) => {
			const url = String(input);
			requests.push({ url, init });
			if (url.includes("tenant_access_token")) {
				return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant_test", expire: 7200 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ code: 0, msg: "success", data: { message_id: "om_provider_test" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const store = new ProactiveStore(join(tempDir, "proactive.sqlite"));
		const outlet = new FeishuDeliveryOutlet(store, makeConfig(), { fetchFn });
		const acknowledged: Array<{ id: number; at: number }> = [];
		store.onDeliveryAcknowledged((record, at) => acknowledged.push({ id: record.id, at }));

		await outlet.start();
		store.insertDelivery(makeDelivery("hello Feishu"));
		await outlet.stop();

		expect(store.listPendingDeliveries()).toHaveLength(0);
		expect(acknowledged).toHaveLength(1);
		expect(acknowledged[0]?.at).toBeGreaterThan(0);
		const saved = store.listDeliveries(1)[0];
		expect(saved?.idempotency_key).toMatch(/^delivery:/);
		expect(saved?.target_receipts).toMatchObject([{ target: "oc_test", status: "success", attempts: 1 }]);
		expect(saved?.target_receipts[0]?.messageId).toMatch(/^proactive_/);
		expect(saved?.provider_message_id).toBe("om_provider_test");
		expect(requests).toHaveLength(2);
		expect(requests[0]?.url).toContain("tenant_access_token");
		expect(requests[1]?.url).toContain("receive_id_type=chat_id");
		expect(requests[1]?.init?.headers).toMatchObject({ Authorization: "Bearer tenant_test" });
		expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
			receive_id: "oc_test",
			msg_type: "text",
			content: JSON.stringify({ text: "hello Feishu" }),
		});
		expect(JSON.parse(String(requests[1]?.init?.body)).uuid).toBe(`${saved?.idempotency_key}:text`);
		store.close();
	});

	it("pauses and resumes the outbox without sending while quiesced", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "feishu-delivery-"));
		let sends = 0;
		const fetchFn: typeof fetch = async (input) => {
			const url = String(input);
			if (url.includes("tenant_access_token")) {
				return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant_test", expire: 7200 }), {
					status: 200,
				});
			}
			sends++;
			return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
		};
		const store = new ProactiveStore(join(tempDir, "proactive.sqlite"));
		const outlet = new FeishuDeliveryOutlet(store, makeConfig(), { fetchFn, replayPending: true });
		await outlet.start();
		await outlet.pause();
		store.insertDelivery(makeDelivery("queued while paused"));
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(sends).toBe(0);
		await outlet.resume();
		await waitFor(() => store.listPendingDeliveries().length === 0);
		expect(sends).toBe(1);
		await outlet.stop();
		store.close();
	});

	it("routes a media delivery to its explicit Feishu chat", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "feishu-delivery-"));
		const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchFn: typeof fetch = async (input, init) => {
			const url = String(input);
			requests.push({ url, init });
			if (url.includes("tenant_access_token")) {
				return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant_test", expire: 7200 }), {
					status: 200,
				});
			}
			if (url.includes("/im/v1/images")) {
				return new Response(JSON.stringify({ code: 0, data: { image_key: "img_test" } }), { status: 200 });
			}
			return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
		};
		const store = new ProactiveStore(join(tempDir, "proactive.sqlite"));
		const outlet = new FeishuDeliveryOutlet(store, makeConfig(), { fetchFn });

		await outlet.start();
		store.insertDelivery(
			makeDelivery("图片推送", {
				media: ["data:image/png;base64,iVBORw0KGgo="],
				target_channel: "feishu",
				target_chat_id: "oc_explicit",
			}),
		);
		await outlet.stop();

		expect(store.listPendingDeliveries()).toHaveLength(0);
		expect(requests).toHaveLength(4);
		expect(requests[2]?.url).toContain("/im/v1/images");
		expect(requests[3]?.url).toContain("receive_id_type=chat_id");
		expect(JSON.parse(String(requests[3]?.init?.body))).toMatchObject({
			receive_id: "oc_explicit",
			msg_type: "image",
			content: JSON.stringify({ image_key: "img_test" }),
		});
		const mediaUuidInput = `${store.listDeliveries(1)[0]?.idempotency_key}:media-0`;
		const expectedMediaUuid =
			mediaUuidInput.length <= 50
				? mediaUuidInput
				: createHash("sha256").update(mediaUuidInput).digest("hex").slice(0, 50);
		expect(JSON.parse(String(requests[3]?.init?.body)).uuid).toBe(expectedMediaUuid);
		store.close();
	});

	it("passes typed file attachments through to Feishu", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "feishu-delivery-"));
		const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchFn: typeof fetch = async (input, init) => {
			const url = String(input);
			requests.push({ url, init });
			if (url.includes("tenant_access_token")) {
				return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant_test", expire: 7200 }), {
					status: 200,
				});
			}
			if (url.includes("/im/v1/files")) {
				return new Response(JSON.stringify({ code: 0, data: { file_key: "file_test" } }), { status: 200 });
			}
			return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
		};
		const store = new ProactiveStore(join(tempDir, "proactive.sqlite"));
		const outlet = new FeishuDeliveryOutlet(store, makeConfig(), { fetchFn });

		await outlet.start();
		store.insertDelivery(
			makeDelivery("文件推送", {
				attachments: [
					{
						kind: "file",
						source: "data:application/pdf;base64,JVBERi0xLjQ=",
						filename: "report.pdf",
						mimeType: "application/pdf",
					},
				],
			}),
		);
		await outlet.stop();

		expect(store.listPendingDeliveries()).toHaveLength(0);
		expect(requests).toHaveLength(4);
		expect(requests[2]?.url).toContain("/im/v1/files");
		expect((requests[2]?.init?.body as FormData).get("file_name")).toBe("report.pdf");
		expect(JSON.parse(String(requests[3]?.init?.body))).toMatchObject({
			receive_id: "oc_test",
			msg_type: "file",
			content: JSON.stringify({ file_key: "file_test" }),
		});
		store.close();
	});

	it("keeps a delivery pending when all attempts fail", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "feishu-delivery-"));
		const fetchFn: typeof fetch = async (input) => {
			const url = String(input);
			if (url.includes("tenant_access_token")) {
				return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant_test", expire: 7200 }), {
					status: 200,
				});
			}
			return new Response(JSON.stringify({ code: 999, msg: "rejected" }), { status: 200 });
		};
		const store = new ProactiveStore(join(tempDir, "proactive.sqlite"));
		const outlet = new FeishuDeliveryOutlet(store, makeConfig(), {
			fetchFn,
			maxAttempts: 2,
			retryDelayMs: 0,
		});

		await outlet.start();
		store.insertDelivery(makeDelivery("will fail"));
		await outlet.stop();

		expect(store.listPendingDeliveries()).toHaveLength(1);
		store.close();
	});

	it("retries a pending delivery after a transient failure", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "feishu-delivery-"));
		let sendAttempts = 0;
		const fetchFn: typeof fetch = async (input) => {
			const url = String(input);
			if (url.includes("tenant_access_token")) {
				return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant_test", expire: 7200 }), {
					status: 200,
				});
			}
			sendAttempts++;
			if (sendAttempts === 1) return new Response(JSON.stringify({ code: 999, msg: "temporary" }), { status: 200 });
			return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
		};
		const store = new ProactiveStore(join(tempDir, "proactive.sqlite"));
		const outlet = new FeishuDeliveryOutlet(store, makeConfig(), {
			fetchFn,
			maxAttempts: 1,
			retryDelayMs: 5,
		});

		await outlet.start();
		store.insertDelivery(makeDelivery("retry me"));
		await waitFor(() => store.listPendingDeliveries().length === 0);
		await outlet.stop();

		expect(sendAttempts).toBe(2);
		store.close();
	});
});

describe("parseFeishuDeliveryConfig", () => {
	it("selects Feishu targets from the shared gateway config", () => {
		const config = parseFeishuDeliveryConfig({
			channels: {
				feishu: { enabled: true, appId: "cli_test", appSecret: "secret_test" },
				web: { enabled: true },
			},
			proactive: {
				targets: [
					{ channel: "feishu", chatId: "oc_feishu" },
					{ channel: "web", chatId: "ignored" },
				],
			},
		});

		expect(config).toEqual({
			appId: "cli_test",
			appSecret: "secret_test",
			domain: "https://open.feishu.cn",
			targets: [{ chatId: "oc_feishu" }],
		});
	});
});
