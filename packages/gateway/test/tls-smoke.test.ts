import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MessageBus } from "../src/bus.ts";
import { WebChannel } from "../src/channels/web.ts";

const running: WebChannel[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const channel of running.splice(0)) await channel.stop();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("TLS transport smoke", () => {
	it("serves the health endpoint over a real local HTTPS listener", async () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-tls-"));
		temporaryDirectories.push(directory);
		const keyFile = join(directory, "key.pem");
		const certFile = join(directory, "cert.pem");
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				keyFile,
				"-out",
				certFile,
				"-days",
				"1",
				"-subj",
				"/CN=localhost",
			],
			{ stdio: "ignore" },
		);
		const channel = new WebChannel({ allowFrom: ["*"] }, new MessageBus(), {
			host: "127.0.0.1",
			port: 0,
			tls: { keyFile, certFile },
		});
		await channel.start();
		running.push(channel);

		const response = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
			const request = httpsGet(
				`https://127.0.0.1:${channel.port}/api/health`,
				{ rejectUnauthorized: false },
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () =>
						resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
					);
				},
			);
			request.on("error", reject);
		});
		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.body)).toEqual({ ok: true });
	});
});
