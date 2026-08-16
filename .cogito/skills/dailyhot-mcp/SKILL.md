---
name: dailyhot-mcp
description: >
  用户要查看今日热榜、热搜、热门、排行榜、热点话题时使用——如"微博热搜"、"B站热榜"、
  "知乎热榜"、"掘金热门"、"Hacker News"、"GitHub 趋势"、"历史上的今天"、"今天有什么热点"。
  通过 mcp 代理工具调用 dailyhot 服务器的工具，不要自己猜 API 或去抓网页。
---

# DailyHot 热榜使用指南

通过 `mcp` 代理工具调用 `dailyhot` 工具获取各大平台热榜。数据来自本机 DailyHotApi 服务（localhost:6688），56+ 个数据源，JSON 返回。

## 调用方式

```text
mcp({ tool: "dailyhot", args: { source: "weibo", limit: 10 } })
```

| 工具 | 用途 |
|---|---|
| `dailyhot` | 获取指定平台热榜（核心工具） |
| `dailyhot_sources` | 列出全部可用数据源（不确定源名时先调用） |

参数：
- `source`（必填）：平台英文/拼音名，如 weibo、bilibili、juejin
- `limit`：返回条数，默认 20
- `type`：部分源特有（github 支持 daily/weekly/monthly）
- `day` / `month`：history（历史上的今天）用，如 month=8 day=4

## 常用源速查表

### 技术社区（模型/开发者最常用）
| source | 平台 |
|---|---|
| `juejin` | 稀土掘金文章榜 |
| `hackernews` | Hacker News |
| `producthunt` | Product Hunt |
| `github` | GitHub 趋势（配 type=daily/weekly/monthly） |
| `hellogithub` | HelloGitHub 热门仓库 |
| `v2ex` | V2EX 主题榜 |
| `linuxdo` | Linux.do |
| `nodeseek` | NodeSeek |
| `csdn` / `51cto` | CSDN / 51CTO |

### 综合资讯
| source | 平台 |
|---|---|
| `weibo` | 微博热搜 |
| `baidu` | 百度热搜 |
| `zhihu` / `zhihu-daily` | 知乎热榜 / 日报 |
| `douyin` / `kuaishou` | 抖音 / 快手 |
| `toutiao` | 今日头条 |
| `36kr` | 36氪 |
| `ithome` | IT之家 |
| `huxiu` | 虎嗅 |
| `thepaper` | 澎湃新闻 |
| `sspai` | 少数派 |
| `jianshu` | 简书 |

### 社区/其他
| source | 平台 |
|---|---|
| `hupu` | 虎扑步行街 |
| `ngabbs` | NGA 论坛 |
| `acfun` | AcFun |
| `douban-movie` / `douban-group` | 豆瓣电影 / 讨论组 |
| `smzdm` | 什么值得买 |
| `weread` | 微信读书 |
| `tieba` | 百度贴吧 |
| `nytimes` | 纽约时报 |
| `earthquake` | 地震速报 |
| `weatheralarm` | 气象预警 |
| `history` | 历史上的今天（配 month/day） |

完整列表用 `dailyhot_sources` 查询（共 56 个）。

## 使用规范

1. **不确定源名**：先调 `dailyhot_sources` 确认，不要猜拼写（如 v2ex 不是 v2ex_com）。
2. **用户说"今天有什么热点"这类宽问题**：优先综合资讯源（weibo + zhihu + 36kr + juejin），多源并行调用再汇总。
3. **技术向问题**：优先 juejin / hackernews / github / v2ex / linuxdo。
4. **结果呈现**：每条带标题和热度（🔥数字，≥1万显示"万"），超过 10 条给前 10 条即可，必要时给链接。
5. **服务不可用**：返回 `[不可用]` 或连接失败时，如实告知"DailyHotApi 服务未运行"，提示启动命令，**不要**用 web_read 抓热榜网页冒充。

## 与其它 skill 的分工

- **dailyhot-mcp**：全网各平台热榜（微博/B站/掘金/HN...）
- **aihot**：AI 圈垂直资讯（24h/日报/热点事件）
- **agent-reach-mcp**：搜索/网页/社交平台数据获取

用户要"AI 圈新闻"用 aihot；要"微博/掘金/HN 热榜"用 dailyhot；要"搜某话题的讨论"用 agent-reach。不要混用。
