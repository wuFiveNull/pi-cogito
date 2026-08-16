import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["test/**/*.test.ts"],
	},
	resolve: {
		alias: [
			{
				find: /^@cogito\/gate$/,
				replacement: fileURLToPath(new URL("../gate/src/index.ts", import.meta.url)),
			},
			{
				find: /^@cogito\/agent-core$/,
				replacement: fileURLToPath(new URL("../agent/src/index.ts", import.meta.url)),
			},
			{
				find: /^@cogito\/ai$/,
				replacement: fileURLToPath(new URL("../ai/src/index.ts", import.meta.url)),
			},
			{
				find: /^@cogito\/ai\/(.+)$/,
				replacement: fileURLToPath(new URL("../ai/src/$1.ts", import.meta.url)),
			},
			{
				find: /^@cogito\/host$/,
				replacement: fileURLToPath(new URL("../host/src/index.ts", import.meta.url)),
			},
		],
	},
});
