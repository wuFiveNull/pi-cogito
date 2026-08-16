/**
 * Markdown 记忆存储(akashic agent/memory.py + core/memory/markdown.py 移植)。
 *
 * 文件布局(workspace/memory/):
 * - MEMORY.md:稳定用户档案(optimizer 重写)
 * - PENDING.md:对话中提取的长期记忆候选(optimizer 消费)
 * - SELF.md:助手自我认知(仅三段)
 * - RECENT_CONTEXT.md:近期语境摘要
 * - PENDING.snapshot.md:两阶段提交的中间态(崩溃可回滚)
 * - consolidation_writes.db:append_pending_once 的幂等索引
 * - backups/:MEMORY/SELF 的历史版本(不可覆盖的恢复点)
 */

import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createSqliteDatabase, type SqliteDatabase } from "../sqlite.ts";

const CONSOLIDATION_MARKER_PREFIX = "<!-- consolidation:";
const CONSOLIDATION_MARKER_SUFFIX = " -->";
const CONSOLIDATION_TAIL_BYTES = 1024 * 1024;

export const DEFAULT_SELF_MD = `# 助手自我认知

## 人格与形象
- 我是你的长期协作伙伴,直接、温暖、主动参与思考。
- 我优先给出结论,再补充必要细节;不把自己伪装成没有立场的工具。

## 我对当前用户的理解
- 我会从长期记忆中逐步形成对当前用户的理解,不在缺少证据时编造画像。

## 我们关系的定义
- 我与当前用户的关系以透明、尊重边界和持续协作为基础。
`;

/** 原子写文本:同目录临时文件 + rename(akashic atomic_write_text)。 */
export function atomicWriteText(path: string, content: string): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, path);
}

export class MarkdownMemoryStore {
	readonly memoryDir: string;
	readonly memoryFile: string;
	readonly recentContextFile: string;
	readonly pendingFile: string;
	readonly selfFile: string;
	private readonly snapshotPath: string;
	private readonly consolidationDb: SqliteDatabase;

	constructor(workspaceDir: string) {
		this.memoryDir = join(workspaceDir, "memory");
		mkdirSync(this.memoryDir, { recursive: true });
		this.memoryFile = join(this.memoryDir, "MEMORY.md");
		this.recentContextFile = join(this.memoryDir, "RECENT_CONTEXT.md");
		this.pendingFile = join(this.memoryDir, "PENDING.md");
		this.selfFile = join(this.memoryDir, "SELF.md");
		this.snapshotPath = join(this.memoryDir, "PENDING.snapshot.md");
		// 确保 PENDING.md 常驻,避免首次运行时找不到文件。
		if (!existsSync(this.pendingFile)) writeFileSync(this.pendingFile, "", "utf-8");
		this.consolidationDb = createSqliteDatabase(join(this.memoryDir, "consolidation_writes.db"));
		this.consolidationDb.exec(
			`CREATE TABLE IF NOT EXISTS consolidation_writes (
				source_ref TEXT NOT NULL,
				kind TEXT NOT NULL,
				payload TEXT,
				trailing_blank_line INTEGER NOT NULL DEFAULT 0,
				done_at TEXT NOT NULL,
				PRIMARY KEY (source_ref, kind)
			)`,
		);
		// 崩溃恢复:启动时若遗留 snapshot,回滚合并。
		this.recoverPendingSnapshot();
	}

	close(): void {
		this.consolidationDb.close();
	}

	// ------------------------------------------------------------------
	// 长期记忆(MEMORY.md)
	// ------------------------------------------------------------------

	readLongTerm(): string {
		return existsSync(this.memoryFile) ? readFileSync(this.memoryFile, "utf-8") : "";
	}

	writeLongTerm(content: string): void {
		atomicWriteText(this.memoryFile, content);
	}

	// ------------------------------------------------------------------
	// 近期语境(RECENT_CONTEXT.md)
	// ------------------------------------------------------------------

	readRecentContext(): string {
		return existsSync(this.recentContextFile) ? readFileSync(this.recentContextFile, "utf-8") : "";
	}

	writeRecentContext(content: string): void {
		atomicWriteText(this.recentContextFile, content);
	}

	// ------------------------------------------------------------------
	// 自我认知(SELF.md)
	// ------------------------------------------------------------------

	readSelf(): string {
		return existsSync(this.selfFile) ? readFileSync(this.selfFile, "utf-8") : "";
	}

	writeSelf(content: string): void {
		atomicWriteText(this.selfFile, content);
	}

	// ------------------------------------------------------------------
	// 待处理事实(PENDING.md)
	// ------------------------------------------------------------------

	readPending(): string {
		if (!existsSync(this.pendingFile)) return "";
		return stripConsolidationMarkers(readFileSync(this.pendingFile, "utf-8"));
	}

	appendPending(facts: string): void {
		const text = facts.trim();
		if (!text) return;
		appendFileSync(this.pendingFile, `${rstrip(text)}\n`, "utf-8");
	}

	/**
	 * 按 source_ref 幂等追加 PENDING(akashic append_pending_once):
	 * marker 写进文件,SQLite 索引记账;崩溃后按索引恢复文件缺失段,
	 * 或按文件尾部扫描补索引,避免重启后重复 consolidation。
	 */
	appendPendingOnce(facts: string, options: { sourceRef: string; kind?: string }): boolean {
		const text = facts.trim();
		const src = options.sourceRef.trim();
		const kd = (options.kind ?? "pending").trim();
		if (!text || !src || !kd) return false;
		const marker = consolidationMarker(src, kd);

		const row = this.consolidationDb
			.prepare(`SELECT payload, trailing_blank_line FROM consolidation_writes WHERE source_ref = ? AND kind = ?`)
			.get(src, kd) as { payload: string | null; trailing_blank_line: number } | undefined;
		if (row !== undefined) {
			// 索引已记录但文件缺失 → 恢复文件段。
			if (!fileContainsMarker(this.pendingFile, marker)) {
				if (!row.payload) throw new Error("consolidation index payload is missing for file recovery");
				appendFileSync(this.pendingFile, `${marker}\n${rstrip(row.payload)}\n`, "utf-8");
				if (row.trailing_blank_line) appendFileSync(this.pendingFile, "\n", "utf-8");
			}
			return false;
		}
		// 崩溃发生在「文件已写,索引未写」→ 补索引并跳过重复写。
		if (tailContainsMarker(this.pendingFile, marker)) {
			this.consolidationDb
				.prepare(
					`INSERT OR REPLACE INTO consolidation_writes(source_ref, kind, payload, trailing_blank_line, done_at)
					 VALUES (?, ?, ?, ?, datetime('now'))`,
				)
				.run(src, kd, text, 0);
			return false;
		}
		// 正常路径:先写 marker + 内容,再提交索引。
		appendFileSync(this.pendingFile, `${marker}\n${rstrip(text)}\n`, "utf-8");
		this.consolidationDb
			.prepare(
				`INSERT OR REPLACE INTO consolidation_writes(source_ref, kind, payload, trailing_blank_line, done_at)
				 VALUES (?, ?, ?, ?, datetime('now'))`,
			)
			.run(src, kd, text, 0);
		return true;
	}

	clearPending(): void {
		atomicWriteText(this.pendingFile, "");
	}

	// ------------------------------------------------------------------
	// 两阶段提交(供 MemoryOptimizer 使用)
	// ------------------------------------------------------------------

	/** Phase-1:原子移走 PENDING.md,返回其内容。后续 append 写入全新文件,与快照隔离。 */
	snapshotPending(): string {
		this.recoverPendingSnapshot();
		if (!existsSync(this.pendingFile) || statSync(this.pendingFile).size === 0) return "";
		// POSIX rename 原子:rename 完成后新追加写入全新的 PENDING.md。
		renameSync(this.pendingFile, this.snapshotPath);
		return stripConsolidationMarkers(readFileSync(this.snapshotPath, "utf-8"));
	}

	/** Phase-2 成功:merge 完成,删除快照;PENDING.md 保持常驻。 */
	commitPendingSnapshot(): void {
		if (existsSync(this.snapshotPath)) unlinkSync(this.snapshotPath);
		if (!existsSync(this.pendingFile)) writeFileSync(this.pendingFile, "", "utf-8");
	}

	/** Phase-2 失败:快照(旧)在前,运行期新追加(新)在后,合并回 PENDING.md。 */
	rollbackPendingSnapshot(): void {
		if (!existsSync(this.snapshotPath)) return;
		const snapText = readFileSync(this.snapshotPath, "utf-8");
		const newText = existsSync(this.pendingFile) ? readFileSync(this.pendingFile, "utf-8") : "";
		const merged = newText.trim() ? `${rstrip(snapText)}\n${newText}` : snapText;
		atomicWriteText(this.pendingFile, merged);
		unlinkSync(this.snapshotPath);
	}

	/** 启动时或 snapshot 前调用:处理上次崩溃遗留的快照。 */
	recoverPendingSnapshot(): void {
		if (existsSync(this.snapshotPath)) this.rollbackPendingSnapshot();
	}

	getMemoryContext(): string {
		const longTerm = this.readLongTerm();
		return longTerm ? `## Long-term Memory\n${longTerm}` : "";
	}

	hasLongTermMemory(): boolean {
		return Boolean(this.readLongTerm().trim());
	}

	// ------------------------------------------------------------------
	// 备份(akashic core/memory/markdown.py _backup_profile)
	// ------------------------------------------------------------------

	backupLongTerm(): void {
		this.backupProfile(this.memoryFile, "MEMORY.bak.md");
	}

	backupSelf(): void {
		this.backupProfile(this.selfFile, "SELF.bak.md");
	}

	/** 原子保存最新备份 + 不可覆盖的历史版本(时间戳 + 纳秒)。 */
	private backupProfile(source: string, latestName: string): void {
		if (!existsSync(source)) return;
		const content = readFileSync(source, "utf-8");
		const now = new Date();
		const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
		const nanos = String(now.getMilliseconds() % 1_000_000_000).padStart(9, "0");
		const stem = basename(source, ".md");
		const historyPath = join(this.memoryDir, "backups", `${stem}.${timestamp}-${nanos}.bak.md`);
		atomicWriteText(historyPath, content);
		atomicWriteText(join(this.memoryDir, latestName), content);
	}
}

// ------------------------------------------------------------------
// 工具
// ------------------------------------------------------------------

function rstrip(text: string): string {
	return text.replace(/\s+$/, "");
}

function consolidationMarker(sourceRef: string, kind: string): string {
	const src = sourceRef.replace(/\n/g, " ").trim();
	const kd = kind.replace(/\n/g, " ").trim();
	return `${CONSOLIDATION_MARKER_PREFIX}${src}:${kd}${CONSOLIDATION_MARKER_SUFFIX}`;
}

function stripConsolidationMarkers(text: string): string {
	const kept = text
		.split("\n")
		.filter((line) => !(line.startsWith(CONSOLIDATION_MARKER_PREFIX) && line.endsWith(CONSOLIDATION_MARKER_SUFFIX)));
	return kept.join("\n").trim();
}

function tailContainsMarker(path: string, marker: string): boolean {
	if (!existsSync(path)) return false;
	const fd = openSync(path, "r");
	try {
		const size = statSync(path).size;
		const take = Math.min(size, CONSOLIDATION_TAIL_BYTES);
		if (take <= 0) return false;
		const buffer = Buffer.alloc(take);
		const read = readSync(fd, buffer, 0, take, size - take);
		return buffer.subarray(0, read).toString("utf-8").includes(marker);
	} finally {
		closeSync(fd);
	}
}

function fileContainsMarker(path: string, marker: string): boolean {
	if (!existsSync(path)) return false;
	const data = readFileSync(path, "utf-8");
	return data.includes(marker);
}
