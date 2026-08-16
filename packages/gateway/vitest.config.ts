import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["test/**/*.test.ts"],
	},
	resolve: {
		alias: {
			"@cogito/ui": fileURLToPath(new URL("../ui/src/index.ts", import.meta.url)),
		},
	},
});
