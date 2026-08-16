import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export interface ChannelAuthConfig {
	/** Shared secret accepted by the configured header or query parameter. */
	token?: string;
	/** Header name. Defaults to Authorization. */
	header?: string;
	/** Optional query parameter, useful for SSE/WebSocket clients. */
	queryParam?: string;
	/** Optional HMAC authentication for signed HTTP webhook bodies. */
	signature?: ChannelSignatureConfig;
}

export interface ChannelSignatureConfig {
	secret: string;
	header?: string;
	timestampHeader?: string;
	maxAgeMs?: number;
}

export function isAuthorizedRequest(
	auth: ChannelAuthConfig | undefined,
	headers: IncomingHttpHeaders,
	url: URL,
): boolean {
	const expected = auth?.token;
	if (!expected) return !auth?.signature;
	const headerName = (auth.header ?? "authorization").toLowerCase();
	const rawHeader = headers[headerName];
	const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
	const candidates = [
		headerValue,
		(auth.header ?? "authorization").toLowerCase() === "authorization" ? bearerToken(headerValue) : undefined,
		auth.queryParam ? (url.searchParams.get(auth.queryParam) ?? undefined) : undefined,
	];
	return candidates.some((candidate) => typeof candidate === "string" && secureEqual(candidate, expected));
}

export function verifyBodySignature(
	auth: ChannelAuthConfig | undefined,
	headers: IncomingHttpHeaders,
	body: string,
	now = Date.now(),
): boolean {
	const signature = auth?.signature;
	if (!signature?.secret) return false;
	const signatureHeader = firstHeader(headers, signature.header ?? "x-webhook-signature");
	if (!signatureHeader) return false;
	const timestampHeader = signature.timestampHeader;
	const timestamp = timestampHeader ? firstHeader(headers, timestampHeader) : undefined;
	if (timestampHeader && !timestamp) return false;
	if (timestamp) {
		const parsed = Number(timestamp);
		const timestampMs = parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
		const maxAgeMs = positiveNumber(signature.maxAgeMs, 5 * 60_000);
		if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > maxAgeMs) return false;
	}
	const payload = timestamp ? `${timestamp}.${body}` : body;
	const digest = createHmac("sha256", signature.secret).update(payload).digest("hex");
	const candidate = signatureHeader.replace(/^sha256=/i, "").trim();
	return secureEqual(candidate, digest);
}

function bearerToken(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(value.trim());
	return match?.[1];
}

function firstHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
	const raw = headers[name.toLowerCase()];
	return Array.isArray(raw) ? raw[0] : raw;
}

function secureEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function positiveNumber(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
