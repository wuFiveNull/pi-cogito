export interface ChannelRateLimitConfig {
	/** Number of accepted events per window. */
	maxRequests?: number;
	/** Sliding window duration in milliseconds. */
	windowMs?: number;
}

/** Small bounded sliding-window limiter shared by channel adapters and HTTP. */
export class SlidingWindowRateLimiter {
	private readonly maxRequests: number;
	private readonly windowMs: number;
	private readonly buckets = new Map<string, number[]>();

	constructor(config: ChannelRateLimitConfig | undefined) {
		this.maxRequests = positiveLimit(config?.maxRequests, 0);
		this.windowMs = positiveLimit(config?.windowMs, 60_000);
	}

	allow(key: string, now = Date.now()): boolean {
		if (this.maxRequests === 0) return true;
		const current = this.buckets.get(key) ?? [];
		const cutoff = now - this.windowMs;
		const retained = current.filter((timestamp) => timestamp > cutoff);
		if (retained.length >= this.maxRequests) {
			this.buckets.set(key, retained);
			return false;
		}
		retained.push(now);
		this.buckets.set(key, retained);
		return true;
	}

	retryAfterMs(key: string, now = Date.now()): number | undefined {
		if (this.maxRequests === 0) return undefined;
		const current = this.buckets.get(key) ?? [];
		const cutoff = now - this.windowMs;
		const retained = current.filter((timestamp) => timestamp > cutoff);
		this.buckets.set(key, retained);
		if (retained.length < this.maxRequests || retained.length === 0) return undefined;
		return Math.max(1, retained[0]! + this.windowMs - now);
	}
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
