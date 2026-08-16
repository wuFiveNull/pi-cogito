import type { ChannelInterruptControllerLike, ChannelInterruptRequest, ChannelInterruptResult } from "./context.ts";

/** Coordinates channel stop requests with currently running agent turns. */
export class ChannelInterruptController implements ChannelInterruptControllerLike {
	private readonly active = new Map<string, AbortController>();
	private readonly interrupted = new Set<string>();

	register(sessionKey: string, controller: AbortController): () => void {
		this.active.set(sessionKey, controller);
		this.interrupted.delete(sessionKey);
		return () => {
			if (this.active.get(sessionKey) !== controller) return;
			this.active.delete(sessionKey);
			this.interrupted.delete(sessionKey);
		};
	}

	requestInterrupt(request: ChannelInterruptRequest): ChannelInterruptResult {
		const controller = this.active.get(request.sessionKey);
		if (!controller) {
			return {
				status: this.interrupted.has(request.sessionKey) ? "already_interrupted" : "not_found",
				sessionKey: request.sessionKey,
				message: this.interrupted.has(request.sessionKey) ? "该会话已经请求中断" : "该会话当前没有运行中的 turn",
			};
		}
		if (controller.signal.aborted) {
			this.interrupted.add(request.sessionKey);
			return {
				status: "already_interrupted",
				sessionKey: request.sessionKey,
				message: "该会话已经请求中断",
			};
		}
		this.interrupted.add(request.sessionKey);
		controller.abort(request.reason ?? "channel requested interrupt");
		return {
			status: "interrupted",
			sessionKey: request.sessionKey,
			message: "已请求中断当前 turn",
		};
	}
}
