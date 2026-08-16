import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { ChannelAttachmentStore, ChannelStoredAttachment } from "./channels/context.ts";

export interface FileAttachmentStoreOptions {
	maxBytes?: number;
}

/** Secure local attachment store with bounded, atomic writes. */
export class FileAttachmentStore implements ChannelAttachmentStore {
	readonly root: string;
	private readonly maxBytes: number;

	constructor(root: string, options: FileAttachmentStoreOptions = {}) {
		this.root = resolve(root);
		this.maxBytes = positiveLimit(options.maxBytes, 50 * 1024 * 1024);
	}

	save(data: Uint8Array, options: { filename: string; mimeType?: string }): ChannelStoredAttachment {
		if (data.byteLength > this.maxBytes) {
			throw new Error(`attachment exceeds ${this.maxBytes} byte limit`);
		}
		const root = this.ensureRoot();
		const filename = safeFilename(options.filename);
		const suffix = extname(filename) || extensionForMime(options.mimeType) || ".bin";
		const id = `attachment-${randomUUID()}${suffix}`;
		const staging = join(root, `.${id}.part`);
		let descriptor: number | undefined;
		try {
			descriptor = openSync(staging, "wx", 0o600);
			writeSync(descriptor, data);
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			renameSync(staging, join(root, id));
		} catch (error) {
			if (descriptor !== undefined) closeSync(descriptor);
			try {
				unlinkSync(staging);
			} catch {
				// Preserve the original write error.
			}
			throw error;
		}
		return { id, path: join(root, id), filename, mimeType: options.mimeType, sizeBytes: data.byteLength };
	}

	resolve(id: string): string | undefined {
		if (!/^[a-zA-Z0-9._-]+$/.test(id) || id.includes("..")) return undefined;
		const path = join(this.root, id);
		try {
			const stat = lstatSync(path);
			if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
			return path;
		} catch {
			return undefined;
		}
	}

	read(id: string): Buffer | undefined {
		const path = this.resolve(id);
		return path ? readFileSync(path) : undefined;
	}

	private ensureRoot(): string {
		if (existsAsSymlink(this.root)) throw new Error(`attachment root cannot be a symbolic link: ${this.root}`);
		mkdirSync(this.root, { recursive: true });
		if (existsAsSymlink(this.root)) throw new Error(`attachment root cannot be a symbolic link: ${this.root}`);
		return this.root;
	}
}

function safeFilename(filename: string): string {
	const value = basename(filename)
		.trim()
		.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
	return value || "attachment.bin";
}

function extensionForMime(mimeType: string | undefined): string | undefined {
	if (!mimeType) return undefined;
	const normalized = mimeType.toLowerCase();
	if (normalized === "image/png") return ".png";
	if (normalized === "image/jpeg") return ".jpg";
	if (normalized === "image/gif") return ".gif";
	if (normalized === "application/pdf") return ".pdf";
	if (normalized === "text/plain") return ".txt";
	return undefined;
}

function existsAsSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}
