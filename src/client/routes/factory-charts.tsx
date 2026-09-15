import { LayerCard } from "@nocoo/basalt/components/layer-card";
import type { ReactNode } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	ResponsiveContainer,
	Scatter,
	ScatterChart,
	Tooltip,
	XAxis,
	YAxis,
	ZAxis,
} from "recharts";
import type { FactoryRepo } from "../../lib/factory-types";
import {
	type factoryBoard,
	hasFactoryMeasurement,
	formatFactoryCount as n,
	treemapTiles,
} from "../viewmodels/factory";

type Board = ReturnType<typeof factoryBoard>;
const GREEN = "#43875c";
const BLUE = "#467a96";
const AMBER = "#b48740";
export function FactoryPanel({
	title,
	hint,
	children,
	className = "",
}: {
	title: string;
	hint: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<LayerCard className={`min-w-0 ${className}`} padding="sm">
			<div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<h2 className="text-sm font-semibold">{title}</h2>
				<p className="text-[11px] text-basalt-muted-foreground">{hint}</p>
			</div>
			{children}
		</LayerCard>
	);
}
export function FactorySpark({ values, label }: { values: number[]; label: string }) {
	const max = Math.max(1, ...values);
	const points = values
		.map((v, i) => `${(i / Math.max(1, values.length - 1)) * 100},${24 - (v / max) * 22}`)
		.join(" ");
	return (
		<svg viewBox="0 0 100 26" className="h-6 w-24" role="img" aria-label={label}>
			<title>{label}</title>
			<polyline
				points={points}
				fill="none"
				stroke="currentColor"
				strokeWidth="1.8"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}
export function FactoryHeatmap({
	days,
	selected,
	onSelect,
}: {
	days: { date: string; count: number }[];
	selected: string;
	onSelect: (date: string) => void;
}) {
	const max = Math.max(1, ...days.map((d) => d.count));
	const offset = days[0] ? (new Date(days[0].date).getUTCDay() + 6) % 7 : 0;
	return (
		<div>
			<div
				className="factory-calendar"
				style={{
					gridTemplateColumns: `repeat(${Math.ceil((days.length + offset) / 7)}, minmax(10px,1fr))`,
				}}
			>
				{days.map((d, i) => (
					<button
						key={d.date}
						type="button"
						onClick={() => onSelect(selected === d.date ? "" : d.date)}
						style={{
							gridColumn: Math.floor((i + offset) / 7) + 1,
							gridRow: ((i + offset) % 7) + 1,
						}}
						className={`factory-day factory-heat-${d.count === 0 ? 0 : Math.min(4, Math.ceil((d.count / max) * 4))} ${selected === d.date ? "factory-day-selected" : ""}`}
						aria-pressed={selected === d.date}
						title={`${d.date} UTC · ${n(d.count)}`}
						aria-label={`${d.date} UTC：${n(d.count)}，点击查看当日记录`}
					/>
				))}
			</div>
			<div className="mt-2 flex justify-between gap-2 text-[10px] text-basalt-muted-foreground">
				<span>{days[0]?.date} · 周一至周日，自上而下</span>
				<span>
					少 <span className="factory-legend factory-heat-1" />{" "}
					<span className="factory-legend factory-heat-2" />{" "}
					<span className="factory-legend factory-heat-3" />{" "}
					<span className="factory-legend factory-heat-4" /> 多
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
	const tiles = treemapTiles(
		repos.map((r) => ({ name: r.name, value: r.languageBytes })),
		100,
		60,
	);
	if (!tiles.length)
		return <p className="factory-chart-empty">没有可测量的语言字节；零字节仓库仍在表中。</p>;
	return (
		<section className="factory-treemap" aria-label="按语言字节数分配面积的仓库树图">
			{tiles.map((tile, i) => (
				<button
					key={tile.name}
					type="button"
					onClick={() => onSelect(tile.name)}
					title={`${tile.name} · ${n(tile.value)} bytes`}
					aria-label={`${tile.name}，${n(tile.value)} 语言字节，打开仓库`}
					className={`factory-tile factory-tile-${i % 5}`}
					style={{
						left: `${tile.x}%`,
						top: `${(tile.y / 60) * 100}%`,
						width: `${tile.width}%`,
						height: `${(tile.height / 60) * 100}%`,
					}}
				>
					<span>{tile.name.split("/")[1]}</span>
					{tile.width > 12 && tile.height > 9 ? (
						<small>{(tile.value / 1e6).toFixed(2)} MB</small>
					) : null}
				</button>
			))}
		</section>
	);
}
export function FactoryThroughput({ days }: { days: Board["days"] }) {
	return (
		<div
			className="h-48"
			role="img"
			aria-label="每日 PR 合并、未合并关闭和 Release 吞吐；完整数字见每日账本"
		>
			<ResponsiveContainer width="100%" height="100%">
				<AreaChart
					data={days}
					accessibilityLayer
					margin={{ top: 4, right: 4, left: -22, bottom: 0 }}
				>
					<CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.18} />
					<XAxis
						dataKey="date"
						tickFormatter={(v) => String(v).slice(5)}
						minTickGap={25}
						tick={{ fontSize: 10 }}
						axisLine={false}
						tickLine={false}
					/>
					<YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
					<Tooltip
						contentStyle={{
							background: "var(--color-basalt-background)",
							borderColor: "var(--color-basalt-border)",
							fontSize: 12,
						}}
					/>
					<Area
						name="合并 PR"
						dataKey="prMerged"
						stackId="throughput"
						stroke={GREEN}
						fill={GREEN}
						fillOpacity={0.45}
						isAnimationActive={false}
					/>
					<Area
						name="关闭未合并 PR"
						dataKey="prClosed"
						stackId="throughput"
						stroke={AMBER}
						fill={AMBER}
						fillOpacity={0.3}
						isAnimationActive={false}
					/>
					<Area
						name="Release"
						dataKey="releases"
						stackId="throughput"
						stroke={BLUE}
						fill={BLUE}
						fillOpacity={0.3}
						isAnimationActive={false}
					/>
				</AreaChart>
			</ResponsiveContainer>
		</div>
	);
}
export function FactoryScatter({
	repos,
	onSelect,
}: {
	repos: FactoryRepo[];
	onSelect: (repo: string) => void;
}) {
	const data = repos
		.filter((r) => hasFactoryMeasurement(r, "commits"))
		.map((r) => ({
			name: r.name,
			commits: r.metrics.commits,
			wip: r.openIssues + r.openPrs,
			size: r.languageBytes,
		}));
	if (!data.length)
		return <p className="factory-chart-empty">当前范围还没有可用的提交观测，未画成零。</p>;
	return (
		<div
			className="h-52"
			role="img"
			aria-label="仓库提交与开放工作散点图。横轴窗口提交，纵轴 open issue 加 PR，气泡面积按语言字节。可在下方表格选择仓库。"
		>
			<ResponsiveContainer width="100%" height="100%">
				<ScatterChart accessibilityLayer margin={{ top: 8, right: 12, left: -20, bottom: 8 }}>
					<CartesianGrid strokeDasharray="3 3" opacity={0.18} />
					<XAxis type="number" dataKey="commits" name="窗口提交" tick={{ fontSize: 10 }} />
					<YAxis
						type="number"
						dataKey="wip"
						name="开放 Issue + PR"
						allowDecimals={false}
						tick={{ fontSize: 10 }}
					/>
					<ZAxis type="number" dataKey="size" range={[32, 700]} name="语言 bytes" />
					<Tooltip
						cursor={{ strokeDasharray: "3 3" }}
						contentStyle={{ background: "var(--color-basalt-background)", fontSize: 12 }}
					/>
					<Scatter
						name="仓库"
						data={data}
						fill={GREEN}
						fillOpacity={0.65}
						isAnimationActive={false}
						onClick={(point) => {
							const name = (point.payload as { name?: unknown } | undefined)?.name;
							if (typeof name === "string") onSelect(name);
						}}
					/>
				</ScatterChart>
			</ResponsiveContainer>
		</div>
	);
}
