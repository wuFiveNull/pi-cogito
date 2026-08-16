/**
 * Shared sqlite conflict test — extension A.
 *
 * Every invocation increments the shared `test` table's `shared` row 25 times
 * with atomic single-statement upserts. Run /conflict-a and /conflict-b
 * interleaved to verify concurrent extensions never lose updates on the
 * shared extensions database.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("conflict-a", {
		description: "Increment shared sqlite test row 25 times (conflict test A)",
		handler: async (_args, ctx) => {
			ctx.sqlite.exec("CREATE TABLE IF NOT EXISTS test (k TEXT PRIMARY KEY, value REAL)");
			for (let i = 0; i < 25; i++) {
				ctx.sqlite.run(
					"INSERT INTO test (k, value) VALUES ('shared', 1) ON CONFLICT(k) DO UPDATE SET value = value + 1",
				);
			}
			const row = ctx.sqlite.get("SELECT value FROM test WHERE k = 'shared'");
			ctx.ui.notify(`conflict-a: value is now ${row?.value ?? "?"}`, "info");
		},
	});
}
