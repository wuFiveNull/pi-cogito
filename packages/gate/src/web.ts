/**
 * 共享 web 安全策略(SSRF/域名边界)。
 *
 * 从 @cogito/drift 的 tools.ts 上移:proactive 的 judge web_fetch/web_search
 * 与 drift 共用同一套 host 校验、DNS 解析固定、redirect 逐跳校验实现。
 * drift 保留 re-export,公开 API 不变。
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface DriftWebFetchResult {
	text?: string;
	error?: string;
	truncated?: boolean;
	url?: string;
}

export interface DriftWebSearchItem {
	title: string;
	url: string;
	snippet: string;
}

export type DriftWebFetchFn = (url: string, maxChars: number, timeoutMs: number) => Promise<DriftWebFetchResult>;

export type DriftWebSearchFn = (query: string, maxResults: number, timeoutMs: number) => Promise<DriftWebSearchItem[]>;

export interface DriftWebResolvedAddress {
	address: string;
	family: 4 | 6;
}

/** Optional host-owned resolver used to test or constrain native web requests. */
export type DriftWebDnsLookupFn = (hostname: string) => Promise<readonly DriftWebResolvedAddress[]>;

export interface DriftWebPolicy {
	/** Permit loopback, link-local, private and reserved network destinations. */
	allowPrivateNetwork?: boolean;
	/** Optional host allowlist. Entries may be exact hosts or *.example.com. */
	allowedHosts?: readonly string[];
	/** Optional host denylist, evaluated before the allowlist. */
	blockedHosts?: readonly string[];
	/** Number of validated redirect hops; default 0 (redirects are rejected). */
	maxRedirectHops?: number;
}

export const DEFAULT_WEB_MAX_CHARS = 8_000;
export const DEFAULT_WEB_MAX_RESULTS = 5;
export const DEFAULT_WEB_TIMEOUT_MS = 60_000;

export function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
	const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

export function formatWebError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

export function validateWebUrl(value: string, policy: DriftWebPolicy | undefined): string | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "url must be an http(s) URL";
	}
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const blockedHosts = policy?.blockedHosts ?? [];
	if (blockedHosts.some((pattern) => matchesHostPattern(hostname, pattern))) {
		return `web host is blocked: ${hostname}`;
	}
	const allowedHosts = policy?.allowedHosts ?? [];
	if (allowedHosts.length > 0 && !allowedHosts.some((pattern) => matchesHostPattern(hostname, pattern))) {
		return `web host is not allowed: ${hostname}`;
	}
	if (!(policy?.allowPrivateNetwork ?? false) && isPrivateNetworkHost(hostname)) {
		return `private or local web host is blocked: ${hostname}`;
	}
	return null;
}

export function matchesHostPattern(hostname: string, pattern: string): boolean {
	const normalized = pattern
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
	if (!normalized) return false;
	if (normalized.startsWith("*.")) {
		const suffix = normalized.slice(1);
		return hostname.endsWith(suffix) && hostname.length > suffix.length;
	}
	return hostname === normalized;
}

export function isPrivateNetworkHost(hostname: string): boolean {
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal") ||
		hostname === "metadata.google.internal"
	)
		return true;
	const ipv4 = parseIpv4(hostname);
	if (ipv4) {
		const [first, second] = ipv4;
		return (
			first === 0 ||
			first === 10 ||
			(first === 100 && second >= 64 && second <= 127) ||
			first === 127 ||
			(first === 169 && second === 254) ||
			(first === 172 && second >= 16 && second <= 31) ||
			(first === 192 && second === 168) ||
			(first === 192 && second === 0) ||
			(first === 198 && (second === 18 || second === 19 || second === 51)) ||
			(first === 203 && second === 0) ||
			first >= 224
		);
	}
	const ipv6 = hostname.toLowerCase().replace(/^::ffff:/, "");
	return (
		hostname === "::1" ||
		hostname === "::" ||
		ipv6.startsWith("fc") ||
		ipv6.startsWith("fd") ||
		ipv6.startsWith("fe8") ||
		ipv6.startsWith("fe9") ||
		ipv6.startsWith("fea") ||
		ipv6.startsWith("feb") ||
		ipv6.startsWith("ff") ||
		ipv6.startsWith("2001:db8") ||
		ipv6.startsWith("2001:0") ||
		ipv6.startsWith("100::") ||
		Boolean(parseIpv4(ipv6) && isPrivateNetworkHost(ipv6))
	);
}

export function parseIpv4(hostname: string): [number, number, number, number] | null {
	const parts = hostname.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
	const numbers = parts.map(Number);
	return numbers.every((number) => number >= 0 && number <= 255)
		? (numbers as [number, number, number, number])
		: null;
}

export async function fetchWebPage(
	url: string,
	maxChars: number,
	timeoutMs: number,
	policy?: DriftWebPolicy,
	dnsLookupFn?: DriftWebDnsLookupFn,
): Promise<DriftWebFetchResult> {
	const urlError = validateWebUrl(url, policy);
	if (urlError) return { url, error: urlError };
	const response = await requestWebResponse(url, {}, timeoutMs, policy, dnsLookupFn, Math.max(64_000, maxChars * 8));
	if (response.statusCode < 200 || response.statusCode >= 300) return { url, error: `http ${response.statusCode}` };
	const text = webHtmlToText(response.body);
	return { url, text: text.slice(0, maxChars), truncated: text.length > maxChars };
}

export async function searchWebPage(
	searchUrl: string | undefined,
	apiKey: string | undefined,
	query: string,
	maxResults: number,
	timeoutMs: number,
	policy?: DriftWebPolicy,
	dnsLookupFn?: DriftWebDnsLookupFn,
): Promise<DriftWebSearchItem[]> {
	if (!searchUrl) throw new Error("web_search is not configured");
	if (!isHttpUrl(searchUrl)) throw new Error("webSearchUrl must be an http(s) URL");
	const urlError = validateWebUrl(searchUrl, policy);
	if (urlError) throw new Error(urlError);
	const endpoint = new URL(searchUrl);
	endpoint.searchParams.set("q", query);
	endpoint.searchParams.set("count", String(maxResults));
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
		headers["X-Subscription-Token"] = apiKey;
	}
	const response = await requestWebResponse(endpoint.toString(), headers, timeoutMs, policy, dnsLookupFn, 2_000_000);
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(`web_search http ${response.statusCode}`);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(response.body) as unknown;
	} catch {
		throw new Error("web_search returned invalid JSON");
	}
	return extractSearchItems(payload, maxResults);
}

interface PinnedWebResponse {
	statusCode: number;
	headers: Record<string, string | undefined>;
	body: string;
}

const WEB_REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export async function requestWebResponse(
	url: string,
	headers: Record<string, string>,
	timeoutMs: number,
	policy: DriftWebPolicy | undefined,
	dnsLookupFn: DriftWebDnsLookupFn | undefined,
	maxBodyBytes: number,
): Promise<PinnedWebResponse> {
	let currentUrl = url;
	const maxRedirectHops = Math.max(0, Math.min(5, Math.trunc(policy?.maxRedirectHops ?? 0)));
	for (let hop = 0; ; hop++) {
		const urlError = validateWebUrl(currentUrl, policy);
		if (urlError) throw new Error(urlError);
		const response = await requestPinnedAddress(currentUrl, headers, timeoutMs, policy, dnsLookupFn, maxBodyBytes);
		if (!WEB_REDIRECT_STATUS_CODES.has(response.statusCode)) return response;
		if (hop >= maxRedirectHops) throw new Error(`web redirect blocked after ${hop} validated hop(s)`);
		const location = response.headers.location;
		if (!location) throw new Error("web redirect missing Location header");
		const next = new URL(location, currentUrl);
		if (!isHttpUrl(next.toString())) throw new Error("web redirect target must be an http(s) URL");
		currentUrl = next.toString();
	}
}

export async function validateResolvedWebUrl(
	value: string,
	policy: DriftWebPolicy | undefined,
	dnsLookupFn: DriftWebDnsLookupFn,
): Promise<string | null> {
	const urlError = validateWebUrl(value, policy);
	if (urlError) return urlError;
	if (policy?.allowPrivateNetwork) return null;
	try {
		const hostname = new URL(value).hostname.replace(/^\[|\]$/g, "");
		const addresses = await resolveWebAddresses(hostname, dnsLookupFn);
		if (addresses.length === 0) return "web host did not resolve to an address";
		if (addresses.some((entry) => isPrivateNetworkHost(entry.address))) {
			return `private or local web address is blocked for host: ${hostname}`;
		}
		return null;
	} catch (error) {
		return `web DNS resolution failed: ${formatWebError(error)}`;
	}
}

export async function resolveWebAddresses(
	hostname: string,
	dnsLookupFn?: DriftWebDnsLookupFn,
): Promise<DriftWebResolvedAddress[]> {
	hostname = hostname.replace(/^\[|\]$/g, "");
	const addresses = dnsLookupFn
		? await dnsLookupFn(hostname)
		: await dnsLookup(hostname, { all: true, verbatim: true });
	return addresses.flatMap((entry) => {
		const address = String(entry.address ?? "").trim();
		const family = entry.family === 6 ? 6 : entry.family === 4 ? 4 : undefined;
		return address && family ? [{ address, family }] : [];
	});
}

async function requestPinnedAddress(
	url: string,
	headers: Record<string, string>,
	timeoutMs: number,
	policy: DriftWebPolicy | undefined,
	dnsLookupFn: DriftWebDnsLookupFn | undefined,
	maxBodyBytes: number,
): Promise<PinnedWebResponse> {
	const parsed = new URL(url);
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
	const urlError = validateWebUrl(url, policy);
	if (urlError) throw new Error(urlError);
	const addresses = parseLiteralAddress(hostname)
		? [{ address: hostname, family: hostname.includes(":") ? (6 as const) : (4 as const) }]
		: await resolveWebAddresses(hostname, dnsLookupFn);
	if (addresses.length === 0) throw new Error(`web host did not resolve: ${hostname}`);
	if (!(policy?.allowPrivateNetwork ?? false) && addresses.some((entry) => isPrivateNetworkHost(entry.address))) {
		throw new Error(`private or local web address is blocked for host: ${hostname}`);
	}

	let lastError: unknown;
	for (const address of addresses) {
		try {
			return await requestOnePinnedAddress(parsed, address, headers, timeoutMs, maxBodyBytes);
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(`web request failed for ${hostname}: ${formatWebError(lastError)}`);
}

function requestOnePinnedAddress(
	url: URL,
	address: DriftWebResolvedAddress,
	headers: Record<string, string>,
	timeoutMs: number,
	maxBodyBytes: number,
): Promise<PinnedWebResponse> {
	return new Promise((resolvePromise, reject) => {
		const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
		const request = requestFn(
			{
				hostname: address.address,
				port: url.port || undefined,
				path: `${url.pathname}${url.search}`,
				method: "GET",
				headers: { ...headers, Host: url.host },
				family: address.family,
				servername: url.protocol === "https:" ? url.hostname.replace(/^\[|\]$/g, "") : undefined,
			},
			(response) => {
				const chunks: Buffer[] = [];
				let bytes = 0;
				response.on("data", (chunk: Buffer | string) => {
					const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					bytes += buffer.byteLength;
					if (bytes > maxBodyBytes) {
						request.destroy(new Error("web response exceeded the size limit"));
						return;
					}
					chunks.push(buffer);
				});
				response.once("error", reject);
				response.once("end", () => {
					const normalizedHeaders: Record<string, string | undefined> = {};
					for (const [key, value] of Object.entries(response.headers)) {
						normalizedHeaders[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
					}
					resolvePromise({
						statusCode: response.statusCode ?? 0,
						headers: normalizedHeaders,
						body: Buffer.concat(chunks).toString("utf-8"),
					});
				});
			},
		);
		const timer = setTimeout(() => request.destroy(new Error("web request timed out")), timeoutMs);
		request.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		request.once("close", () => clearTimeout(timer));
		request.end();
	});
}

function parseLiteralAddress(hostname: string): boolean {
	return Boolean(parseIpv4(hostname) || hostname.includes(":"));
}

function extractSearchItems(payload: unknown, maxResults: number): DriftWebSearchItem[] {
	const root = asObject(payload);
	const web = asObject(root?.web);
	const candidates = [root?.results, root?.items, root?.organic_results, web?.results];
	for (const candidate of candidates) {
		if (!Array.isArray(candidate)) continue;
		const results = candidate.flatMap((item) => {
			const record = asObject(item);
			if (!record) return [];
			const title = firstString(record.title, record.name);
			const url = firstString(record.url, record.link);
			const snippet = firstString(record.snippet, record.description, record.content);
			return title && url ? [{ title, url, snippet }] : [];
		});
		if (results.length > 0) return results.slice(0, maxResults);
	}
	return [];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function firstString(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

export function webHtmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.trim();
}
