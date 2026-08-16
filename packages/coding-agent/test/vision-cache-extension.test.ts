import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionSqlite } from "../src/core/extensions/sqlite.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";

const testAgentDirs: string[] = [];
let agentDir = "";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const original = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...original,
		getAgentDir: () => agentDir,
	};
});

import visionCacheExtension from "../examples/extensions/vision-cache.ts";

function makeImage(text = "fake-image-bytes", mimeType = "image/png"): { data: string; mimeType: string } {
	return { data: Buffer.from(text).toString("base64"), mimeType };
}

function makeCtx(sqlite: ExtensionSqlite): ExtensionContext {
	return {
		ui: { notify: () => {} },
		mode: "print",
		hasUI: false,
		cwd: agentDir,
		sessionManager: {},
		modelRegistry: {
			getAll: () => [
				{
					id: "Qwen/Qwen3-VL-8B-Instruct",
					name: "Qwen3 VL 8B",
					api: "openai-completions",
					provider: "siliconflow",
					baseUrl: "https://api.siliconflow.cn/v1",
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32768,
					maxTokens: 8192,
				},
			],
		},
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => ({ tokens: 0, contextWindow: 100_000, percent: 0 }),
		compact: () => {},
		getSystemPrompt: () => "",
		sqlite: sqlite.db,
		indexDb: sqlite.indexDbView,
		searchSessions: async () => [],
	} as unknown as ExtensionContext;
}

describe("vision-cache extension", () => {
	let sqlite: ExtensionSqlite;
	let inputHandler: (event: any, ctx: ExtensionContext) => Promise<unknown>;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-vision-cache-"));
		testAgentDirs.push(agentDir);
		mkdirSync(join(agentDir, "sessions"), { recursive: true });
		sqlite = ExtensionSqlite.create(agentDir);

		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		inputHandler = undefined as unknown as (event: any, ctx: ExtensionContext) => Promise<unknown>;
		visionCacheExtension({
			on: (event: string, handler: (event: any, ctx: ExtensionContext) => Promise<unknown>) => {
				if (event === "input") inputHandler = handler;
			},
		} as never);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		sqlite.close();
		for (const dir of testAgentDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function stubVisionSuccess(description = "一张蓝色旗帜,中间有白色横条。") {
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ choices: [{ message: { content: description } }] }),
		});
	}

	function stubVisionFailure(status: number, retries = 0) {
		fetchMock.mockImplementation(async () => {
			if (fetchMock.mock.calls.length > retries + 1) {
				throw new Error("unexpected extra call");
			}
			return { ok: false, status, text: async () => "rate limited" };
		});
	}

	function writeAuth() {
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ siliconflow: { type: "api_key", key: "sk-test" } }),
			"utf-8",
		);
	}

	it("injects cached description and drops the image on a cache hit (no api call)", async () => {
		writeAuth();
		const image = makeImage("cache-hit-image");
		const ctx = makeCtx(sqlite);

		// First call: miss -> vision api -> cached.
		stubVisionSuccess();
		await inputHandler({ type: "input", text: "这是什么", images: [image], source: "interactive" }, ctx);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Second call: same image -> cache hit, no api call.
		await inputHandler({ type: "input", text: "这是什么", images: [image], source: "interactive" }, ctx);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Image file was saved to the vision cache dir.
		expect(existsSync(join(agentDir, "vision-cache"))).toBe(true);
	});

	it("persists a source-path image without copying it", async () => {
		writeAuth();
		const sourcePath = join(agentDir, "sessions", "photo.png");
		writeFileSync(sourcePath, "original-file-bytes", "utf-8");
		const image = makeImage("source-path-image");
		const ctx = makeCtx(sqlite);

		stubVisionSuccess();
		const result = await inputHandler(
			{ type: "input", text: `看图 <file name="${sourcePath}"></file>`, images: [image], source: "interactive" },
			ctx,
		);

		const transform = result as { action: string; text: string; images?: unknown[] };
		expect(transform.action).toBe("transform");
		expect(transform.text).toContain(sourcePath); // references the source path
		expect(transform.images).toEqual([]);
		// No copy was made into vision-cache (no hash-named file).
		const cacheDir = join(agentDir, "vision-cache");
		if (existsSync(cacheDir)) {
			expect(readFileSync(join(cacheDir, "*.png"), "utf-8")).toBeUndefined(); // dir should not exist
		}
	});

	it("retries up to 2 times on 429 then records a failed cache row", async () => {
		writeAuth();
		const image = makeImage("always-fails");
		const ctx = makeCtx(sqlite);

		stubVisionFailure(429, 2); // 3 attempts total (initial + 2 retries)
		const result = await inputHandler({ type: "input", text: "看图", images: [image], source: "interactive" }, ctx);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		const transform = result as { action: string; text: string };
		expect(transform.text).toContain("图片解析失败");
		expect(transform.text).toContain("内容不可见");

		const row = sqlite.db.get("SELECT status, retries FROM ext_vision_cache");
		expect(row).toEqual({ status: "failed", retries: 2 });

		// Every subsequent send retries the vision model from scratch (no rejection window).
		stubVisionSuccess();
		const retried = await inputHandler({ type: "input", text: "看图", images: [image], source: "interactive" }, ctx);
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect((retried as { text: string }).text).toContain("描述: 一张蓝色旗帜");
		expect(sqlite.db.get("SELECT status FROM ext_vision_cache")).toEqual({ status: "ok" });
	});

	it("does not retry 4xx errors but never rejects a later send", async () => {
		writeAuth();
		const image = makeImage("four-oh-four");
		const ctx = makeCtx(sqlite);

		stubVisionFailure(400, 0); // 400: single attempt only
		await inputHandler({ type: "input", text: "看图", images: [image], source: "interactive" }, ctx);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// A later send retries anyway (failed rows never reject new attempts).
		stubVisionSuccess();
		const result = await inputHandler({ type: "input", text: "看图", images: [image], source: "interactive" }, ctx);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect((result as { text: string }).text).toContain("描述: 一张蓝色旗帜");
	});

	it("processes multiple images concurrently", async () => {
		writeAuth();
		const ctx = makeCtx(sqlite);
		stubVisionSuccess();

		const images = [makeImage("multi-1"), makeImage("multi-2"), makeImage("multi-3")];
		await inputHandler({ type: "input", text: "看图", images, source: "interactive" }, ctx);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		const rows = sqlite.db.query("SELECT hash, status FROM ext_vision_cache ORDER BY hash");
		expect(rows.length).toBe(3);
		expect(rows.every((row) => row.status === "ok")).toBe(true);
	});

	it("leaves inputs without images untouched", async () => {
		const ctx = makeCtx(sqlite);
		const result = await inputHandler({ type: "input", text: "纯文本", source: "interactive" }, ctx);
		expect(result).toEqual({ action: "continue" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
