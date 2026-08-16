import { getAgentDir } from "../packages/host/src/config.ts";
import { DefaultResourceLoader } from "../packages/host/src/core/resource-loader.ts";

async function main(): Promise<void> {
	const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: getAgentDir() });
	await loader.reload();
	const result = loader.getExtensions();
	console.log(
		JSON.stringify({
			extensions: result.extensions.map((extension) => ({ path: extension.sourceInfo.path })),
			errors: result.errors,
		}),
	);
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
