import type { FileEntry, SessionEntry, SessionHeader } from "../session-manager.ts";

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (typeof item === "string") {
			parts.push(item);
		} else if (item && typeof item === "object") {
			const record = item as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
		}
	}
	return parts.join("\n");
}

/** Extract searchable text from a session entry. Returns "" for non-text entries. */
export function entryToSearchText(entry: SessionEntry): string {
	switch (entry.type) {
		case "message": {
			const message = entry.message as { content?: unknown };
			return contentToText(message.content);
		}
		case "custom_message":
			return contentToText(entry.content);
		case "compaction":
		case "branch_summary":
			return entry.summary;
		case "label":
			return entry.label ?? "";
		case "session_info":
			return entry.name ?? "";
		default:
			return "";
	}
}

export interface IndexedEntryPayload {
	/** JSON stored in the entries table; also indexed by FTS. */
	payload: string;
	/** Extracted searchable text used for vector embedding. */
	text: string;
}

/** Serialize an entry for indexing: searchable text plus a payload JSON. */
export function entryToIndexPayload(entry: SessionEntry): IndexedEntryPayload {
	const text = entryToSearchText(entry);
	const payload = { type: entry.type, id: entry.id, text };
	return { payload: JSON.stringify(payload), text };
}

export function isHeader(entry: FileEntry): entry is SessionHeader {
	return entry.type === "session";
}
