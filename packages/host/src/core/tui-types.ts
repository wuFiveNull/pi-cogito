/**
 * Minimal headless placeholders for the terminal-UI types that the extension
 * API surface references.
 *
 * pi-host has no TUI: these types exist only so the ExtensionAPI shape
 * (headers, footers, editors, overlays, tool renderers) keeps typechecking.
 * The corresponding runtime methods are no-ops in the headless runner.
 */

/** Terminal UI handle. Headless: never provided. */
export interface TUI {}

/** A rendered UI component. Headless: never provided. */
export interface Component {
	dispose?(): void;
}

/** Editor component. Headless: never provided. */
export interface EditorComponent extends Component {}

/** Editor theme. Headless: unused. */
export interface EditorTheme {}

/** Overlay handle. Headless: never provided. */
export interface OverlayHandle {}

/** Overlay positioning/sizing options. Headless: unused. */
export interface OverlayOptions {}

/** Autocomplete suggestion item. Headless: unused. */
export interface AutocompleteItem {
	label: string;
	value: string;
}

/** Autocomplete provider. Headless: unused. */
export interface AutocompleteProvider {}

/** Scrollbar visibility mode for the fullscreen settings panel. */
export type ScrollViewScrollbar = "auto" | "hidden" | "visible" | "always";

/** UI mode. Headless: always "regular". */
export type TuiMode = "regular" | "fullscreen" | "alt";
