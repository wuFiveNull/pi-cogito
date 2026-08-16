/**
 * Channel plugin definitions — 第三方/宿主自定义通道的注册契约。
 *
 * 宿主通过 `ChannelRegistry.registerChannelType(name, factory, definition)`
 * 注册自定义通道类(实现 BaseChannel 即可),配置发现/实例化/校验与内置
 * 通道一致;`GatewayManagement.channelCatalog()` 暴露 onboarding 信息面。
 */

import type { MessageBus } from "../bus.ts";
import type { BaseChannel, ChannelConfig } from "./base.ts";

/** 配置字段描述(onboarding 与校验用)。 */
export interface ChannelSetupField {
	name: string;
	kind?: "string" | "secret" | "list" | "int" | "enum";
	required?: boolean;
	default?: unknown;
	choices?: string[];
}

/** 通道插件清单(对齐 nanobot ChannelPlugin 的可用子集)。 */
export interface ChannelPluginDefinition {
	/** 配置键/运行时名,如 "mybot"。 */
	name: string;
	displayName: string;
	/** 配置字段清单(onboarding 表单)。 */
	setup?: ChannelSetupField[];
	/** 配置校验;不合法时抛错(带可读 message)。 */
	validate?(config: ChannelConfig): void;
	/** onboarding 默认配置(缺省 { enabled: false })。 */
	defaultConfig?(): ChannelConfig;
}

/** 通道工厂:宿主用 BaseChannel 子类构造实例。 */
export type ChannelFactory = (config: ChannelConfig, bus: MessageBus) => BaseChannel;

/** 校验不通过时抛出的错误;registry 捕获后跳过该通道并告警。 */
export class ChannelValidationError extends Error {
	readonly code = "CHANNEL_VALIDATION";
	readonly channel: string;

	constructor(channel: string, message: string) {
		super(message);
		this.name = "ChannelValidationError";
		this.channel = channel;
	}
}

/** 按定义校验配置:required 字段 + validate 钩子。 */
export function validateChannelConfig(name: string, definition: ChannelPluginDefinition, config: ChannelConfig): void {
	for (const field of definition.setup ?? []) {
		if (field.required !== true) continue;
		const value = config[field.name];
		const missing =
			value === undefined ||
			value === null ||
			(typeof value === "string" && value.trim() === "") ||
			(Array.isArray(value) && value.length === 0);
		if (missing) {
			throw new ChannelValidationError(name, `missing required config field: ${field.name}`);
		}
	}
	definition.validate?.(config);
}
