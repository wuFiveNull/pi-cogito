import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileChannelSessionStore } from "../src/session.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("FileChannelSessionStore", () => {
	it("persists the coding-agent session mapping across gateway restarts", () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-agent-session-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "sessions.json");
		const first = new FileChannelSessionStore(path);
		first.setAgentSession("qq:user:42", {
			file: "/tmp/cogito-channel-session.jsonl",
			id: "channel-session-42",
		});

		const second = new FileChannelSessionStore(path);
		expect(second.getSession("qq:user:42")).toMatchObject({
			agentSessionFile: "/tmp/cogito-channel-session.jsonl",
			agentSessionId: "channel-session-42",
		});
	});
});
