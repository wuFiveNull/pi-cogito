/**
 * DailyHot source.
 *
 * Fetches hot lists directly from the DailyHotApi route modules (same
 * mechanism as the pi-cogito dailyhot extension). Each configured platform
 * route is imported and its handleRoute invoked; results are normalized to
 * RawItem.
 *
 * Config (from proactive.json sources.dailyhot):
 * {
 *   "platforms": ["weibo", "zhihu", "github", ...],
 *   "routesDir": "/home/wu/projects/DailyHotApi/src/routes",
 *   "limit": 20
 * }
 */

import { createHash } from "node:crypto";
import type { ProactiveSource, SourceFetchDiagnostics, WakeEvent } from "../types.ts";

export interface DailyhotSourceConfig {
	platforms?: string[];
	routesDir?: string;
	limit?: number;
}

const DEFAULT_ROUTES_DIR = "/home/wu/projects/DailyHotApi/src/routes";
const DEFAULT_PLATFORMS = ["weibo", "zhihu", "github"];

interface DailyHotItem {
	title: string;
	url?: string;
	desc?: string;
	timestamp?: number;
}

interface DailyHotRouteResult {
	data: DailyHotItem[];
}

export default class DailyhotSource implements ProactiveSource {
	id = "dailyhot";
	label = "DailyHot 热榜";
	defaultIntervalMs = 30 * 60 * 1000;
	configSchema = { platforms: ["string"], routesDir: "string", limit: "number" };
	channels = ["content"] as const;
	private lastDiagnostics: SourceFetchDiagnostics = { attempted: 0, succeeded: 0, failed: 0 };

	async fetch(config: unknown): Promise<WakeEvent[]> {
		const cfg = (config ?? {}) as DailyhotSourceConfig;
		const routesDir = cfg.routesDir ?? DEFAULT_ROUTES_DIR;
		const platforms = cfg.platforms ?? DEFAULT_PLATFORMS;
		const limit = cfg.limit ?? 20;

		const items: WakeEvent[] = [];
		let succeeded = 0;
		let failed = 0;
		for (const platform of platforms) {
			try {
				const mod = (await import(`${routesDir}/${platform}.ts`)) as {
					handleRoute?: (
						ctx: { req: { query: (name: string) => string | undefined } },
						noCache: boolean,
					) => Promise<DailyHotRouteResult>;
				};
				if (!mod.handleRoute) throw new Error("route missing handleRoute");
				const result = await mod.handleRoute({ req: { query: () => undefined } }, false);
				succeeded++;
				for (const item of result.data.slice(0, limit)) {
					items.push({
						kind: "content",
						source: platform,
						eventId: dailyHotEventId(platform, item),
						preprocessScore: 0,
						title: item.title,
						url: item.url,
						summary: item.desc,
						publishedAt: item.timestamp,
					});
				}
			} catch (error) {
				failed++;
				// One platform failure must not drop the others.
				console.error(`proactive DailyHot platform failed platform=${platform}: ${formatError(error)}`);
			}
		}
		this.lastDiagnostics = { attempted: platforms.length, succeeded, failed };
		if (platforms.length > 0 && succeeded === 0) {
			throw new Error(`all DailyHot platforms failed (${platforms.join(",")})`);
		}
		return items;
	}

	fetchDiagnostics(): SourceFetchDiagnostics {
		return { ...this.lastDiagnostics };
	}
}

function dailyHotEventId(platform: string, item: DailyHotItem): string {
	const identity = item.url?.trim() || item.title.trim().toLowerCase();
	if (identity) return `${platform}:${identity}`;
	return `${platform}:item-${createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 16)}`;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
