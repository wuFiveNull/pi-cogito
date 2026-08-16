/**
 * Source registry — dynamic discovery of proactive data sources and plugins.
 *
 * Scans directories for *.ts modules. A module may be:
 * - a plugin: named export `plugin` (or default export) implementing
 *   ProactivePlugin — may contribute sources, lifecycles, modules, factories;
 * - legacy source: default export class/factory implementing ProactiveSource
 *   (auto-wrapped into a single-source plugin).
 *
 * Adding a new source is just dropping one file into the directory; no
 * registration code needed. Individual module failures are skipped so one
 * broken module cannot disable the rest. When the same source id appears in
 * multiple directories, the earlier directory wins (custom extensions take
 * precedence over built-ins).
 */

import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti/static";
import { isProactivePlugin, type ProactivePlugin, sourceAsPlugin } from "./ext/plugin.ts";
import type { ProactiveSource } from "./types.ts";

export interface LoadedSource {
	source: ProactiveSource;
	path: string;
}

/** 已加载的插件及其来源文件路径。 */
export interface LoadedPlugin {
	plugin: ProactivePlugin;
	path: string;
}

/** 加载目录中的全部插件(含旧格式 source 的自动包装)。 */
export async function loadPlugins(...pluginsDirs: string[]): Promise<LoadedPlugin[]> {
	const plugins: LoadedPlugin[] = [];
	const jiti = createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true });
	for (const dir of pluginsDirs) {
		for (const file of filesInDir(dir)) {
			const loaded = await loadOneFile(jiti, file);
			if (loaded) plugins.push({ plugin: loaded, path: file });
		}
	}
	return plugins;
}

/**
 * Load all sources from one or more directories, in order. Never throws:
 * individual module failures are skipped so one broken source cannot disable
 * the rest. When the same source id appears in multiple directories, the
 * earlier directory wins (custom extensions take precedence over built-ins).
 */
export async function loadSources(...sourcesDirs: string[]): Promise<Map<string, LoadedSource>> {
	const result = new Map<string, LoadedSource>();
	const plugins = await loadPlugins(...sourcesDirs);
	for (const { plugin, path } of plugins) {
		for (const source of plugin.proactiveSources?.() ?? []) {
			if (!result.has(source.id)) {
				result.set(source.id, { source, path });
			}
		}
	}
	return result;
}

/** 目录内的 .ts/.js 文件(递归一层子目录)。 */
function filesInDir(dir: string): string[] {
	const files: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const entry of entries) {
		if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
			files.push(join(dir, entry.name));
		}
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		let subFiles: string[];
		try {
			subFiles = readdirSync(join(dir, entry.name)).filter((name) => name.endsWith(".ts") || name.endsWith(".js"));
		} catch {
			continue;
		}
		for (const name of subFiles) files.push(join(dir, entry.name, name));
	}
	return files;
}

/** 加载单个文件为插件;失败或形状不符返回 undefined。 */
async function loadOneFile(jiti: ReturnType<typeof createJiti>, file: string): Promise<ProactivePlugin | undefined> {
	try {
		const raw = await jiti.import(file, { default: true });
		const exported = (raw as { default?: unknown } | null)?.default ?? raw;
		const mod = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
		// 1. named export `plugin`。
		const named = mod.plugin;
		if (isProactivePlugin(named)) return named;
		// 2. default export 插件对象。
		if (isProactivePlugin(exported)) return exported;
		// 3. default export 可构造值:先试插件类,再试旧格式 source 类/工厂。
		if (typeof exported === "function") {
			const plugin = tryConstruct(exported, isProactivePlugin);
			if (plugin) return plugin;
			const source = tryConstruct(exported, isSourceShape);
			if (source) return sourceAsPlugin(source);
		}
		console.error(`proactive plugin load skipped file=${file}: invalid plugin/source export`);
		return undefined;
	} catch (error) {
		console.error(`proactive plugin load failed file=${file}: ${formatError(error)}`);
		return undefined;
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function tryConstruct<T>(ctor: unknown, guard: (value: unknown) => value is T): T | undefined {
	let instance: unknown;
	try {
		instance = new (ctor as new () => unknown)();
	} catch {
		try {
			instance = (ctor as () => unknown)();
		} catch {
			return undefined;
		}
	}
	return guard(instance) ? instance : undefined;
}

function isSourceShape(value: unknown): value is ProactiveSource {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as ProactiveSource).id === "string" &&
		typeof (value as ProactiveSource).fetch === "function"
	);
}
