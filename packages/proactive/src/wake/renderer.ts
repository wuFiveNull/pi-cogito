/**
 * Wake 消息渲染(akashic plugins/wake_proactive/renderer.py port)。
 */

import { contentEventMap, eventItemId, type WakeContext, type WakeEvent } from "./types.ts";

export interface RenderedShare {
	message: string;
	evidence: string[];
	displayEventMap: Record<number, string>;
	sourceRefs: Array<Record<string, unknown>>;
}

export function renderShare(options: {
	message?: string;
	opening: string;
	items: Array<Record<string, string>>;
	closing: string;
	events: WakeEvent[];
}): RenderedShare {
	const { message: rawMessage = "", opening, items, closing, events } = options;
	const eventMap = contentEventMap(events);
	const blocks: string[] = [];
	const message = rawMessage.trim();
	const openingTrimmed = opening.trim();
	const closingTrimmed = closing.trim();
	if (message) blocks.push(message);
	else if (openingTrimmed) blocks.push(openingTrimmed);

	const evidence: string[] = [];
	const displayEventMap: Record<number, string> = {};
	const sourceRefs: Array<Record<string, unknown>> = [];
	for (const [index, item] of items.entries()) {
		const itemId = String(item.item_id ?? "").trim();
		const event = eventMap[itemId];
		if (!event) continue;
		const title = String(event.title ?? "这条内容").trim();
		const summary = String(item.summary ?? "").trim();
		const why = String(item.why_it_matters ?? "").trim();
		const url = String(event.url ?? "").trim();
		const source = String(event.source ?? event.source_name ?? "").trim();
		const ackSourceId = String(event._reservoir_ack_source_id ?? event.ackSourceId ?? event.ack_server ?? "").trim();
		const sourceEventId = String(event._reservoir_source_event_id ?? event.eventId ?? event.id ?? itemId).trim();

		if (!message) {
			const heading = items.length === 1 ? summary : `${index + 1}. ${summary}`;
			const lines = [heading];
			if (why) lines.push(why);
			blocks.push(lines.filter(Boolean).join("\n"));
		}

		evidence.push(itemId);
		displayEventMap[index + 1] = itemId;
		const sourceRef: Record<string, unknown> = {
			id: itemId,
			display_index: index + 1,
			event_id: itemId,
			source_name: source,
			title,
			url,
		};
		if (ackSourceId) {
			sourceRef.ack_source_id = ackSourceId;
			sourceRef.source_event_id = sourceEventId;
		}
		sourceRefs.push(sourceRef);
	}

	const urls = items
		.map((item) => {
			const event = eventMap[String(item.item_id ?? "").trim()];
			return event ? String(event.url ?? "").trim() : "";
		})
		.filter((url) => url)
		.map((url, index) => `${index + 1}. ${url}`);
	if (urls.length > 0) {
		blocks.push(urls.length === 1 ? `来源：${urls[0]!.replace(/^1\. /, "")}` : `来源：\n${urls.join("\n")}`);
	}
	if (closingTrimmed && !message) blocks.push(closingTrimmed);

	return { message: blocks.join("\n\n"), evidence, displayEventMap, sourceRefs };
}

/** 便捷:按 WakeContext 渲染(供 tools 使用)。 */
export function renderShareForContext(
	ctx: WakeContext,
	options: { message?: string; opening: string; items: Array<Record<string, string>>; closing: string },
): RenderedShare {
	return renderShare({ ...options, events: ctx.contentEvents });
}

export { eventItemId };
