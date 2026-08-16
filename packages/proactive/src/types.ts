/**
 * Proactive push — types.
 */

import type { WakeEvent } from "./wake/types.ts";

export type { WakeEvent } from "./wake/types.ts";
export type WakeChannel = NonNullable<WakeEvent["kind"]>;

export interface SourceFetchDiagnostics {
	attempted: number;
	succeeded: number;
	failed: number;
}

/** Durable source state shared by polling and wake lifecycles. */
export interface ProactiveSourceStateStore {
	getState(key: string): string | undefined;
	setState(key: string, value: string): void;
}

/** A source may return event batches or one context snapshot. */
export type SourceFetchResult = WakeEvent[] | Record<string, unknown>;

/** One candidate item produced by a data source (wake 事件的 content 子集)。 */
export interface RawItem {
	/** Sub-source id, e.g. "weibo", "zhihu", "github-issues", "exa". */
	source: string;
	title: string;
	url?: string;
	summary?: string;
	publishedAt?: number;
	// 索引签名保证旧式 RawItem 返回值的源模块仍可赋值给 WakeEvent(ProactiveSource.fetch)。
	[key: string]: unknown;
}

/**
 * A proactive data source. One module = one source (default export class).
 * 返回 WakeEvent:wake 生命周期按 kind 分桶(alert/content/context),并需要
 * eventId/ackSourceId 身份;default 生命周期只用 content 子集字段。
 */
export interface ProactiveSource {
	/** Unique source id, used as the key in proactive.json config. */
	id: string;
	label: string;
	/** Default fetch interval; overridable per-source in proactive.json. */
	defaultIntervalMs?: number;
	/** Declarative shape of the accepted config (informational/validation). */
	configSchema?: unknown;
	/** Declared wake channels. Presence enables strict source item validation. */
	channels?: readonly WakeChannel[];
	/** Fetch candidate items. Upstream failures must reject; the scheduler records them. */
	fetch(config: unknown): Promise<SourceFetchResult>;
	/** Optional low-level report for partial-success health reporting. */
	fetchDiagnostics?(): SourceFetchDiagnostics | undefined;
	/** Attach the host state store after source discovery. */
	setStateStore?(store: ProactiveSourceStateStore): void;
	/** Commit state staged by the last successful fetch. */
	commitFetchState?(): void;
	/** 可选:向来源确认事件消费(wake 生命周期使用;缺省不 ack)。 */
	ack?(config: unknown, eventIds: string[]): Promise<void>;
	/** 可选:ack 服务 id 到本 source 模块的显式映射。 */
	ackSourceIds?: readonly string[];
	/** Release long-lived connections when the host stops the pusher. */
	close?(): void | Promise<void>;
}
