/**
 * 公共出站媒体管线。
 *
 * 所有渠道共用一套媒体语义:
 * - `media: string[]`(URL / 本地路径 / data URL)与
 *   `attachments: ChannelAttachment[]`(结构化)在发送前统一归一化;
 * - 媒体按扩展名推断 kind(image/audio/video/file),供渠道选择发送 API;
 * - `resolveOutboundMedia()` 把 source 解析为字节:data URL 解码、
 *   HTTP(S) 下载(带大小上限)、本地文件读取。
 *
 * 渠道通过 `BaseChannel.collectOutboundMedia()` 获取归一化媒体列表,并
 * 用 `mediaCapabilities` 声明支持的 kind —— 不支持的媒体显式抛错,
 * 绝不静默丢弃。
 */

import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { AttachmentKind, ChannelAttachment, OutboundMessage } from "./types.ts";

/** 渠道能接受/发送哪些媒体、以什么形式。 */
export interface ChannelMediaCapabilities {
	/** 支持的媒体类型;空数组表示渠道不支持任何媒体。 */
	kinds: AttachmentKind[];
	/** 平台是否接受 HTTP(S) URL 直传(渠道无需下载字节)。 */
	urlDirect: boolean;
	/** 平台媒体大小上限(字节)。 */
	maxBytes?: number;
}

/** 解析后的出站媒体字节。 */
export interface ResolvedOutboundMedia {
	data: Buffer;
	filename: string;
	mimeType: string;
}

export interface ResolveOutboundMediaOptions {
	/** 传输层覆盖(测试用)。 */
	fetchFn?: typeof fetch;
	/** 下载/读取大小上限(字节),默认 20MiB。 */
	maxBytes?: number;
}

const DEFAULT_MAX_MEDIA_BYTES = 20 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".heic"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus", ".amr"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v"]);

const EXTENSION_MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
	".heic": "image/heic",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".ogg": "audio/ogg",
	".flac": "audio/flac",
	".opus": "audio/opus",
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".avi": "video/x-msvideo",
	".mkv": "video/x-matroska",
	".webm": "video/webm",
	".3gp": "video/3gpp",
	".m4v": "video/x-m4v",
	".pdf": "application/pdf",
	".zip": "application/zip",
	".gz": "application/gzip",
	".txt": "text/plain",
	".md": "text/markdown",
	".json": "application/json",
	".csv": "text/csv",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt": "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** source 的类型:HTTP(S) URL / data URL / 本地路径。 */
export function mediaSourceKind(source: string): "url" | "data" | "file" {
	const trimmed = source.trim();
	if (trimmed.startsWith("data:")) return "data";
	if (/^https?:\/\//i.test(trimmed)) return "url";
	return "file";
}

export function isHttpUrl(source: string): boolean {
	return /^https?:\/\//i.test(source.trim());
}

/** 按文件魔数推断图片 mime;无法识别时返回 undefined。 */
export function sniffImageMime(buffer: Buffer): string | undefined {
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	if (
		buffer.length >= 8 &&
		buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	)
		return "image/png";
	if (buffer.length >= 3 && buffer.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
	if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "RIFF") return "image/webp";
	if (buffer.length >= 2 && buffer.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
	return undefined;
}

/** 按文件扩展名猜 mime;未知扩展名返回 fallback。 */
export function guessMimeType(filename: string, fallback = "application/octet-stream"): string {
	return EXTENSION_MIME_TYPES[extname(filename).toLowerCase()] ?? fallback;
}

/** 按文件扩展名猜媒体 kind;未知扩展名视为 file。 */
export function kindFromFilename(filename: string): AttachmentKind {
	const ext = extname(filename).toLowerCase();
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	if (AUDIO_EXTENSIONS.has(ext)) return "audio";
	if (VIDEO_EXTENSIONS.has(ext)) return "video";
	return "file";
}

/** 提取 source 中可作文件名的部分(URL 的 pathname 或本地路径)。 */
export function mediaFilename(source: string): string {
	const trimmed = source.trim();
	if (/^https?:\/\//i.test(trimmed)) {
		try {
			return basename(new URL(trimmed).pathname) || "attachment";
		} catch {
			return "attachment";
		}
	}
	return basename(trimmed) || "attachment";
}

/** 把失败的媒体列表拼成正文附注(nanobot 风格,失败不阻塞整体发送)。 */
export function withMediaFailureNote(content: string, failedMedia: readonly string[]): string {
	if (failedMedia.length === 0) return content;
	const note = failedMedia.map((name) => `[附件发送失败: ${name}]`).join("\n");
	return content ? `${content}\n\n${note}` : note;
}

/** 把裸 media 字符串归一化为结构化附件(kind 由扩展名推断)。 */
export function attachmentFromMediaSource(source: string): ChannelAttachment {
	const trimmed = source.trim();
	const filename = mediaFilename(trimmed);
	return {
		kind: kindFromFilename(filename),
		source: trimmed,
		filename,
		mimeType: guessMimeType(filename),
	};
}

/**
 * 把 OutboundMessage 的 `media`(裸字符串)与 `attachments`(结构化)合并为
 * 统一的附件列表。media 在前,attachments 在后;空字符串被跳过。
 */
export function collectOutboundMedia(message: OutboundMessage): ChannelAttachment[] {
	const result: ChannelAttachment[] = [];
	for (const source of message.media ?? []) {
		if (typeof source !== "string" || source.trim() === "") continue;
		result.push(attachmentFromMediaSource(source));
	}
	for (const attachment of message.attachments ?? []) {
		if (!attachment || attachment.source.trim() === "") continue;
		result.push(attachment);
	}
	return result;
}

/**
 * 把附件 source 解析为字节:data URL 解码、HTTP(S) 下载(限大小)、
 * 本地文件读取(限大小)。图片字节会用魔数修正 mime。
 */
export async function resolveOutboundMedia(
	attachment: ChannelAttachment,
	options: ResolveOutboundMediaOptions = {},
): Promise<ResolvedOutboundMedia> {
	const maxBytes = positiveBytes(options.maxBytes, DEFAULT_MAX_MEDIA_BYTES);
	const source = attachment.source.trim();
	if (!source) throw new Error("outbound media source is empty");
	const fallbackFilename = attachment.filename ?? mediaFilename(source);
	const fallbackMimeType = attachment.mimeType ?? guessMimeType(fallbackFilename);

	const kind = mediaSourceKind(source);
	if (kind === "data") {
		const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(source);
		if (!match) throw new Error("invalid media data URL");
		const data = match[2] ? Buffer.from(match[3]!, "base64") : Buffer.from(decodeURIComponent(match[3]!));
		if (data.length > maxBytes) throw new Error(`media exceeds size limit: ${data.length} bytes`);
		return {
			data,
			filename: fallbackFilename,
			mimeType: refineImageMime(data, match[1] ?? fallbackMimeType),
		};
	}

	if (kind === "url") {
		const fetchFn = options.fetchFn ?? fetch;
		const response = await fetchFn(source);
		if (!response.ok) throw new Error(`media download failed: ${response.status}`);
		const declared = Number(response.headers.get("content-length") ?? 0);
		if (declared > maxBytes) throw new Error(`media exceeds size limit: ${declared} bytes`);
		let data: Buffer;
		if (response.body) {
			const reader = response.body.getReader();
			const chunks: Buffer[] = [];
			let total = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > maxBytes) throw new Error(`media exceeds size limit: ${maxBytes} bytes`);
				chunks.push(Buffer.from(value));
			}
			data = Buffer.concat(chunks);
		} else {
			data = Buffer.from(await response.arrayBuffer());
		}
		if (data.length > maxBytes) throw new Error(`media exceeds size limit: ${data.length} bytes`);
		const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
		const filename = basename(new URL(source).pathname) || fallbackFilename;
		return {
			data,
			filename,
			mimeType: refineImageMime(data, contentType ?? fallbackMimeType),
		};
	}

	const fileStat = await stat(source);
	if (fileStat.size > maxBytes) throw new Error(`media exceeds size limit: ${fileStat.size} bytes`);
	const data = await readFile(source);
	return {
		data,
		filename: fallbackFilename,
		mimeType: refineImageMime(data, fallbackMimeType),
	};
}

/** 图片字节用魔数修正 mime(svg 等文本格式保持原值;未知类型也尝试嗅探)。 */
function refineImageMime(data: Buffer, candidate: string): string {
	if (candidate.includes("svg")) return candidate;
	if (!candidate.startsWith("image/") && candidate !== "application/octet-stream") return candidate;
	return sniffImageMime(data) ?? candidate;
}

function positiveBytes(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}
