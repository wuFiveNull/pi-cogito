/**
 * Shared sqlite conflict test — extension B.
 *
 * Counterpart of conflict-a.ts: increments the same shared `test` row 25 times
 * per invocation. Together with /conflict-a they prove that atomic upserts on
 * the shared extensions database never lose updates across extensions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("conflict-b", {
		description: "Increment shared sqlite test row 25 times (conflict test B)",
		handler: async (_args, ctx) => {
			ctx.sqlite.exec("CREATE TABLE IF NOT EXISTS test (k TEXT PRIMARY KEY, value REAL)");
			for (let i = 0; i < 25; i++) {
				ctx.sqlite.run(
					"INSERT INTO test (k, value) VALUES ('shared', 1) ON CONFLICT(k) DO UPDATE SET value = value + 1",
				);
			}
			const row = ctx.sqlite.get("SELECT value FROM test WHERE k = 'shared'");
			ctx.ui.notify(`conflict-b: value is now ${row?.value ?? "?"}`, "info");
		},
	});
}
