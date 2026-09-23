import { Button } from "@nocoo/basalt";
import {
	ANIMATION_PROPS,
	BAR_RADIUS,
	cartesianAxisProps,
	chartTooltipProps,
	GRID_PROPS,
} from "@nocoo/basalt/charts/config";
import { ChartShell } from "@nocoo/basalt/charts/frame";
import { ChartLegend } from "@nocoo/basalt/charts/legend";
import { ChartTooltipRow } from "@nocoo/basalt/charts/tooltip";
import { FilterChip } from "@nocoo/basalt/components/filter-bar";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import { formatCount } from "../../lib/format";
import type { AGE_BUCKETS } from "../../viewmodels/overview";
import { ChartBrick } from "./chart-brick";
import { RankBars, type RankRow } from "./rank-bars";

export const AGE_COLORS: Record<(typeof AGE_BUCKETS)[number]["key"], string> = {
	d1: "var(--color-basalt-chart-5)",
	d7: "color-mix(in srgb,var(--color-basalt-chart-5) 75%,var(--color-basalt-border))",
	d30: "color-mix(in srgb,var(--color-basalt-chart-5) 50%,var(--color-basalt-border))",
	d90: "color-mix(in srgb,var(--color-basalt-chart-7) 60%,var(--color-basalt-border))",
	old: "var(--color-basalt-chart-7)",
};

export function OverviewCard({
	title,
	hint,
	children,
}: {
	title: string;
	hint: string;
	children: ReactNode;
}) {
	return (
		<ChartBrick title={title} description={hint}>
			{children}
		</ChartBrick>
	);
}

/** Age buckets as a clickable column strip; the bar height is the count, the color the recency. */
export function AgeStrip({
	age,
	active,
	onSelect,
	label,
}: {
	age: { rows: { key: string; label: string; count: number }[]; unknown: number; max: number };
	active: string;
	onSelect: (key: string) => void;
	label: string;
}) {
	return (
		<fieldset className="giraffe-age" aria-label={`${label}，列为距今天数上限`}>
			{age.rows.map((b) => (
				<Button
					key={b.key}
					type="button"
					variant="ghost"
					className="giraffe-age-col"
					aria-pressed={active === b.key}
					data-active={active === b.key || undefined}
					aria-label={`${b.label} ${b.count}`}
					onClick={() => onSelect(active === b.key ? "" : b.key)}
				>
					<strong>{formatCount(b.count)}</strong>
					<span className="giraffe-age-bar" aria-hidden="true">
						<span
							style={{
								height: `${b.count ? Math.max(6, (b.count / age.max) * 100) : 0}%`,
								background: AGE_COLORS[b.key as keyof typeof AGE_COLORS],
							}}
						/>
					</span>
					<small>{b.label}</small>
				</Button>
			))}
		</fieldset>
	);
}

export function Breakdown({
	rows,
	max,
	label,
	active,
	onSelect,
	color,
	format = (name) => name,
}: {
	rows: { name: string; value: number; share?: number; other?: number; color?: string }[];
	max: number;
	label: string;
	active: string;
	onSelect?: (name: string) => void;
	color?: string;
	format?: (name: string) => string;
}) {
	// "其他" aggregates the tail; scaling to it would flatten every named row.
	const named = rows.filter((r) => !r.other).map((r) => r.value);
	const scale = named.length ? Math.max(1, ...named) : max;
	const items: RankRow[] = rows.map((r) => ({
		name: r.name,
		value: r.value,
		label: r.other ? `其他 ${r.other} 项` : format(r.name),
		...(r.other
			? { color: "var(--color-basalt-muted-foreground)" }
			: r.color
				? { color: r.color }
				: {}),
		...(r.share !== undefined ? { note: `${Math.round(r.share * 100)}%` } : {}),
	}));
	return (
		<RankBars
			rows={items}
			max={scale}
			label={label}
			active={active}
			{...(onSelect ? { onSelect } : {})}
			{...(color ? { color } : {})}
		/>
	);
}

/** Weekly or daily counts as thin bars, optionally stacked by category. */
export function CountBars({
	data,
	series,
	label,
	xFormat = (v) => v,
	className = "h-44 w-full",
	stacked = series.length > 1,
}: {
	data: Record<string, string | number>[];
	series: { key: string; label: string; color: string }[];
	label: string;
	xFormat?: (value: string) => string;
	className?: string;
	/** Stack only parts of one whole; distinct events sit side by side. */
	stacked?: boolean;
}) {
	return (
		<ChartShell
			ariaLabel={label}
			className={className}
			legend={series.length > 1 ? <ChartLegend items={series} shape="bar" /> : null}
			summary={<span className="sr-only">{label}，悬停查看每个时段的数值。</span>}
		>
			<BarChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 0 }} barCategoryGap={2}>
				<CartesianGrid {...GRID_PROPS} />
				<XAxis
					dataKey="x"
					{...cartesianAxisProps()}
					tickFormatter={(v) => xFormat(String(v))}
					minTickGap={16}
				/>
				<YAxis {...cartesianAxisProps()} allowDecimals={false} width={28} />
				<Tooltip
					{...chartTooltipProps({ cursor: "bar" })}
					content={({ active, payload, label: x }) =>
						active && payload?.length ? (
							<div className="factory-chart-tip">
								<strong>{xFormat(String(x))}</strong>
								{series.map((s) => {
									const hit = payload.find((p) => p.dataKey === s.key);
									return (
										<ChartTooltipRow
											key={s.key}
											label={s.label}
											color={s.color}
											value={formatCount(Number(hit?.value ?? 0))}
										/>
									);
								})}
							</div>
						) : null
					}
				/>
				{series.map((s, i) => (
					<Bar
						key={s.key}
						dataKey={s.key}
						name={s.label}
						{...(stacked ? { stackId: "s" } : {})}
						fill={s.color}
						{...(!stacked || i === series.length - 1 ? { radius: BAR_RADIUS.vertical } : {})}
						{...ANIMATION_PROPS}
					/>
				))}
			</BarChart>
		</ChartShell>
	);
}

/** Active click-filters rendered as removable chips with one clear action. */
export function ActiveFilters({
	filters,
	labels,
	format = {},
	onClear,
}: {
	filters: Record<string, string>;
	labels: Record<string, string>;
	format?: Record<string, (value: string) => string>;
	onClear: (key?: string) => void;
}) {
	const active = Object.entries(filters).filter(([, v]) => v);
	if (!active.length) return null;
	return (
		<fieldset className="giraffe-active-filters" aria-label="已选筛选">
			{active.map(([k, v]) => (
				<FilterChip
					key={k}
					label={labels[k] ?? k}
					value={format[k]?.(v) ?? v}
					onRemove={() => onClear(k)}
					removeLabel={`移除${labels[k] ?? k}筛选`}
				/>
			))}
			<Button type="button" variant="ghost" size="sm" onClick={() => onClear()}>
				<X className="size-3.5" aria-hidden="true" />
				清除全部
			</Button>
		</fieldset>
	);
}
