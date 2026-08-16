/** 插件 UI 组件库(纯函数组件,宿主样式类)。插件经 @pi/web-sdk 导入。 */

import type { ReactNode } from "react";

export function Button({
	children,
	onClick,
	variant = "default",
	disabled,
}: {
	children: ReactNode;
	onClick?: () => void;
	variant?: "default" | "primary" | "danger";
	disabled?: boolean;
}) {
	return (
		<button type="button" className={`btn ${variant === "primary" ? "primary" : ""} ${variant === "danger" ? "danger" : ""}`} onClick={onClick} disabled={disabled}>
			{children}
		</button>
	);
}

export function Tag({ children, tone }: { children: ReactNode; tone?: string }) {
	return <span className={`tag ${tone ? `tag-${tone}` : ""}`}>{children}</span>;
}

export function Card({ title, children, meta }: { title?: ReactNode; meta?: ReactNode; children?: ReactNode }) {
	return (
		<div className="item-card">
			{title && <div className="item-card__title">{title}</div>}
			{meta && <div className="item-card__meta">{meta}</div>}
			{children && <div className="item-card__body">{children}</div>}
		</div>
	);
}

export function MetricTile({ label, value }: { label: string; value: number | string }) {
	return (
		<div className="metric-card">
			<div className="metric-card__value">{value}</div>
			<div className="metric-card__label">{label}</div>
		</div>
	);
}

export function Table({
	columns,
	rows,
}: {
	columns: Array<{ key: string; label: string }>;
	rows: Array<Record<string, unknown>>;
}) {
	return (
		<div className="table-wrap">
			<table className="data-table">
				<thead>
					<tr>
						{columns.map((column) => <th key={column.key}>{column.label}</th>)}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, index) => (
						<tr key={index}>
							{columns.map((column) => <td key={column.key}>{formatCell(row[column.key])}</td>)}
						</tr>
					))}
					{rows.length === 0 && <tr><td colSpan={columns.length} className="empty-hint">暂无数据</td></tr>}
				</tbody>
			</table>
		</div>
	);
}

function formatCell(value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return String(value);
}
