/**
 * ChatPresenceWriter — record user activity into the proactive presence table.
 *
 * The proactive daemon reads `presence.last_user_at` to drive the energy-based
 * adaptive tick interval. The gateway owns inbound messages, so it writes the
 * heartbeat here (cross-process write into proactive.sqlite).
 *
 * Each write opens a fresh connection: the proactive daemon holds the database
 * in WAL mode with a long-lived connection, and a long-lived second connection
 * can go stale across WAL checkpoints. Failures are swallowed so chat is never
 * blocked by the proactive db.
 */

import { createSqliteDatabase } from "@cogito/agent-core/sqlite";

const PRESENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS presence (
	session_key TEXT PRIMARY KEY,
	last_user_at INTEGER,
	last_proactive_at INTEGER
);
`;

const UPSERT_PRESENCE = `
INSERT INTO presence (session_key, last_user_at, last_proactive_at)
VALUES (?, ?, NULL)
ON CONFLICT(session_key) DO UPDATE SET last_user_at = MAX(last_user_at, excluded.last_user_at)
`;

export class ChatPresenceWriter {
	private readonly proactiveDbPath: string;
	private readonly log: (message: string) => void;

	constructor(proactiveDbPath: string, log: (message: string) => void = () => {}) {
		this.proactiveDbPath = proactiveDbPath;
		this.log = log;
	}

	/** Record an inbound user message timestamp (ms). */
	recordUserMessage(timestampMs: number, sessionKey = "local"): void {
		if (!Number.isFinite(timestampMs)) return;
		try {
			const db = createSqliteDatabase(this.proactiveDbPath);
			try {
				db.exec(PRESENCE_SCHEMA);
				db.prepare(UPSERT_PRESENCE).run(sessionKey, Math.trunc(timestampMs));
			} finally {
				db.close();
			}
		} catch (error) {
			// Presence is best-effort: never break the chat turn on it.
			this.log(`presence write failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	close(): void {
		// Connections are per-write; nothing to close.
	}
}
