import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";

function writeModelsJson(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-model-config-"));
	const path = join(dir, "models.json");
	writeFileSync(path, content, "utf-8");
	return path;
}

describe("ModelConfig embeddingModels", () => {
	it("accepts embeddingModels in provider config", async () => {
		const path = writeModelsJson(
			JSON.stringify({
				providers: {
					siliconflow: {
						embeddingModels: [
							{ id: "BAAI/bge-m3", dimensions: 1024, maxInputTokens: 8192 },
							{
								id: "custom-model",
								api: "custom-embeddings",
								baseUrl: "https://example.com/v1",
								dimensions: 768,
								cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				},
			}),
		);
		const config = await ModelConfig.load(path);
		expect(config.getError()).toBeUndefined();
		const models = config.getEmbeddingModels("siliconflow");
		expect(models?.length).toBe(2);
	});

	it("rejects embeddingModels without dimensions", async () => {
		const path = writeModelsJson(
			JSON.stringify({
				providers: {
					siliconflow: { embeddingModels: [{ id: "BAAI/bge-m3" }] },
				},
			}),
		);
		const config = await ModelConfig.load(path);
		expect(config.getError()).toContain("Invalid models.json schema");
		expect(config.getEmbeddingModels("siliconflow")).toBeUndefined();
	});

	it("maps definitions to EmbeddingModel with defaults", async () => {
		const path = writeModelsJson(
			JSON.stringify({
				providers: {
					siliconflow: {
						baseUrl: "https://api.siliconflow.cn/v1",
						embeddingModels: [{ id: "BAAI/bge-m3", dimensions: 1024 }],
					},
				},
			}),
		);
		const config = await ModelConfig.load(path);
		const model = config.toEmbeddingModel("siliconflow", config.getEmbeddingModels("siliconflow")![0]!);
		expect(model).toEqual({
			id: "BAAI/bge-m3",
			api: "siliconflow-embeddings",
			provider: "siliconflow",
			baseUrl: "https://api.siliconflow.cn/v1",
			dimensions: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	it("falls back to defaults.baseUrl when neither model nor provider set one", async () => {
		const path = writeModelsJson(
			JSON.stringify({
				providers: {
					siliconflow: { embeddingModels: [{ id: "BAAI/bge-m3", dimensions: 1024 }] },
				},
			}),
		);
		const config = await ModelConfig.load(path);
		const model = config.toEmbeddingModel("siliconflow", config.getEmbeddingModels("siliconflow")![0]!, {
			baseUrl: "https://default.example/v1",
		});
		expect(model.baseUrl).toBe("https://default.example/v1");
	});
});
