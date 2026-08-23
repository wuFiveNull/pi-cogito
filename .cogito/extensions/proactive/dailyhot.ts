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

/**
 * 主动推送数据源示例(放在 ~/.cogito/agent/extensions/proactive/ 下)。
 * 自包含:不依赖 proactive-pusher 内部类型。
 */

/** 数据源产出的一条候选内容。 */
interface RawItem {
	/** 子源 id,如 "weibo"、"zhihu"。 */
	source: string;
	title: string;
	url?: string;
	summary?: string;
	publishedAt?: number;
	/** 兴趣分 [0,1],wake 用;有 hot 按热度归一化,否则按位次递减。 */
	preprocessScore?: number;
}

/** 主动推送数据源接口:一个模块 = 一个源(default export class)。 */
interface ProactiveSource {
	/** 唯一源 id,proactive.json 配置里用它做 key。 */
	id: string;
	label: string;
	defaultIntervalMs?: number;
	configSchema?: unknown;
	/** 抓取候选内容,不得抛异常,失败返回 []。 */
	fetch(config: unknown): Promise<RawItem[]>;
}

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

	async fetch(config: unknown): Promise<RawItem[]> {
		const cfg = (config ?? {}) as DailyhotSourceConfig;
		const routesDir = cfg.routesDir ?? DEFAULT_ROUTES_DIR;
		const platforms = cfg.platforms ?? DEFAULT_PLATFORMS;
		const limit = cfg.limit ?? 20;

		const items: RawItem[] = [];
		for (const platform of platforms) {
			try {
				const mod = (await import(`${routesDir}/${platform}.ts`)) as {
					handleRoute?: (
						ctx: { req: { query: (name: string) => string | undefined } },
						noCache: boolean,
					) => Promise<DailyHotRouteResult>;
				};
				if (!mod.handleRoute) continue;
				const result = await mod.handleRoute({ req: { query: () => undefined } }, false);
				result.data.slice(0, limit).forEach((item, index) => {
					items.push({
						source: platform,
						title: item.title,
						url: item.url,
						summary: item.desc,
						publishedAt: item.timestamp,
						preprocessScore: scoreFor(item.hot, index),
					});
				});
			} catch {
				// One platform failure must not drop the others.
			}
		}
		return items;
	}

	/** 兴趣分:有 hot(热度值)按对数归一化,否则按位次递减(0.9 起每名 -0.08)。 */
	private scoreFor(hot: number | undefined, index: number): number {
		if (typeof hot === "number" && Number.isFinite(hot) && hot > 0) {
			return Math.min(0.95, Math.max(0.05, 0.25 + Math.log10(1 + hot) / 10));
		}
		return Math.max(0.05, 0.9 - index * 0.08);
	}
}
