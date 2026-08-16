/**
 * Headless theme placeholder.
 *
 * pi-host has no TUI, so there is no real theme. The extension API surface and
 * the resource loader still reference a Theme type (renderers, UI context,
 * theme resources); keep a loose, structurally-compatible placeholder so
 * modules that were extracted from pi-coding-agent keep typechecking and
 * runtime behavior.
 */

import { readFileSync } from "node:fs";
import type { SourceInfo } from "./source-info.ts";

/** Minimal headless theme type. */
export interface Theme {
	/** Theme name, when known. */
	name?: string;
	/** Source file path, when loaded from disk. */
	sourcePath?: string;
	/** Source metadata, when loaded from an extension or resource path. */
	sourceInfo?: SourceInfo;
	/** Colorize text. Headless: returns the text unchanged. */
	fg(color: string, text: string): string;
	/** Background colorize. Headless: returns the text unchanged. */
	bg(color: string, text: string): string;
	/** Bold text. Headless: returns the text unchanged. */
	bold(text: string): string;
	/** Strikethrough text. Headless: returns the text unchanged. */
	strikethrough(text: string): string;
	[key: string]: unknown;
}

const identity = (text: string): string => text;

/** Headless default theme: UI is not available, but the object stays stable. */
export const theme: Theme = { name: "headless", fg: identity, bg: identity, bold: identity, strikethrough: identity };

/**
 * Minimal theme file loader: parses a theme JSON file into a loose Theme.
 *
 * The headless host never renders themes; this exists only to keep the
 * resource loader's theme discovery working without the interactive theme
 * machinery.
 */
export function loadThemeFromPath(filePath: string): Theme {
	const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
	const name = typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : undefined;
	return {
		...parsed,
		name,
		sourcePath: filePath,
		fg: identity,
		bg: identity,
		bold: identity,
		strikethrough: identity,
	};
}
