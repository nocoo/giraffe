import {
	ANIMATION_PROPS,
	type ChartAccessibilityProps,
	ChartLegend,
	type ChartSeriesDescriptor,
	chartTooltipProps,
	formatChartNumber,
	type NamedValue,
} from "@nocoo/basalt/components/chart";
import { Cell, Pie, PieChart, Tooltip } from "recharts";
import { chartColor } from "../../lib/chart-theme";
import { ChartShell } from "./charts";

type DonutChartProps = ChartAccessibilityProps & {
	data: NamedValue[];
	series?: ChartSeriesDescriptor[];
	ariaLabel?: string;
	className?: string;
	showLegend?: boolean;
	valueFormatter?: (value: number) => string;
};

// Basalt's stock donut fixes its radius at 48px. Keep its frame, legend and
// tooltip, but size the Recharts ring relative to the available card space.
export function DonutChart({
	data,
	series,
	ariaLabel = "环形图",
	className = "h-56 w-full",
	showLegend = false,
	valueFormatter = formatChartNumber,
	...accessibility
}: DonutChartProps) {
	const items = data.map((point, index) => {
		const descriptor = series?.find((item) => item.key === point.name);
		return {
			key: point.name,
			label: descriptor?.label ?? point.name,
			color: descriptor?.color ?? chartColor(index),
		};
	});
	return (
		<ChartShell
			ariaLabel={ariaLabel}
			className={className}
			legend={showLegend ? <ChartLegend items={items} shape="bar" /> : null}
			{...accessibility}
		>
			<PieChart>
				<Pie
					data={data}
					dataKey="value"
					nameKey="name"
					innerRadius="52%"
					outerRadius="86%"
					stroke="none"
					{...ANIMATION_PROPS}
				>
					{items.map((item) => (
						<Cell key={item.key} fill={item.color} />
					))}
				</Pie>
				<Tooltip {...chartTooltipProps({ formatter: valueFormatter, cursor: false })} />
			</PieChart>
		</ChartShell>
	);
}
