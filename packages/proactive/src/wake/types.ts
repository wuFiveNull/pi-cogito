/**
 * Wake 生命周期核心类型(akashic plugins/wake_proactive/context.py port)。
 */

/** 蓄水池事件:由数据源产生,按 kind 分桶(akashic alert/content/context channels)。 */
export interface WakeEvent {
	/** alert | content | context;缺省按 content 处理。 */
	kind?: "alert" | "content" | "context";
	/** 原始来源 id(akashic original_source_id)。 */
	sourceId?: string;
	/** ack 服务器 id(akashic ack_server);ack 按它分组。 */
	ackSourceId?: string;
	/** 来源侧事件 id(akashic source_event_id)。 */
	eventId?: string;
	/** 时间戳(ISO 字符串或 ms/秒数值);缺省时用 first_seen_at。 */
	publishedAt?: string | number;
	/** 预筛分数 [0,1];缺省 0。 */
	preprocessScore?: number;
	title?: string;
	url?: string;
	summary?: string;
	content?: string;
	body?: string;
	/** 显式不可唤醒标记(akashic wake_eligible=false)。 */
	wakeEligible?: boolean;
	[extra: string]: unknown;
}

export type InitialInterest = "likely_interesting" | "not_interesting" | "uncertain";

export interface ScratchItem {
	itemId: string;
	initialInterest: InitialInterest;
	question: string;
}

export interface PreferenceProbe {
	candidateIds: string[];
	topic: string;
	query: string;
}

export interface WakeContext {
	wakeId: string;
	nowUtc: Date;
	sessionKey: string;
	contentEvents: WakeEvent[];
	contentBacklogCount: number;
	scratchpad: Record<string, ScratchItem>;
	preferenceProbe: PreferenceProbe | null;
	screeningCompleted: boolean;
	investigationResults: Record<string, Record<string, unknown>>;
	preferenceEvidence: Record<string, unknown>;
	investigationCompleted: boolean;
	finalMessage: string;
	citedItemIds: string[];
	displayEventMap: Record<number, string>;
	sourceRefs: Array<Record<string, unknown>>;
	terminalAction: "reply" | "skip" | null;
	stepsTaken: number;
}

export function newWakeContext(sessionKey: string, now: Date, wakeId = randomWakeId()): WakeContext {
	return {
		wakeId,
		nowUtc: now,
		sessionKey,
		contentEvents: [],
		contentBacklogCount: 0,
		scratchpad: {},
		preferenceProbe: null,
		screeningCompleted: false,
		investigationResults: {},
		preferenceEvidence: {},
		investigationCompleted: false,
		finalMessage: "",
		citedItemIds: [],
		displayEventMap: {},
		sourceRefs: [],
		terminalAction: null,
		stepsTaken: 0,
	};
}

function randomWakeId(): string {
	return [...cryptoRandomBytes(8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cryptoRandomBytes(n: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(n));
}

/** 蓄水池 canonical id(akashic event_item_id)。 */
export function eventItemId(event: WakeEvent): string {
	const itemId = String(event.item_id ?? event.id ?? "").trim();
	const ackServer = String(event.ack_server ?? "").trim();
	if (ackServer && itemId && !itemId.includes(":")) return `${ackServer}:${itemId}`;
	return itemId || String(event.eventId ?? "").trim();
}

/** 为本轮内容候选分配只在当前 wake 内有效的模型引用 candidate_N。 */
export function contentCandidateMap(ctx: WakeContext): Record<string, WakeEvent> {
	const map: Record<string, WakeEvent> = {};
	for (const [index, event] of ctx.contentEvents.entries()) {
		map[`candidate_${index + 1}`] = event;
	}
	return map;
}

/** 按蓄水池 canonical id 索引已验证的内部事件。 */
export function contentEventMap(events: WakeEvent[]): Record<string, WakeEvent> {
	const map: Record<string, WakeEvent> = {};
	for (const event of events) {
		map[eventItemId(event)] = event;
	}
	return map;
}
