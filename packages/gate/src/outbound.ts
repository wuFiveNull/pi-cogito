/**
 * 出站消息哈希(共享层)。
 *
 * proactive 与 drift 共用同一哈希规则来去重投递:相同文本/媒体/附件/
 * 目标渠道的消息产生相同 hash。类型定义也在这里,避免 drift 的附件类型
 * 泄漏进共享层之外。
 */

import { createHash } from "node:crypto";

export type DriftAttachmentKind = "file" | "image";

export interface DriftOutboundAttachment {
	kind: DriftAttachmentKind;
	source: string;
	filename?: string;
	mimeType?: string;
}

export function hashMessage(text: string): string {
	return createHash("sha256").update(text.trim()).digest("hex");
}

export function hashOutboundMessage(
	text: string,
	media: readonly string[],
	attachments: readonly DriftOutboundAttachment[],
	targetChannel: string,
	targetChatId: string,
): string {
	if (media.length === 0 && attachments.length === 0 && !targetChannel && !targetChatId) return hashMessage(text);
	return createHash("sha256")
		.update(
			JSON.stringify({
				message: text.trim(),
				media: [...media],
				attachments: attachments.map((attachment) => ({ ...attachment })),
				target_channel: targetChannel,
				target_chat_id: targetChatId,
			}),
		)
		.digest("hex");
}
