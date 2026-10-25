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
import { Bar, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from "recharts";
import { formatCount, formatDate, formatDayRange } from "../lib/format";

type Day = { x: string; success: number; failure: number; other: number };
type TipDay = Day & { rate: number | null };

const COLORS = {
	success: "var(--color-basalt-chart-5)",
	failure: "hsl(var(--basalt-accent-8))",
	other: "var(--color-basalt-muted-foreground)",
	rate: "var(--color-basalt-chart-1)",
};

/** A trailing 7-day success rate; null until the window has any decisive run. */
function withRate(daily: readonly Day[]): TipDay[] {
	return daily.map((day, index) => {
		const window = daily.slice(Math.max(0, index - 6), index + 1);
		const success = window.reduce((n, d) => n + d.success, 0);
		const failure = window.reduce((n, d) => n + d.failure, 0);
		const decisive = success + failure;
		return { ...day, rate: decisive ? success / decisive : null };
	});
}

function DayTooltip({
	active,
	payload,
}: {
	active?: boolean;
	payload?: readonly { payload?: TipDay }[];
}) {
	const day = payload?.[0]?.payload;
	if (!active || !day) return null;
	return (
		<div className="factory-chart-tip">
			<strong>{formatDayRange(day.x)}</strong>
			<ChartTooltipRow label="成功" color={COLORS.success} value={formatCount(day.success)} />
			<ChartTooltipRow label="失败" color={COLORS.failure} value={formatCount(day.failure)} />
			<ChartTooltipRow label="取消 / 跳过" color={COLORS.other} value={formatCount(day.other)} />
			<ChartTooltipRow
				label="7 日成功率"
				color={COLORS.rate}
				value={day.rate === null ? "无判定" : `${Math.round(day.rate * 100)}%`}
			/>
		</div>
	);
}

/**
 * Runs per day (bars, left axis) with the trailing 7-day success rate (line, right axis).
 * The rate uses only success and failure so cancelled or skipped runs cannot lift it.
 */
export function CiTrend({ daily }: { daily: readonly Day[] }) {
	const data = withRate(daily);
	const series = [
		{ key: "success", label: "成功", color: COLORS.success },
		{ key: "failure", label: "失败", color: COLORS.failure },
		{ key: "other", label: "取消 / 跳过", color: COLORS.other },
		{ key: "rate", label: "7 日成功率 · 右轴", color: COLORS.rate },
	];
	return (
		<ChartShell
			legend={<ChartLegend items={series} shape="bar" />}
			ariaLabel="近 30 天运行结果与成功率"
			size="factory-plot w-full"
			summary={
				<span className="sr-only">
					柱为每日完成运行次数（左轴），折线为截至当日 7 天的成功率（右轴）；成功率只计成功与失败。
				</span>
			}
		>
			<ComposedChart
				data={data}
				margin={{ top: 8, right: 16, bottom: 0, left: 16 }}
				barCategoryGap={2}
			>
				<CartesianGrid {...GRID_PROPS} />
				<XAxis
					dataKey="x"
					{...cartesianAxisProps()}
					tickFormatter={(value) => formatDate(String(value)).slice(5, 10)}
					minTickGap={24}
				/>
				<YAxis yAxisId="runs" {...cartesianAxisProps()} allowDecimals={false} width={44} />
				<YAxis
					yAxisId="rate"
					orientation="right"
					{...cartesianAxisProps()}
					domain={[0, 1]}
					width={40}
					tickFormatter={(value: number) => `${Math.round(value * 100)}%`}
				/>
				<Tooltip {...chartTooltipProps({ cursor: "bar" })} content={<DayTooltip />} />
				<Bar
					yAxisId="runs"
					dataKey="success"
					stackId="outcome"
					fill={COLORS.success}
					radius={BAR_RADIUS.vertical}
					{...ANIMATION_PROPS}
				/>
				<Bar
					yAxisId="runs"
					dataKey="failure"
					stackId="outcome"
					fill={COLORS.failure}
					{...ANIMATION_PROPS}
				/>
				<Bar
					yAxisId="runs"
					dataKey="other"
					stackId="outcome"
					fill={COLORS.other}
					{...ANIMATION_PROPS}
				/>
				<Line
					yAxisId="rate"
					dataKey="rate"
					stroke={COLORS.rate}
					dot={false}
					strokeWidth={2}
					connectNulls={false}
					{...ANIMATION_PROPS}
				/>
			</ComposedChart>
		</ChartShell>
	);
}
