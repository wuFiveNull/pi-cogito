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
				find: /^@cogito\/ai$/,
				replacement: fileURLToPath(new URL("../ai/src/index.ts", import.meta.url)),
			},
			{
				find: /^@cogito\/ai\/(.+)$/,
				replacement: fileURLToPath(new URL("../ai/src/$1.ts", import.meta.url)),
			},
		],
	},
});
