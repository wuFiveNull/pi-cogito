import { readdirSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@cogito/host";

/**
 * DailyHot 热榜 —— 全部路由动态加载。
 * 数据源来自 /home/wu/projects/DailyHotApi/src/routes/，
 * 新增路由文件自动被发现，无需维护 import 列表。
 */

const ROUTES_DIR = "/home/wu/projects/DailyHotApi/src/routes";

/** 白名单：从路由目录读取全部 .ts 文件名（不含扩展名） */
const KNOWN_SOURCES: string[] = (() => {
	try {
		return readdirSync(ROUTES_DIR)
			.filter((f) => f.endsWith(".ts"))
			.map((f) => f.slice(0, -3))
			.sort();
	} catch {
		return [];
	}
})();

const COMMON_SOURCES = [
	"weibo", "bilibili", "zhihu", "baidu", "douyin", "juejin", "36kr",
	"v2ex", "hackernews", "producthunt", "github", "history", "ithome",
	"hupu", "sspai", "nodeseek", "linuxdo", "douban-movie", "huxiu", "coolapk",
].join(" / ");

interface HotItem {
	id: number | string;
	title: string;
	cover?: string;
	author?: string;
	desc?: string;
	hot: number | undefined;
	timestamp: number | undefined;
	url: string;
	mobileUrl: string;
}

interface RouteResult {
	name: string;
	title: string;
	type: string;
	description?: string;
	total: number;
	updateTime: string | number;
	fromCache: boolean;
	data: HotItem[];
}

type RouteFn = (
	ctx: { req: { query: (name: string) => string | undefined } },
	noCache: boolean,
) => Promise<RouteResult>;

const formatHot = (hot: number | undefined): string => {
	if (hot === undefined || hot === null) return "";
	if (hot >= 10000) return ` 🔥${(hot / 10000).toFixed(1)}万`;
	return ` 🔥${hot}`;
};

const toMarkdown = (result: RouteResult, limit: number): string => {
	const items = result.data.slice(0, limit);
	const lines = items.map((item, i) => {
		const author = item.author ? ` (${item.author})` : "";
		return `${i + 1}. ${item.title}${author}${formatHot(item.hot)}\n   ${item.url}`;
	});
	const header = `## ${result.title} ${result.type}\n来源: ${result.name} | 共 ${result.total} 条 | 更新于 ${result.updateTime}`;
	return [header, ...lines].join("\n");
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "dailyhot",
		label: "DailyHot 热榜",
		description:
			`获取各大平台的热搜/热榜数据。常用 source: ${COMMON_SOURCES}。` +
			`共 ${KNOWN_SOURCES.length} 个数据源，任意 source 用 mcp({search}) 或直接尝试。` +
			"github 支持 type=daily|weekly|monthly；history 支持 month/day；其余可选参数见各源。limit 控制返回条数。",
		parameters: Type.Object({
			source: Type.String({ description: `数据源名称，可选: ${KNOWN_SOURCES.join(", ")}` }),
			limit: Type.Optional(Type.Number({ description: "返回条数, 默认 20" })),
			noCache: Type.Optional(Type.Boolean({ description: "true 时跳过缓存强制刷新" })),
			type: Type.Optional(Type.String()),
			day: Type.Optional(Type.String()),
			month: Type.Optional(Type.String()),
		}),
		async execute(toolCallId, params) {
			const source = params.source;
			if (!KNOWN_SOURCES.includes(source)) {
				return {
					content: [
						{
							type: "text",
							text: `未知数据源: ${source}。可用 ${KNOWN_SOURCES.length} 个: ${KNOWN_SOURCES.join(", ")}`,
						},
					],
				};
			}
			try {
				// 动态加载路由（只允许白名单内的文件名，防路径注入）
				const mod = (await import(`${ROUTES_DIR}/${source}.ts`)) as {
					handleRoute?: RouteFn;
				};
				if (!mod.handleRoute) {
					return { content: [{ type: "text", text: `数据源 ${source} 没有 handleRoute 导出` }] };
				}
				const mockCtx = {
					req: { query: (name: string) => (params as Record<string, string | undefined>)[name] },
				};
				const result = await mod.handleRoute(mockCtx, params.noCache === true);
				return { content: [{ type: "text", text: toMarkdown(result, params.limit ?? 20) }] };
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `获取 ${source} 失败: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	});
}
