/**
 * Sandbox extension configuration.
 *
 * Layering: built-in defaults <- global (<agentDir>/sandbox.json) <- project
 * (<cwd>/.cogito/sandbox.json). Scalar settings from the project win; array
 * settings from both files are combined and deduplicated. Configured arrays
 * replace the built-in defaults entirely (an explicit empty array disables a
 * default).
 *
 * Ported from pi-sandbox (https://github.com/carderne/pi-sandbox, MIT), with
 * project config paths moved from `.pi/` to the cogito config dir.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SandboxRuntimeConfig } from "@carderne/sandbox-runtime";

import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";

export type SandboxConfig = Omit<SandboxRuntimeConfig, "network"> & {
	/** Master switch; the sandbox extension stays inert unless true. Default: false. */
	enabled?: boolean;
	/** AI approval settings; there is no human review path. */
	approval?: SandboxApprovalConfig;
	network?: NonNullable<SandboxRuntimeConfig["network"]> & {
		allowUnauthenticatedSocksProxy?: boolean;
		/** Route ordinary `ssh` commands through the sandbox SOCKS proxy (macOS). */
		sshProxy?: boolean;
	};
};

export interface SandboxApprovalConfig {
	/** "provider/model-id"; unset uses the first catalog model with configured auth. */
	model?: string;
	/** Per-verdict timeout in seconds. Default: 30. */
	timeoutSeconds?: number;
	/** Judge calls allowed per session; over the budget fails closed. Default: 20. */
	maxPerSession?: number;
}

type NetworkConfig = NonNullable<SandboxConfig["network"]>;
type FilesystemConfig = NonNullable<SandboxConfig["filesystem"]>;

export type SandboxConfigFile = Omit<Partial<SandboxConfig>, "network" | "filesystem"> & {
	network?: Partial<NetworkConfig>;
	filesystem?: Partial<FilesystemConfig>;
};

export const DEFAULT_CONFIG: SandboxConfig = {
	enabled: false,
	network: {
		allowUnauthenticatedSocksProxy: process.platform === "darwin",
		sshProxy: true,
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
		],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: ["/Users", "/home"],
		allowRead: [".", "~/.config", "~/.local", "Library"],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

function mergeObjects(base: SandboxConfig, overrides: SandboxConfigFile): SandboxConfig {
	return {
		...base,
		...overrides,
		network: overrides.network ? ({ ...base.network, ...overrides.network } as NetworkConfig) : base.network,
		filesystem: overrides.filesystem
			? ({ ...base.filesystem, ...overrides.filesystem } as FilesystemConfig)
			: base.filesystem,
	};
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
	return value;
}

function mergeConfiguredArray(
	fallback: string[] | undefined,
	globalValue: unknown,
	projectValue: unknown,
): string[] | undefined {
	const globalEntries = stringArray(globalValue);
	const projectEntries = stringArray(projectValue);
	if (globalEntries === undefined && projectEntries === undefined) return fallback;
	return [...new Set([...(globalEntries ?? []), ...(projectEntries ?? [])])];
}

export function mergeConfigLayers(
	defaults: SandboxConfig,
	globalConfig: SandboxConfigFile,
	projectConfig: SandboxConfigFile,
): SandboxConfig {
	const merged = mergeObjects(mergeObjects(defaults, globalConfig), projectConfig);

	return {
		...merged,
		approval:
			globalConfig.approval === undefined && projectConfig.approval === undefined
				? undefined
				: { ...globalConfig.approval, ...projectConfig.approval },
		network: {
			...merged.network,
			allowedDomains:
				mergeConfiguredArray(
					defaults.network?.allowedDomains,
					globalConfig.network?.allowedDomains,
					projectConfig.network?.allowedDomains,
				) ?? [],
			deniedDomains:
				mergeConfiguredArray(
					defaults.network?.deniedDomains,
					globalConfig.network?.deniedDomains,
					projectConfig.network?.deniedDomains,
				) ?? [],
			allowUnixSockets: mergeConfiguredArray(
				defaults.network?.allowUnixSockets,
				globalConfig.network?.allowUnixSockets,
				projectConfig.network?.allowUnixSockets,
			),
			allowMachLookup: mergeConfiguredArray(
				defaults.network?.allowMachLookup,
				globalConfig.network?.allowMachLookup,
				projectConfig.network?.allowMachLookup,
			),
		},
		filesystem: {
			...merged.filesystem,
			denyRead:
				mergeConfiguredArray(
					defaults.filesystem?.denyRead,
					globalConfig.filesystem?.denyRead,
					projectConfig.filesystem?.denyRead,
				) ?? [],
			allowRead: mergeConfiguredArray(
				defaults.filesystem?.allowRead,
				globalConfig.filesystem?.allowRead,
				projectConfig.filesystem?.allowRead,
			),
			allowWrite:
				mergeConfiguredArray(
					defaults.filesystem?.allowWrite,
					globalConfig.filesystem?.allowWrite,
					projectConfig.filesystem?.allowWrite,
				) ?? [],
			denyWrite:
				mergeConfiguredArray(
					defaults.filesystem?.denyWrite,
					globalConfig.filesystem?.denyWrite,
					projectConfig.filesystem?.denyWrite,
				) ?? [],
		},
	};
}

function readJsonConfig(configPath: string, warn: boolean): SandboxConfigFile {
	if (!existsSync(configPath)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("configuration must be a JSON object");
		}
		return parsed as SandboxConfigFile;
	} catch (error) {
		if (warn) console.error(`Warning: Could not parse ${configPath}: ${error}`);
		return {};
	}
}

export function getConfigPaths(cwd: string): { globalPath: string; projectPath: string } {
	return {
		globalPath: join(getAgentDir(), "sandbox.json"),
		projectPath: join(cwd, CONFIG_DIR_NAME, "sandbox.json"),
	};
}

export function loadConfig(cwd: string): SandboxConfig {
	const { globalPath, projectPath } = getConfigPaths(cwd);
	const globalConfig = readJsonConfig(globalPath, true);
	const projectConfig = readJsonConfig(projectPath, true);
	return mergeConfigLayers(DEFAULT_CONFIG, globalConfig, projectConfig);
}
