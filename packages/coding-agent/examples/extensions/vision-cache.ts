/**
 * Vision attachment cache.
 *
 * Intercepts every input that carries images, computes a sha256 per image, and
 * looks it up in the shared extensions sqlite database:
 *
 * - cache hit  -> the stored description is injected as text, the image is
 *                 dropped from the request (no vision tokens spent).
 * - cache miss -> the image is sent to a vision model (default: SiliconFlow
 *                 Qwen/Qwen3-VL-8B-Instruct) which describes it; description
 *                 and image file are persisted for future hits.
 *
 * Failed descriptions are retried (up to 3 retries) and recorded as "failed"
 * for diagnostics; every subsequent send of the same image retries the vision
 * model from scratch (no rejection window). Images are always saved to
 * agentDir/vision-cache/<hash>.<ext> so they can be referenced later.
 *
 * Configuration (optional file agentDir/vision-cache.json):
 * {
 *   "visionProvider": "siliconflow",          // provider from auth.json + models.json
 *   "visionModel": "Qwen/Qwen3-VL-8B-Instruct", // falls back to the provider's first vision model
 *   "apiBaseUrl": "https://api.siliconflow.cn/v1",
 *   "describePrompt": "...",                  // prompt sent to the vision model
 *   "maxTokens": 1024,
 *   "maxRetries": 3,                          // retries after the initial attempt
 *   "concurrency": 4,
 *   "requestTimeoutMs": 60000
 * }
 *
 * Files:
 * - extension:      agentDir/extensions/vision-cache.ts
 * - image cache:    agentDir/vision-cache/
 * - metadata:       agentDir/extensions.sqlite (table ext_vision_cache)
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

const DEFAULT_CONFIG = {
	visionProvider: "siliconflow",
	visionModel: "Qwen/Qwen3-VL-8B-Instruct",
	apiBaseUrl: "https://api.siliconflow.cn/v1",
	describePrompt:
		"请详细描述这张图片的内容:主体、布局、颜色、文字内容(如有)、可读到的数据或数字。用中文回答,不超过200字。",
	maxTokens: 1024,
	maxRetries: 2, // retries after the initial attempt (3 requests total)
	concurrency: 4,
	requestTimeoutMs: 30_000,
} satisfies ExtensionConfig;

const MIME_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
};

interface ExtensionConfig {
	/** Provider whose configured vision model is used (from models.json via ctx.modelRegistry). */
	visionProvider: string;
	/** Vision model id. Falls back to the first image-capable model of visionProvider. */
	visionModel: string;
	/** OpenAI-compatible base URL of the vision provider. */
	apiBaseUrl: string;
	/** Prompt sent to the vision model to describe an image. */
	describePrompt: string;
	maxTokens: number;
	/** Retries after the initial attempt (total attempts = maxRetries + 1). */
	maxRetries: number;
	concurrency: number;
	requestTimeoutMs: number;
}

interface ResolvedVisionModel {
	modelId: string;
	baseUrl: string;
}

interface CacheRow {
	hash: string;
	cached_path: string;
	description: string | null;
	status: string;
	updated_at: number;
}

interface ProcessedImage {
	kind: "ok" | "failed";
	path: string;
	description?: string;
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const visionCacheDir = join(agentDir, "vision-cache");
	const config = loadConfig(agentDir);
	let tableEnsured = false;

	pi.on("input", async (event, ctx) => {
		if (!event.images || event.images.length === 0) {
			return { action: "continue" as const };
		}

		if (ctx.hasUI) {
			ctx.ui.notify(`正在识别 ${event.images.length} 张图片…`, "info");
		}

		const sourcePaths = extractSourcePaths(event.text);
		const vision = resolveVisionModel(ctx, config);
		const results = await mapWithConcurrency(event.images, config.concurrency, (image, index) =>
			processImage(image, sourcePaths[index], ctx, vision),
		);

		const blocks: string[] = [];
		for (const result of results) {
			if (result.kind === "ok") {
				blocks.push(
					`[图片附件: ${result.path}]\n描述: ${result.description}\n注: 当前模型无法直接查看图片,如需图中细节请告知用户。`,
				);
			} else {
				blocks.push(`[图片附件: ${result.path}]\n描述: 图片解析失败,内容不可见。`);
			}
		}

		const newText = `${event.text}\n\n${blocks.join("\n\n")}`;
		return { action: "transform" as const, text: newText, images: [] };
	});

	async function processImage(
		image: ImageContent,
		sourcePath: string | undefined,
		ctx: Context,
		vision: ResolvedVisionModel,
	): Promise<ProcessedImage> {
		const hash = sha256Hex(image.data);
		const ext = MIME_EXTENSIONS[image.mimeType] ?? "png";
		const cachedPath = sourcePath ?? join(visionCacheDir, `${hash}.${ext}`);

		const row = await getCache(ctx, hash);
		if (row?.status === "ok" && row.description) {
			return { kind: "ok", path: row.cached_path, description: row.description };
		}

		// Persist the image bytes before describing (paste images live in tmp).
		if (!sourcePath) {
			mkdirSync(visionCacheDir, { recursive: true });
			writeFileSync(cachedPath, Buffer.from(image.data, "base64"));
		}

		const description = await describeWithRetry(image, vision);
		if (description) {
			upsertCache(ctx, hash, cachedPath, description, "ok", 0);
			return { kind: "ok", path: cachedPath, description };
		}
		upsertCache(ctx, hash, cachedPath, null, "failed", config.maxRetries);
		return { kind: "failed", path: cachedPath };
	}

	async function describeWithRetry(image: ImageContent, vision: ResolvedVisionModel): Promise<string | undefined> {
		let delayMs = 500;
		for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
			try {
				return await describeImage(image, vision);
			} catch (error) {
				if (attempt === config.maxRetries || !isRetryable(error)) {
					return undefined;
				}
				await sleep(delayMs);
				delayMs *= 2;
			}
		}
		return undefined;
	}

	async function describeImage(image: ImageContent, vision: ResolvedVisionModel): Promise<string> {
		const apiKey = readProviderKey();
		if (!apiKey) {
			throw new Error(`${config.visionProvider} api key not found in auth.json`);
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
		try {
			const response = await fetch(`${vision.baseUrl}/chat/completions`, {
				method: "POST",
				signal: controller.signal,
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: vision.modelId,
					messages: [
						{
							role: "user",
							content: [
								{
									type: "image_url",
									image_url: { url: `data:${image.mimeType};base64,${image.data}` },
								},
								{ type: "text", text: config.describePrompt },
							],
						},
					],
					max_tokens: config.maxTokens,
				}),
			});

			if (!response.ok) {
				throw new VisionApiError(
					response.status,
					`vision api ${response.status}: ${await response.text().catch(() => "")}`,
				);
			}

			const data = (await response.json()) as {
				choices?: Array<{ message?: { content?: string | null } }>;
			};
			const content = data.choices?.[0]?.message?.content?.trim();
			if (!content) {
				throw new VisionApiError(200, "vision api returned empty content");
			}
			return content;
		} finally {
			clearTimeout(timeout);
		}
	}

	function readProviderKey(): string | undefined {
		try {
			const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8")) as Record<
				string,
				{ type?: string; key?: string }
			>;
			return auth[config.visionProvider]?.key;
		} catch {
			return undefined;
		}
	}

	function ensureTable(ctx: Context): void {
		if (tableEnsured) return;
		ctx.sqlite.run(
			"CREATE TABLE IF NOT EXISTS ext_vision_cache (hash TEXT PRIMARY KEY, cached_path TEXT, description TEXT, status TEXT, retries INTEGER, created_at INTEGER, updated_at INTEGER)",
		);
		tableEnsured = true;
	}

	async function getCache(ctx: Context, hash: string): Promise<CacheRow | undefined> {
		ensureTable(ctx);
		const row = ctx.sqlite.get(
			"SELECT hash, cached_path, description, status, updated_at FROM ext_vision_cache WHERE hash = ?",
			hash,
		);
		return row ? (row as unknown as CacheRow) : undefined;
	}

	function upsertCache(
		ctx: Context,
		hash: string,
		path: string,
		description: string | null,
		status: string,
		retries: number,
	): void {
		ensureTable(ctx);
		ctx.sqlite.run(
			"INSERT INTO ext_vision_cache (hash, cached_path, description, status, retries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET cached_path = excluded.cached_path, description = excluded.description, status = excluded.status, retries = excluded.retries, updated_at = excluded.updated_at",
			hash,
			path,
			description,
			status,
			retries,
			Date.now(),
			Date.now(),
		);
	}
}

/** Minimal context surface the extension needs (a subset of ExtensionContext). */
type Context = {
	sqlite: {
		get(sql: string, ...params: unknown[]): Record<string, unknown> | undefined;
		run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid?: number };
	};
};

class VisionApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** Load agentDir/vision-cache.json over the built-in defaults (partial merge). */
function loadConfig(agentDir: string): ExtensionConfig {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "vision-cache.json"), "utf-8")) as Partial<ExtensionConfig>;
		return { ...DEFAULT_CONFIG, ...raw };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/**
 * Resolve the vision model from .cogito settings via ctx.modelRegistry:
 * configured visionModel of visionProvider first, then the provider's first
 * image-capable model, then the built-in defaults.
 */
function resolveVisionModel(ctx: ExtensionContext, config: ExtensionConfig): ResolvedVisionModel {
	const models = ctx.modelRegistry.getAll() as Model<"openai-completions">[];
	const providerModels = models.filter((model) => model.provider === config.visionProvider);
	const exact = providerModels.find((model) => model.id === config.visionModel);
	const chosen =
		exact ??
		providerModels.find((model) => model.input.includes("image")) ??
		providerModels[0] ??
		({ id: config.visionModel, baseUrl: config.apiBaseUrl } as Model<"openai-completions">);
	return { modelId: chosen.id, baseUrl: chosen.baseUrl.replace(/\/$/, "") };
}

/** Extract `<file name="...">` source paths from input text, in order. */
function extractSourcePaths(text: string): (string | undefined)[] {
	const paths: (string | undefined)[] = [];
	const pattern = /<file name="([^"]+)">/g;
	for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
		paths.push(match[1]);
	}
	return paths;
}

function sha256Hex(data: string): string {
	return createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
}

function isRetryable(error: unknown): boolean {
	if (error instanceof VisionApiError) {
		return error.status === 429 || error.status >= 500;
	}
	// Network-level failures (fetch failed, timeout abort) are transient.
	return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			try {
				results[index] = await fn(items[index]!, index);
			} catch {
				// The per-item fn handles its own failures; anything escaping here
				// is unexpected and must not stall the batch.
				results[index] = { kind: "failed", path: "unknown" } as R;
			}
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
