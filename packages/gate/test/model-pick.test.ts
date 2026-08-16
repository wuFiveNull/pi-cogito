import type { Model } from "@cogito/ai";
import { describe, expect, it } from "vitest";
import { pickDaemonModel } from "../src/model-pick.ts";

function fakeModel(provider: string, id: string): Model<any> {
	return { id, provider, api: "openai-completions", input: ["text"] } as Model<any>;
}

describe("pickDaemonModel(settings.json enabledModels 配置驱动)", () => {
	it("keeps the first available model when enabledModels is not configured", () => {
		const models = [fakeModel("opencode-go", "minimax-m3"), fakeModel("siliconflow", "Qwen/Qwen3-VL-8B-Instruct")];
		expect(pickDaemonModel(models)?.id).toBe("minimax-m3");
	});

	it("filters to an exact provider/model id", () => {
		const models = [
			fakeModel("opencode-go", "minimax-m3"),
			fakeModel("opencode-go", "deepseek-v4-flash"),
			fakeModel("siliconflow", "Qwen/Qwen3-VL-8B-Instruct"),
		];
		expect(pickDaemonModel(models, ["opencode-go/deepseek-v4-flash"])?.id).toBe("deepseek-v4-flash");
	});

	it("matches a bare model id without the provider prefix", () => {
		const models = [fakeModel("opencode-go", "minimax-m3"), fakeModel("opencode-go", "deepseek-v4-flash")];
		expect(pickDaemonModel(models, ["deepseek-v4-flash"])?.id).toBe("deepseek-v4-flash");
	});

	it("supports glob patterns (provider/*)", () => {
		const models = [
			fakeModel("opencode-go", "minimax-m3"),
			fakeModel("opencode-go", "deepseek-v4-flash"),
			fakeModel("siliconflow", "Qwen/Qwen3-VL-8B-Instruct"),
		];
		expect(pickDaemonModel(models, ["opencode-go/*"])?.provider).toBe("opencode-go");
	});

	it("returns undefined when no available model matches the configured list", () => {
		const models = [fakeModel("opencode-go", "minimax-m3")];
		expect(pickDaemonModel(models, ["opencode-go/deepseek-v4-flash"])).toBeUndefined();
	});

	it("returns undefined on an empty list", () => {
		expect(pickDaemonModel([])).toBeUndefined();
		expect(pickDaemonModel([], ["deepseek-v4-flash"])).toBeUndefined();
	});
});
