/**
 * File-backed context shared by Drift system prompts and runtime frames.
 *
 * The layout follows akashic's workspace memory files while keeping loading
 * independent from the SQLite-backed Drift state store.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DriftRunContext } from "./runtime.ts";

export interface DriftContextSnapshot {
	/** User-maintained persona and behavioral context. */
	veda?: string;
	/** Assistant self-model from memory/SELF.md. */
	selfModel?: string;
	/** Stable user memory from memory/MEMORY.md. */
	longTermMemory?: string;
	/** Recent contextual summary, excluding the raw-turn tail. */
	recentContext?: string;
}

export interface DriftContextProvider {
	load(ctx: DriftRunContext): DriftContextSnapshot | Promise<DriftContextSnapshot>;
}

export interface FileDriftContextProviderOptions {
	/** Workspace containing the memory/ directory. */
	workspaceDir: string;
	/** VEDA path, absolute or relative to workspaceDir. Defaults to memory/VEDA.md. */
	vedaPath?: string;
	/** Missing or empty VEDA is an error when enabled. */
	requiredVeda?: boolean;
}

export class DriftVedaLoadError extends Error {
	readonly path: string;

	constructor(path: string, reason: string) {
		super(`failed to load Drift VEDA at ${path}: ${reason}`);
		this.name = "DriftVedaLoadError";
		this.path = path;
	}
}

export class FileDriftContextProvider implements DriftContextProvider {
	readonly workspaceDir: string;
	readonly vedaPath: string;
	readonly requiredVeda: boolean;

	constructor(options: FileDriftContextProviderOptions) {
		this.workspaceDir = resolve(options.workspaceDir);
		const configuredVedaPath = options.vedaPath?.trim();
		this.vedaPath = configuredVedaPath
			? resolve(isAbsolute(configuredVedaPath) ? configuredVedaPath : join(this.workspaceDir, configuredVedaPath))
			: join(this.workspaceDir, "memory", "VEDA.md");
		this.requiredVeda = options.requiredVeda ?? false;
	}

	load(_ctx: DriftRunContext): DriftContextSnapshot {
		return {
			veda: this.readVeda(),
			selfModel: readOptionalText(join(this.workspaceDir, "memory", "SELF.md")),
			longTermMemory: readOptionalText(join(this.workspaceDir, "memory", "MEMORY.md")),
			recentContext: readRecentContext(join(this.workspaceDir, "memory", "RECENT_CONTEXT.md")),
		};
	}

	private readVeda(): string | undefined {
		let text: string;
		try {
			text = readUtf8(this.vedaPath);
		} catch (error) {
			if (errorCode(error) === "ENOENT") {
				if (this.requiredVeda) {
					throw new DriftVedaLoadError(this.vedaPath, "file is missing; create it or disable requiredVeda");
				}
				return undefined;
			}
			throw error;
		}

		const content = text.trim();
		if (!content) {
			if (this.requiredVeda) {
				throw new DriftVedaLoadError(this.vedaPath, "file is empty; add persona content or disable requiredVeda");
			}
			return undefined;
		}
		return content;
	}
}

function readRecentContext(path: string): string | undefined {
	const text = readOptionalText(path);
	if (!text) return undefined;
	const markerIndex = text.indexOf("\n## Recent Turns");
	if (markerIndex >= 0) return text.slice(0, markerIndex).trim() || undefined;
	return text.startsWith("## Recent Turns") ? undefined : text;
}

function readOptionalText(path: string): string | undefined {
	try {
		const text = readUtf8(path).trim();
		return text || undefined;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

function readUtf8(path: string): string {
	const bytes = readFileSync(path);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error(`failed to read Drift context file ${path}: invalid UTF-8`);
	}
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}
