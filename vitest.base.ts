import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiApi: fileURLToPath(new URL("./packages/ai/src/api", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	aiUtils: fileURLToPath(new URL("./packages/ai/src/utils", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@cogito\/ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@cogito\/ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@cogito\/ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@cogito\/ai\/api\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiApi}/$1.ts`,
			},
			{
				find: /^@cogito\/ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{
				find: /^@cogito\/ai\/utils\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiUtils}/$1.ts`,
			},
			{ find: /^@cogito\/agent-core$/, replacement: workspaceSourcePaths.agentIndex },
		],
	},
});
