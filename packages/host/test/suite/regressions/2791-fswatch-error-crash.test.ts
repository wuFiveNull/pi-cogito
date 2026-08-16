import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Regression test for https://github.com/earendil-works/pi-mono/issues/2791
 *
 * fs.watch() returns an FSWatcher (EventEmitter). If the watcher emits an
 * 'error' event after creation and no error handler is attached, Node.js
 * treats it as an uncaught exception and terminates the process.
 *
 * We test this by spawning a child process that creates a watcher through the
 * same error-safe helper used by the theme and footer watchers, then emits a
 * synthetic error event on the returned watcher.
 */
describe("issue #2791 fs.watch error event crashes process", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-2791-"));
		mkdirSync(join(tempRoot, "watched"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("process should survive an error event on the theme FSWatcher", () => {
		const watchModulePath = join(__dirname, "../../../src/utils/fs-watch.ts").replace(/\\/g, "/");
		const watchPath = join(tempRoot, "watched").replace(/\\/g, "/");

		// If no .on('error') handler is attached, EventEmitter.emit('error') throws.
		const scriptPath = join(tempRoot, "test-watcher-error.mts");
		writeFileSync(
			scriptPath,
			`
import { closeWatcher, watchWithErrorHandler } from "${watchModulePath}";

const fsWatcher = watchWithErrorHandler("${watchPath}", () => {}, () => {});

if (!fsWatcher) {
	process.stderr.write("watcher could not be created\\n");
	process.exit(2);
}

const errorListenerCount = fsWatcher.listenerCount("error");
if (errorListenerCount === 0) {
	process.stderr.write("BUG: FSWatcher has no error handler (issue #2791)\\n");
}

try {
	fsWatcher.emit("error", new Error("simulated OS watcher failure"));
} catch {
	process.stderr.write("error event was unhandled and threw\\n");
	process.exit(1);
}

	closeWatcher(fsWatcher);
	process.exit(0);
`,
		);

		let _stdout = "";
		let stderr = "";
		let exitCode: number;
		try {
			_stdout = execFileSync(process.execPath, [scriptPath], {
				timeout: 10000,
				encoding: "utf-8",
				env: process.env,
				stdio: ["pipe", "pipe", "pipe"],
			});
			exitCode = 0;
		} catch (err: unknown) {
			const e = err as { status: number; stdout: string; stderr: string };
			_stdout = e.stdout ?? "";
			stderr = e.stderr ?? "";
			exitCode = e.status ?? 1;
		}

		expect(exitCode, `Child crashed (exit ${exitCode}). stderr: ${stderr.trim()}`).toBe(0);
	});
});
