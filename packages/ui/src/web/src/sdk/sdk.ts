/**
 * @pi/web-sdk — 插件开发 SDK。
 *
 * 插件模块源码通过 importmap 导入本模块:
 *   import { api, Button, Table } from "@pi/web-sdk";
 *   import React from "react";           // 共享宿主 React
 *
 * 手机端/未来任何前端:提供同样的 importmap 指向同一组 sdk 端点
 * (/assets/sdk/*.js)即可复用全部插件。
 */

/** React.createElement 别名,方便无 JSX 的插件源码。 */
export { createElement as h } from "react";
export type {
	ChatMessageRow,
	DeliveryRow,
	MemoryRow,
	PageResult,
	ProactiveOverview,
	SessionRow,
	SkillInfo,
	TickLogRow,
	TickStepRow,
	WebPluginInfo,
} from "../api.ts";
export { ApiError, api } from "../api.ts";
export { Button, Card, MetricTile, Table, Tag } from "./ui.tsx";
