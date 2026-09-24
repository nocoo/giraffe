import { Tooltip as BasaltTooltip, Button, TooltipContent, TooltipTrigger } from "@nocoo/basalt";
import { ANIMATION_PROPS, chartTooltipProps } from "@nocoo/basalt/charts/config";
import { ChartFrame } from "@nocoo/basalt/charts/frame";
import { Sparkline } from "@nocoo/basalt/charts/sparkline";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { Text } from "@nocoo/basalt/components/text";
import { ChartNoAxesCombined } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, Treemap } from "recharts";
import type { FactoryRepo } from "../../lib/factory-types";
import { HelpTooltip } from "../components/layout/help-tooltip";
import { IconLabel } from "../components/layout/icon-label";
import { categoryColor, chartColor } from "../lib/chart-theme";
import { formatFactoryCount as n } from "../viewmodels/factory";

export function FactoryPanel({
	title,
	hint,
	children,
	className = "",
	flush = false,
}: {
	title: string;
	hint: string;
	children: ReactNode;
	className?: string;
	flush?: boolean;
}) {
	return (
		<LayerCard className={`min-w-0 ${className}`}>
			<LayerCard.Header>
				<div className="flex items-center gap-2">
					<Text as="h2" variant="heading">
						<IconLabel icon={ChartNoAxesCombined}>{title}</IconLabel>
					</Text>
					<HelpTooltip label={`${title}说明`}>{hint}</HelpTooltip>
				</div>
			</LayerCard.Header>
			<LayerCard.Body className={`factory-panel-body ${flush ? "p-0" : ""}`}>
				{children}
			</LayerCard.Body>
		</LayerCard>
	);
}
/** A day series left to right; `range` labels both ends so the newest side is explicit. */
export function FactorySpark({
	values,
	label,
	range,
}: {
	values: (number | null)[];
	label: string;
	range?: { from: string; to: string };
}) {
	const observed = values.filter((value) => value !== null);
	if (!observed.length)
		return (
			<Text size="xs" tone="muted">
				尚无完整观测
			</Text>
		);
	const spark = (
		<Sparkline
			data={values.map((value, index) => ({ x: index, value }))}
			series={[{ key: "value", label, color: chartColor(0) }]}
			ariaLabel={label}
			className="h-10 w-28 max-w-full"
			summary={
				<span className="sr-only">
					{label}：已观测 {n(observed.reduce((sum, value) => sum + value, 0))}{" "}
					次；逐日数值见每日账本。
				</span>
			}
		/>
	);
	if (!range) return spark;
	return (
		<span className="giraffe-spark">
			{spark}
			<span className="giraffe-spark-range" aria-hidden="true">
				<span>{range.from.slice(5, 10)}</span>
				<span>{range.to.slice(5, 10)}</span>
			</span>
		</span>
	);
}
export function FactoryHeatmap({
	days,
	selected,
	onSelect,
}: {
	days: { date: string; count: number; known?: boolean }[];
	selected: string;
	onSelect: (date: string) => void;
}) {
	const max = Math.max(1, ...days.map((d) => d.count));
	const offset = days[0] ? (new Date(days[0].date).getUTCDay() + 6) % 7 : 0;
	// Basalt's calendar has no date-selection or missing-data API; keep the drilldown
	// using its buttons, tooltips and heatmap palette instead of replacing unknowns with zero.
	return (
		<div className="factory-calendar-chart">
			<div
				className="factory-calendar"
				style={{
					gridTemplateColumns: `repeat(${Math.ceil((days.length + offset) / 7)}, minmax(10px,1fr))`,
				}}
			>
				{days.map((d, i) => {
					const label = `${d.date} UTC：${d.known === false ? (d.count ? `≥ ${n(d.count)}` : "未完整观测") : n(d.count)}`;
					return (
						<BasaltTooltip key={d.date}>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									type="button"
									onClick={() => onSelect(selected === d.date ? "" : d.date)}
									style={{
										gridColumn: Math.floor((i + offset) / 7) + 1,
										gridRow: ((i + offset) % 7) + 1,
										backgroundColor: `var(--giraffe-heat-${d.count === 0 ? 0 : Math.min(4, Math.ceil((d.count / max) * 4))})`,
									}}
									className={`factory-day h-auto min-w-0 p-0 ${d.known === false && d.count === 0 ? "factory-day-unknown" : ""} ${selected === d.date ? "factory-day-selected" : ""}`}
									aria-pressed={selected === d.date}
									aria-label={`${label}，点击查看当日统计`}
								/>
							</TooltipTrigger>
							<TooltipContent>{label}</TooltipContent>
						</BasaltTooltip>
					);
				})}
			</div>
			<div className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-basalt-muted-foreground">
				<span>{days[0]?.date} · 周一至周日，自上而下</span>
				<span>
					少{" "}
					{[1, 2, 3, 4].map((level) => (
						<span
							key={level}
							className="factory-legend"
							style={{ backgroundColor: `var(--giraffe-heat-${level})` }}
						/>
					))}{" "}
					多
				</span>
				<span>{days.at(-1)?.date}（末日未满）</span>
			</div>
		</div>
	);
}
export function FactoryTreemap({
	repos,
	onSelect,
}: {
	repos: FactoryRepo[];
	onSelect: (repo: string) => void;
}) {
	const data = repos
		.filter((repo) => Number.isFinite(repo.languageBytes) && repo.languageBytes > 0)
		.map((repo) => ({ name: repo.name, value: repo.languageBytes }))
		.sort((a, b) => b.value - a.value);
	if (!data.length)
		return <p className="factory-chart-empty">没有可测量的语言字节；零字节仓库仍在表中。</p>;
	return (
		<ChartFrame
			ariaLabel="仓库规模地图"
			size="factory-plot w-full"
			summary={
				<span className="sr-only">
					面积按语言字节分配。可用 Tab 选择仓库，Enter 或空格打开；零字节仓库仍保留在仓库表中。
				</span>
			}
		>
			<Treemap
				data={data}
				dataKey="value"
				nameKey="name"
				nodeGap={3}
				{...ANIMATION_PROPS}
				isUpdateAnimationActive={false}
				content={(tile) =>
					tile.depth !== 1 ? (
						<g />
					) : (
						<g>
							<rect
								x={tile.x}
								y={tile.y}
								width={tile.width}
								height={tile.height}
								rx={4}
								fill={categoryColor(repos.find((r) => r.name === tile.name)?.language ?? "")}
							/>
							<foreignObject x={tile.x} y={tile.y} width={tile.width} height={tile.height}>
								<Button
									variant="ghost"
									className="factory-tile h-full w-full p-1"
									aria-label={`${tile.name}，${n(tile.value)} 语言字节，打开仓库`}
									onClick={() => onSelect(tile.name)}
								>
									{tile.width > 80 && tile.height > 40 ? (
										<span className="max-w-full truncate rounded bg-basalt-card/95 px-2 py-1 text-xs font-medium text-basalt-foreground">
											{tile.name.split("/")[1]}
										</span>
									) : null}
								</Button>
							</foreignObject>
						</g>
					)
				}
			>
				<Tooltip {...chartTooltipProps({ formatter: (value) => `${n(value)} bytes` })} />
			</Treemap>
		</ChartFrame>
	);
}
