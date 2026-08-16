import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEnvOverrides, loadGatewayConfig, watchGatewayConfig } from "../src/config.ts";

const originalEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"GATEWAY_CONFIG",
	"GATEWAY_FEISHU_APP_ID",
	"GATEWAY_FEISHU_APP_SECRET",
	"GATEWAY_FEISHU_ENABLED",
	"GATEWAY_WEB_PORT",
	"GATEWAY_WEB_AUTH_TOKEN",
	"GATEWAY_WEB_RATE_LIMIT_MAX_REQUESTS",
	"GATEWAY_WEB_TLS_KEY_FILE",
	"GATEWAY_WEB_TLS_CERT_FILE",
];

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
});

function tempConfig(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "gw-config-"));
	const file = join(dir, "config.json");
	writeFileSync(file, content);
	return file;
}

describe("loadGatewayConfig", () => {
	it("loads the JSON file as-is", () => {
		const file = tempConfig(
			JSON.stringify({
				channels: { feishu: { enabled: true, appId: "cli_test" }, discord: { enabled: false, token: "x" } },
				web: { host: "0.0.0.0", port: 8080 },
			}),
		);
		const config = loadGatewayConfig(file);
		expect(config.channels?.feishu).toMatchObject({ enabled: true, appId: "cli_test" });
		expect(config.channels?.discord).toMatchObject({ enabled: false, token: "x" });
		expect(config.web).toMatchObject({ host: "0.0.0.0", port: 8080 });
		rmSync(file, { recursive: false });
	});

	it("throws on missing file and invalid JSON", () => {
		expect(() => loadGatewayConfig("/nonexistent/config.json")).toThrow(/无法读取/);
		const file = tempConfig("{ not json");
		expect(() => loadGatewayConfig(file)).toThrow(/不是合法 JSON/);
		rmSync(file, { recursive: false });
	});

	it("honors the GATEWAY_CONFIG env var", () => {
		const file = tempConfig(JSON.stringify({ channels: { web: { allowFrom: ["*"] } } }));
		process.env.GATEWAY_CONFIG = file;
		const config = loadGatewayConfig();
		expect(config.channels?.web).toMatchObject({ allowFrom: ["*"] });
		rmSync(file, { recursive: false });
	});
});

describe("applyEnvOverrides", () => {
	it("maps GATEWAY_<CHANNEL>_<FIELD> to camelCase settings", () => {
		process.env.GATEWAY_FEISHU_APP_ID = "cli_env";
		process.env.GATEWAY_FEISHU_APP_SECRET = "s3cret";
		process.env.GATEWAY_FEISHU_ENABLED = "true";
		process.env.GATEWAY_WEB_PORT = "9090";
		const config = applyEnvOverrides({
			channels: { feishu: { enabled: false, appId: "cli_file" } },
			web: { port: 0 },
		});
		expect(config.channels?.feishu).toEqual({
			enabled: true, // 字符串 "true" 转布尔
			appId: "cli_env",
			appSecret: "s3cret",
		});
		expect(config.web?.port).toBe(9090); // web 段特判
	});

	it("creates missing channel entries from env vars", () => {
		process.env.GATEWAY_MATRIX_ACCESS_TOKEN = "tok";
		const config = applyEnvOverrides({ channels: {} });
		expect(config.channels?.matrix).toMatchObject({ accessToken: "tok" });
	});

	it("maps security overrides into nested auth and rate-limit settings", () => {
		process.env.GATEWAY_WEB_AUTH_TOKEN = "secret";
		process.env.GATEWAY_WEB_RATE_LIMIT_MAX_REQUESTS = "10";
		const config = applyEnvOverrides({ channels: { web: {} } });
		expect(config.channels?.web).toMatchObject({
			auth: { token: "secret" },
			rateLimit: { maxRequests: 10 },
		});
	});

	it("maps Web TLS file overrides into the top-level Web section", () => {
		process.env.GATEWAY_WEB_TLS_KEY_FILE = "/tmp/key.pem";
		process.env.GATEWAY_WEB_TLS_CERT_FILE = "/tmp/cert.pem";
		const config = applyEnvOverrides({ web: {} });
		expect(config.web?.tls).toEqual({ keyFile: "/tmp/key.pem", certFile: "/tmp/cert.pem" });
	});

	it("debounces atomic config saves and ignores invalid snapshots", async () => {
		const file = tempConfig(JSON.stringify({ channels: { web: { allowFrom: ["one"] } } }));
		const snapshots: string[][] = [];
		const errors: Error[] = [];
		const watcher = watchGatewayConfig(
			file,
			(config) => {
				snapshots.push((config.channels?.web?.allowFrom as string[] | undefined) ?? []);
			},
			{ debounceMs: 10, onError: (error) => errors.push(error) },
		);
		writeFileSync(file, "{invalid");
		await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 2000, interval: 10 });
		writeFileSync(file, JSON.stringify({ channels: { web: { allowFrom: ["two"] } } }));
		await vi.waitFor(() => expect(snapshots).toEqual([["two"]]), { timeout: 2000, interval: 10 });
		watcher.close();
		rmSync(file, { recursive: false });
	});
});
