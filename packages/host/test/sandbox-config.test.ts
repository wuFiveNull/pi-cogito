import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, getConfigPaths, loadConfig, mergeConfigLayers } from "../src/core/sandbox/config.ts";

describe("sandbox config", () => {
	it("keeps the sandbox disabled by default with no approval settings", () => {
		const merged = mergeConfigLayers(DEFAULT_CONFIG, {}, {});

		expect(DEFAULT_CONFIG.enabled).toBe(false);
		expect(merged.approval).toBeUndefined();
	});

	it("mergeConfigLayers combines configured arrays and deduplicates entries", () => {
		const merged = mergeConfigLayers(
			DEFAULT_CONFIG,
			{
				network: {
					allowedDomains: ["global.example.com", "shared.example.com"],
					deniedDomains: ["blocked.example.com"],
					allowUnixSockets: ["/global.sock"],
				},
				filesystem: {
					allowRead: ["/global", "/shared"],
					denyWrite: ["global.key"],
				},
			},
			{
				network: {
					allowedDomains: ["project.example.com", "shared.example.com"],
					deniedDomains: ["project-blocked.example.com"],
					allowUnixSockets: ["/project.sock"],
				},
				filesystem: {
					allowRead: ["/project", "/shared"],
					denyWrite: ["project.key"],
				},
			},
		);

		expect(merged.network?.allowedDomains).toEqual([
			"global.example.com",
			"shared.example.com",
			"project.example.com",
		]);
		expect(merged.network?.deniedDomains).toEqual(["blocked.example.com", "project-blocked.example.com"]);
		expect(merged.network?.allowUnixSockets).toEqual(["/global.sock", "/project.sock"]);
		expect(merged.filesystem?.allowRead).toEqual(["/global", "/shared", "/project"]);
		expect(merged.filesystem?.denyWrite).toEqual(["global.key", "project.key"]);
	});

	it("mergeConfigLayers ignores malformed arrays and keeps defaults", () => {
		const merged = mergeConfigLayers(
			DEFAULT_CONFIG,
			{ filesystem: { denyWrite: "*.key" as unknown as string[] } },
			{ network: { allowedDomains: "not-an-array" as unknown as string[] } },
		);

		expect(merged.filesystem?.denyWrite).toEqual(DEFAULT_CONFIG.filesystem?.denyWrite);
		expect(merged.network?.allowedDomains).toEqual(DEFAULT_CONFIG.network?.allowedDomains);
	});

	it("an explicitly empty array disables its default", () => {
		const merged = mergeConfigLayers(DEFAULT_CONFIG, { filesystem: { allowRead: [] } }, {});

		expect(merged.filesystem?.allowRead).toEqual([]);
	});

	it("merges approval settings field-wise across layers", () => {
		const merged = mergeConfigLayers(
			DEFAULT_CONFIG,
			{ approval: { model: "anthropic/claude-haiku-4-5", timeoutSeconds: 10 } },
			{ approval: { maxPerSession: 5 } },
		);

		expect(merged.approval).toEqual({
			model: "anthropic/claude-haiku-4-5",
			timeoutSeconds: 10,
			maxPerSession: 5,
		});

		const overridden = mergeConfigLayers(
			DEFAULT_CONFIG,
			{ approval: { model: "anthropic/claude-haiku-4-5" } },
			{ approval: { model: "other/small-model" } },
		);
		expect(overridden.approval?.model).toBe("other/small-model");
	});

	it("scalar project settings override global settings", () => {
		const merged = mergeConfigLayers(DEFAULT_CONFIG, { enabled: false }, { enabled: true });

		expect(merged.enabled).toBe(true);
	});

	it("resolves config paths under the cogito config dir", () => {
		const paths = getConfigPaths("/project/dir");

		expect(paths.projectPath).toBe(join("/project/dir", ".cogito", "sandbox.json"));
		expect(paths.globalPath.endsWith(join("sandbox.json"))).toBe(true);
		expect(paths.globalPath.includes(".cogito")).toBe(true);
	});

	describe("with an isolated agent dir", () => {
		let workDir: string;
		let previousAgentDir: string | undefined;

		afterEach(() => {
			if (previousAgentDir === undefined) delete process.env.COGITO_CODING_AGENT_DIR;
			else process.env.COGITO_CODING_AGENT_DIR = previousAgentDir;
			rmSync(workDir, { recursive: true, force: true });
		});

		const setup = () => {
			workDir = mkdtempSync(join(tmpdir(), "cogito-sandbox-config-"));
			previousAgentDir = process.env.COGITO_CODING_AGENT_DIR;
			process.env.COGITO_CODING_AGENT_DIR = join(workDir, "agent");
			const cwd = join(workDir, "project");
			mkdirSync(join(cwd, ".cogito"), { recursive: true });
			return { cwd };
		};

		it("loads and merges global and project config files", () => {
			const { cwd } = setup();
			const { globalPath, projectPath } = getConfigPaths(cwd);

			mkdirSync(dirname(globalPath), { recursive: true });
			writeFileSync(
				globalPath,
				JSON.stringify({ enabled: true, network: { allowedDomains: ["global.example.com"] } }),
			);
			writeFileSync(
				projectPath,
				JSON.stringify({
					network: { allowedDomains: ["project.example.com"] },
					filesystem: { allowWrite: ["/tmp"] },
				}),
			);

			const config = loadConfig(cwd);
			expect(config.enabled).toBe(true);
			expect(config.network?.allowedDomains).toEqual(["global.example.com", "project.example.com"]);
			expect(config.filesystem?.allowWrite).toEqual(["/tmp"]);
		});

		it("tolerates missing and malformed files", () => {
			const { cwd } = setup();

			expect(loadConfig(cwd).enabled).toBe(false);

			const { projectPath } = getConfigPaths(cwd);
			writeFileSync(projectPath, "{ not json");
			const consoleError = console.error;
			console.error = () => undefined;
			try {
				expect(loadConfig(cwd).enabled).toBe(false);
			} finally {
				console.error = consoleError;
			}
		});
	});
});
