/**
 * @cogito/ui — UI hosting layer for pi modules.
 *
 * Hosts multiple UI apps (web dashboards, admin panels, mobile web UIs, ...)
 * on one HTTP server. New UIs are plain UiApp registrations — no host code
 * changes needed.
 */

export { UiRegistry } from "./registry.ts";
export { isPathInside, serveStaticFile } from "./static.ts";
export type { UiApiRoute, UiApp } from "./types.ts";
export type { WebApi, WebApiOptions } from "./web-api.ts";
export { createWebApi } from "./web-api.ts";
export { builtinWebApp, WEB_PAGE_DIR } from "./web-app.ts";
