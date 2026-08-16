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
				find: /^@cogito\/agent-core\/node$/,
				replacement: fileURLToPath(new URL("../agent/src/node.ts", import.meta.url)),
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
				find: /^@cogito\/gate$/,
				replacement: fileURLToPath(new URL("../gate/src/index.ts", import.meta.url)),
			},
			{
				find: /^@cogito\/drift$/,
				replacement: fileURLToPath(new URL("../drift/src/index.ts", import.meta.url)),
			},
			{
				find: /^@cogito\/proactive$/,
				replacement: fileURLToPath(new URL("../proactive/src/index.ts", import.meta.url)),
			},
			{
				find: /^@cogito\/gateway$/,
				replacement: fileURLToPath(new URL("../gateway/src/index.ts", import.meta.url)),
			},
		],
	},
});
