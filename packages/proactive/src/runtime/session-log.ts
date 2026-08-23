/**
 * 主动推送的会话历史写回(跨进程)。
 *
 * gateway 进程拥有 IM 通道与会话权威;proactive 进程投递成功后,把推送作为
 * assistant 消息追加到 sessionsDir 下对应 sessionKey 的 jsonl
 * (与 drift fetch_messages / sense 扫描兼容的
 * {"type":"message","message":{role,content,timestamp,proactive}} 格式),
 * 让 drift 回溯、presence 扫描与后续判断能看到"推过什么"。
 *
 * 追加采用 appendFileSync(单行 O_APPEND,多进程并发安全);失败仅记日志,
 * 不阻断已成功的投递(orchestrator 的 best-effort 语义)。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 会话文件名安全化:sessionKey 可能含 ":"(channel:chatId),禁止路径分隔符。 */
export function safeSessionFileName(sessionKey: string): string {
	const sanitized = sessionKey.replace(/[\\/]/g, "_").trim();
	return sanitized.length > 0 ? sanitized : "local";
}

/**
 * 追加一条主动推送 assistant 消息到会话 jsonl。
 * 返回 true 表示写入成功;目录缺失时自动创建。
 */
export function appendProactiveToSessionLog(options: {
	sessionsDir: string;
	sessionKey: string;
	content: string;
	timestamp: number;
	log?: (message: string) => void;
}): boolean {
	try {
		mkdirSync(options.sessionsDir, { recursive: true });
		const file = join(options.sessionsDir, `${safeSessionFileName(options.sessionKey)}.jsonl`);
		const entry = {
			type: "message",
			message: {
				role: "assistant",
				content: options.content,
				timestamp: new Date(options.timestamp).toISOString(),
				proactive: true,
			},
		};
		appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf-8");
		return true;
	} catch (error) {
		options.log?.(`session append failed: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}
