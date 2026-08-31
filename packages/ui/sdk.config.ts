/**
 * SDK 构建:sdk.js(api + 组件库,external react)。
 * react 系 shims 由 scripts/build-sdk.mjs 用 esbuild 打包(它们自身提供 react)。
 */

import { defineConfig } from "vite";
import { resolve } from "node:path";

const here = resolve(import.meta.dirname);

export default defineConfig({
	build: {
		outDir: "dist/web/assets/sdk",
		emptyOutDir: true,
		sourcemap: false,
		lib: {
			entry: {
				sdk: resolve(here, "src/web/src/sdk/sdk.ts"),
			},
			formats: ["es"],
		},
		rollupOptions: {
			external: ["react", "react-dom/client", "react/jsx-runtime"],
			output: {
				entryFileNames: "[name].js",
			},
		},
	},
});
