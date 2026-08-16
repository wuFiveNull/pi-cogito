/**
 * Vite config for the built-in web UI (src/web -> dist/web).
 * The web app is a plain React SPA served by serveStaticFile / UiRegistry.
 */

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: "src/web",
	plugins: [react()],
	build: {
		outDir: "../../dist/web",
		emptyOutDir: true,
		sourcemap: true,
	},
	server: {
		port: 5173,
	},
});
