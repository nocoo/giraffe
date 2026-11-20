import {
	ANIMATION_PROPS,
	BAR_RADIUS,
	ChartFrame as BasaltChartFrame,
	type ChartFrameProps as BasaltChartFrameProps,
	CHART_PLOT_MARGIN,
	ChartLegend,
	type ChartSeriesDescriptor,
	cartesianAxisProps,
	chartTooltipProps,
	formatChartNumber,
	GRID_PROPS,
	getChartColor,
	RESPONSIVE_CONTAINER_PROPS,
	seriesColor,
} from "@nocoo/basalt/components/chart";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import {
	Area,
	Bar,
	CartesianGrid,
	AreaChart as RechartsAreaChart,
	BarChart as RechartsBarChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";

export type ChartFrameProps = Omit<BasaltChartFrameProps, "children"> & {
	children: ReactElement<{
		accessibilityLayer?: boolean;
		"aria-label"?: string;
	}>;
	accessibilityLayer?: boolean;
};

export type ChartShellProps = ChartFrameProps & { legend?: ReactNode };

export function ChartFrame({
	ariaLabel,
	children,
	accessibilityLayer = true,
	...props
}: ChartFrameProps) {
	const childProps = children.props;
	const child = cloneElement(children, {
		accessibilityLayer: childProps.accessibilityLayer ?? accessibilityLayer,
		"aria-label": childProps["aria-label"] ?? ariaLabel,
	});
	return (
		<BasaltChartFrame ariaLabel={ariaLabel} {...props}>
			<ResponsiveContainer {...RESPONSIVE_CONTAINER_PROPS}>{child}</ResponsiveContainer>
		</BasaltChartFrame>
	);
}

export function ChartShell(props: ChartShellProps) {
	return <ChartFrame {...props} />;
}

type CommonChartProps = {
	data: Record<string, unknown>[];
	series: ChartSeriesDescriptor[];
	ariaLabel: string;
	className?: string;
	summary?: ReactNode;
};

export function AreaChart({
	data,
	series,
	ariaLabel,
	className = "h-56 w-full",
	showAxes = false,
	showLegend = false,
	valueFormatter = formatChartNumber,
	xValueFormatter,
	summary,
}: CommonChartProps & {
	showAxes?: boolean;
	showLegend?: boolean;
	valueFormatter?: (value: number) => string;
	xValueFormatter?: (value: string | number) => string;
}) {
	return (
		<ChartFrame
			ariaLabel={ariaLabel}
			className={className}
			legend={showLegend ? <ChartLegend items={series} shape="area" /> : null}
			summary={summary}
		>
			<RechartsAreaChart data={data} margin={CHART_PLOT_MARGIN}>
				{showAxes ? <CartesianGrid {...GRID_PROPS} /> : null}
				<XAxis
					dataKey="x"
					{...cartesianAxisProps(!showAxes)}
					{...(xValueFormatter ? { tickFormatter: xValueFormatter } : {})}
					minTickGap={24}
				/>
				<YAxis {...cartesianAxisProps(!showAxes)} allowDecimals={false} width={36} />
				<Tooltip
					{...chartTooltipProps({
						formatter: valueFormatter,
						cursor: "line",
					})}
					{...(xValueFormatter ? { labelFormatter: (v) => xValueFormatter(String(v)) } : {})}
				/>
				{series.map((item, index) => {
					const color = seriesColor(item, index) ?? getChartColor(index);
					return (
						<Area
							key={item.key}
							type="monotone"
							dataKey={item.key}
							name={item.label ?? item.key}
							stroke={color}
							fill={color}
							fillOpacity={0.18}
							strokeWidth={2}
							{...ANIMATION_PROPS}
						/>
					);
				})}
			</RechartsAreaChart>
		</ChartFrame>
	);
}

function SharedBarChart({
	data,
	series,
	ariaLabel,
	className = "h-56 w-full",
	showAxes = false,
	showLegend = false,
	valueFormatter = formatChartNumber,
	summary,
	stacked = false,
}: CommonChartProps & {
	showAxes?: boolean;
	showLegend?: boolean;
	valueFormatter?: (value: number) => string;
	stacked?: boolean;
}) {
	return (
		<ChartFrame
			ariaLabel={ariaLabel}
			className={className}
			legend={showLegend ? <ChartLegend items={series} shape="bar" /> : null}
			summary={summary}
		>
			<RechartsBarChart data={data} margin={CHART_PLOT_MARGIN}>
				{showAxes ? <CartesianGrid {...GRID_PROPS} /> : null}
				<XAxis dataKey="x" {...cartesianAxisProps(!showAxes)} minTickGap={16} />
				<YAxis {...cartesianAxisProps(!showAxes)} allowDecimals={false} width={36} />
				<Tooltip {...chartTooltipProps({ formatter: valueFormatter, cursor: "bar" })} />
				{series.map((item, index) => (
					<Bar
						key={item.key}
						dataKey={item.key}
						name={item.label ?? item.key}
						fill={seriesColor(item, index) ?? getChartColor(index)}
						{...(stacked ? { stackId: "stack" } : { radius: BAR_RADIUS.vertical })}
						{...ANIMATION_PROPS}
					/>
				))}
			</RechartsBarChart>
		</ChartFrame>
	);
}

export function BarChart(props: Omit<Parameters<typeof SharedBarChart>[0], "stacked">) {
	return <SharedBarChart {...props} stacked={false} />;
}

export function StackedBarChart(props: Omit<Parameters<typeof SharedBarChart>[0], "stacked">) {
	return <SharedBarChart {...props} stacked />;
}

export function Sparkline({
	data,
	series,
	ariaLabel,
	className = "h-10 w-28",
	summary,
}: CommonChartProps) {
	return (
		<ChartFrame ariaLabel={ariaLabel} className={className} summary={summary}>
			<RechartsBarChart
				data={data}
				margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
				barCategoryGap="12%"
				barGap={1}
			>
				<XAxis dataKey="x" hide />
				<YAxis hide />
				{series.map((item, index) => (
					<Bar
						key={item.key}
						dataKey={item.key}
						name={item.label ?? item.key}
						fill={seriesColor(item, index) ?? getChartColor(index)}
						radius={1}
						{...ANIMATION_PROPS}
					/>
				))}
			</RechartsBarChart>
		</ChartFrame>
	);
}

export function SlotBarChart({
	items,
	ariaLabel,
	heightClass = "h-5",
	className = "",
}: {
	items: readonly { color: string; height: number }[];
	ariaLabel: string;
	heightClass?: string;
	className?: string;
}) {
	return (
		<div
			role="img"
			aria-label={ariaLabel}
			className={`flex items-end gap-0.5 ${heightClass} ${className}`.trim()}
		>
			{items.map((item, index) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: static slot bars have no stable id
					key={`${index}-${item.color}`}
					className={`min-w-0 flex-1 rounded-xs ${item.color}`}
					style={{ height: `${Math.max(0, Math.min(1, item.height)) * 100}%` }}
				/>
			))}
		</div>
	);
}
