/**
 * SDK 构建:esbuild 打包 react 系 shims → dist/web/sdk/。
 * 顺序:先 vite(sdk.js,清空 sdk 目录),再 esbuild(shims 覆盖写)。
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
// esbuild 在根 workspace 的 node_modules(ui 包本身不装依赖)
const esbuild = [
	resolve(root, "node_modules", ".bin", "esbuild"),
	resolve(root, "..", "..", "node_modules", ".bin", "esbuild"),
].find((path) => existsSync(path));
if (!esbuild) {
	throw new Error("esbuild not found in node_modules");
}

execSync("npx vite build --config sdk.config.ts", { cwd: root, stdio: "inherit" });

const shims = [
	["react", "src/web/sdk-shims/react.ts"],
	["react-dom-client", "src/web/sdk-shims/react-dom-client.ts"],
	["jsx-runtime", "src/web/sdk-shims/jsx-runtime.ts"],
];
for (const [name, entry] of shims) {
	execSync(
		`"${esbuild}" "${resolve(root, entry)}" --bundle --format=esm --outfile="${resolve(root, "dist", "web", "sdk", `${name}.js`)}" --log-level=warning`,
		{ cwd: root, stdio: "inherit" },
	);
}
console.log("[sdk] shims built");
