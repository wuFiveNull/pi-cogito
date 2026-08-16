import { readdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { AgentTool } from "@cogito/agent-core";
import { spawn } from "child_process";
import ignore from "ignore";
import { minimatch } from "minimatch";
import path from "path";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Find files matching glob pattern. Returns relative or absolute paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
	exists: pathExists,
	// This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
	glob: () => [],
};

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem plus fd (or a native fallback when fd is unavailable) */
	operations?: FindOperations;
}

const FIND_IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"] as const;
type FindIgnoreMatcher = ReturnType<typeof ignore>;

interface FindIgnoreRule {
	baseDir: string;
	matcher: FindIgnoreMatcher;
}

interface NativeFindResult {
	paths: string[];
	resultLimitReached: boolean;
}

function readFindIgnoreRules(dir: string): FindIgnoreRule[] {
	const rules: FindIgnoreRule[] = [];
	for (const filename of FIND_IGNORE_FILE_NAMES) {
		try {
			const matcher = ignore();
			matcher.add(readFileSync(path.join(dir, filename), "utf8").split(/\r?\n/));
			rules.push({ baseDir: dir, matcher });
		} catch {
			// Ignore missing or unreadable ignore files, matching fd's best-effort traversal.
		}
	}
	return rules;
}

function isIgnoredFindPath(candidate: string, isDirectory: boolean, rules: FindIgnoreRule[]): boolean {
	for (const rule of rules) {
		const relativeCandidate = path.relative(rule.baseDir, candidate);
		if (
			!relativeCandidate ||
			relativeCandidate === ".." ||
			relativeCandidate.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relativeCandidate)
		) {
			continue;
		}
		const ignorePath = toPosixPath(isDirectory ? `${relativeCandidate}${path.sep}` : relativeCandidate);
		if (rule.matcher.ignores(ignorePath)) return true;
	}
	return false;
}

function validateFindPattern(pattern: string): void {
	let escaped = false;
	let characterClassOpen = false;
	for (const character of pattern) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
		} else if (character === "[") {
			characterClassOpen = true;
		} else if (character === "]") {
			characterClassOpen = false;
		}
	}
	if (characterClassOpen) {
		throw new Error(`error parsing glob: unclosed character class in ${JSON.stringify(pattern)}`);
	}
}

function collectNativeFindResults(
	searchPath: string,
	pattern: string,
	limit: number,
	signal?: AbortSignal,
): NativeFindResult {
	validateFindPattern(pattern);
	const paths: string[] = [];
	const matchBase = !pattern.includes("/");

	const walk = (directory: string, inheritedRules: FindIgnoreRule[]): boolean => {
		if (signal?.aborted) throw new Error("Operation aborted");
		const rules = [...inheritedRules, ...readFindIgnoreRules(directory)];
		const entries = (() => {
			try {
				return readdirSync(directory, { withFileTypes: true });
			} catch {
				return [];
			}
		})();
		entries.sort((left, right) => left.name.localeCompare(right.name));

		for (const entry of entries) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const fullPath = path.join(directory, entry.name);
			const isDirectory = entry.isDirectory();
			if (isDirectory && entry.name === ".git") continue;
			if (isIgnoredFindPath(fullPath, isDirectory, rules)) continue;

			const relativePath = toPosixPath(path.relative(searchPath, fullPath));
			if (minimatch(relativePath, pattern, { dot: true, matchBase })) {
				paths.push(relativePath);
				if (paths.length >= limit) return true;
			}

			if (isDirectory && walk(fullPath, rules)) return true;
		}
		return false;
	};

	walk(searchPath, []);
	return { paths, resultLimitReached: paths.length >= limit };
}

export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		searchHint: "查找 定位 文件名 通配符 找文件 glob find",
		promptSnippet: "Find files by glob pattern (respects .gitignore)",
		parameters: findSchema,
		async execute(
			_toolCallId,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				let settled = false;
				let stopChild: (() => void) | undefined;
				const settle = (fn: () => void) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					stopChild = undefined;
					fn();
				};
				const onAbort = () => {
					stopChild?.();
					settle(() => reject(new Error("Operation aborted")));
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;
						const ops = customOps ?? defaultFindOperations;

						// If custom operations provide glob(), use that instead of fd.
						if (customOps?.glob) {
							if (!(await ops.exists(searchPath))) {
								settle(() => reject(new Error(`Path not found: ${searchPath}`)));
								return;
							}
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							const results = await ops.glob(pattern, searchPath, {
								ignore: ["**/node_modules/**", "**/.git/**"],
								limit: effectiveLimit,
							});
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (results.length === 0) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No files found matching pattern" }],
										details: undefined,
									}),
								);
								return;
							}

							// Relativize paths against the search root for stable output.
							const relativized = results.map((p) => {
								if (p.startsWith(searchPath)) return toPosixPath(p.slice(searchPath.length + 1));
								return toPosixPath(path.relative(searchPath, p));
							});
							const resultLimitReached = relativized.length >= effectiveLimit;
							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];
							if (resultLimitReached) {
								notices.push(`${effectiveLimit} results limit reached`);
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							settle(() =>
								resolve({
									content: [{ type: "text", text: resultOutput }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
							return;
						}

						// Default implementation prefers fd, with a native fallback for offline environments.
						const fdPath = await ensureTool("fd", true);
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						if (!fdPath) {
							if (!(await pathExists(searchPath))) {
								settle(() => reject(new Error(`Path not found: ${searchPath}`)));
								return;
							}

							const nativeResult = collectNativeFindResults(searchPath, pattern, effectiveLimit, signal);
							if (nativeResult.paths.length === 0) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No files found matching pattern" }],
										details: undefined,
									}),
								);
								return;
							}

							const rawOutput = nativeResult.paths.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];
							if (nativeResult.resultLimitReached) {
								notices.push(
									`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (notices.length > 0) resultOutput += `\n\n[${notices.join(". ")}]`;
							settle(() =>
								resolve({
									content: [{ type: "text", text: resultOutput }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
							return;
						}

						const commandPath = fdPath;
						const commandName = "fd";
						const args: string[] = ["--glob", "--color=never", "--hidden"];

						// fd normally ignores .gitignore outside git repos, so keep --no-require-git
						// there. Inside repos, use fd's default git-aware behavior so parent
						// .gitignore rules stop at nested repo boundaries:
						// https://github.com/earendil-works/pi/issues/5960
						let insideGitRepo = false;
						for (let current = searchPath; ; ) {
							if (await pathExists(path.join(current, ".git"))) {
								insideGitRepo = true;
								break;
							}
							const parent = path.dirname(current);
							if (parent === current) break;
							current = parent;
						}
						if (!insideGitRepo) args.push("--no-require-git");
						args.push("--max-results", String(effectiveLimit));

						// fd --glob matches against the basename unless --full-path is set; in --full-path
						// mode it matches against the absolute candidate path, so a path-containing
						// pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
						let effectivePattern = pattern;
						if (pattern.includes("/")) {
							args.push("--full-path");
							if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
								effectivePattern = `**/${pattern}`;
							}
						}
						args.push("--", effectivePattern, searchPath);

						const command = commandPath;
						const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						const lines: string[] = [];

						stopChild = () => {
							if (!child.killed) {
								child.kill();
							}
						};

						const cleanup = () => {
							rl.close();
						};

						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						rl.on("line", (line) => {
							lines.push(line);
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ${commandName}: ${error.message}`)));
						});

						child.on("close", (code) => {
							cleanup();
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							const output = lines.join("\n");
							if (code !== 0) {
								const errorMsg = stderr.trim() || `${commandName} exited with code ${code}`;
								if (!output) {
									settle(() => reject(new Error(errorMsg)));
									return;
								}
							}
							if (!output) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No files found matching pattern" }],
										details: undefined,
									}),
								);
								return;
							}

							const relativized: string[] = [];
							for (const rawLine of lines) {
								const line = rawLine.replace(/\r$/, "").trim();
								if (!line) continue;
								const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
								let relativePath = line;
								if (line.startsWith(searchPath)) {
									relativePath = line.slice(searchPath.length + 1);
								} else {
									relativePath = path.relative(searchPath, line);
								}
								if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
								relativized.push(toPosixPath(relativePath));
							}

							const resultLimitReached = relativized.length >= effectiveLimit;
							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];
							if (resultLimitReached) {
								notices.push(
									`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							settle(() =>
								resolve({
									content: [{ type: "text", text: resultOutput }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (e) {
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						const error = e instanceof Error ? e : new Error(String(e));
						settle(() => reject(error));
					}
				})();
			});
		},
	};
}

export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
