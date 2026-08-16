/**
 * [drift] 前缀的结构化日志(akashic logging.getLogger("[drift]") 对应)。
 *
 * 库内默认输出到 console;设置环境变量 DRIFT_LOG_LEVEL=silent 可关闭。
 */

const LEVEL = (process.env.DRIFT_LOG_LEVEL ?? "info").toLowerCase();

export function driftLog(level: "info" | "warn" | "error", event: string, detail?: Record<string, unknown>): void {
	if (LEVEL === "silent") return;
	const line = detail ? `${event} ${JSON.stringify(detail)}` : event;
	if (level === "error") {
		console.error(`[drift] ${line}`);
	} else if (level === "warn") {
		console.warn(`[drift] ${line}`);
	} else if (LEVEL !== "error" && LEVEL !== "warn") {
		console.log(`[drift] ${line}`);
	}
}
