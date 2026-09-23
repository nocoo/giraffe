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
import { FLOW_COLORS } from "../lib/chart-theme";
import { formatCount } from "../lib/format";
import type { repoActivityBoard, repoFactorySeries } from "../viewmodels/boards";

type Day = ReturnType<typeof repoFactorySeries>[number];

/** Commits and merged PRs as bars (left), CI success rate as a line (right). */
export function RepoActivityChart({ days }: { days: Day[] }) {
	const series = [
		{ key: "commits", label: "提交", color: FLOW_COLORS.commits },
		{ key: "prMerged", label: "合并 PR", color: FLOW_COLORS.merged },
		{ key: "ciRate", label: "CI 7 日成功率 · 右轴", color: FLOW_COLORS.release },
	];
	return (
		<ChartShell
			ariaLabel="仓库 90 天活动"
			className="h-64 w-full"
			legend={<ChartLegend items={series} shape="line" />}
			summary={
				<span className="sr-only">
					每日提交与合并 PR（左轴），截至当日 7 天 CI 成功率（右轴）。
				</span>
			}
		>
			<ComposedChart
				data={days}
				margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
				barCategoryGap={1}
			>
				<CartesianGrid {...GRID_PROPS} />
				<XAxis
					dataKey="x"
					{...cartesianAxisProps()}
					tickFormatter={(v) => String(v).slice(5)}
					minTickGap={24}
				/>
				<YAxis yAxisId="flow" {...cartesianAxisProps()} allowDecimals={false} width={32} />
				<YAxis
					yAxisId="rate"
					orientation="right"
					{...cartesianAxisProps()}
					domain={[0, 1]}
					width={40}
					tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
				/>
				<Tooltip
					{...chartTooltipProps({ cursor: "bar" })}
					content={({ active, payload }) => {
						const d = payload?.[0]?.payload as Day | undefined;
						if (!active || !d) return null;
						return (
							<div className="factory-chart-tip">
								<strong>{d.x} UTC</strong>
								<ChartTooltipRow
									label="提交"
									color={FLOW_COLORS.commits}
									value={formatCount(d.commits)}
								/>
								<ChartTooltipRow
									label="合并 PR"
									color={FLOW_COLORS.merged}
									value={formatCount(d.prMerged)}
								/>
								<ChartTooltipRow
									label="新开 / 关闭 Issue"
									hideIndicator
									value={`${formatCount(d.issueOpened)} / ${formatCount(d.issueClosed)}`}
								/>
								<ChartTooltipRow
									label="CI 7 日成功率"
									color={FLOW_COLORS.release}
									value={d.ciRate === null ? "—" : `${Math.round(d.ciRate * 100)}%`}
								/>
							</div>
						);
					}}
				/>
				<Bar
					yAxisId="flow"
					dataKey="commits"
					fill={FLOW_COLORS.commits}
					radius={BAR_RADIUS.vertical}
					{...ANIMATION_PROPS}
				/>
				<Bar
					yAxisId="flow"
					dataKey="prMerged"
					fill={FLOW_COLORS.merged}
					radius={BAR_RADIUS.vertical}
					{...ANIMATION_PROPS}
				/>
				<Line
					yAxisId="rate"
					dataKey="ciRate"
					stroke={FLOW_COLORS.release}
					strokeWidth={2}
					dot={false}
					connectNulls={false}
					type="monotone"
					{...ANIMATION_PROPS}
				/>
			</ComposedChart>
		</ChartShell>
	);
}

const OUTCOME = [
	{ key: "success", label: "成功", color: "var(--color-basalt-primary)" },
	{ key: "failure", label: "失败", color: "var(--color-basalt-destructive)" },
	{ key: "other", label: "取消 / 跳过", color: "var(--color-basalt-muted-foreground)" },
	{ key: "pending", label: "进行中", color: FLOW_COLORS.opened },
];

/** Daily workflow runs stacked by outcome for the last 30 days. */
export function RunOutcomeChart({ ci }: { ci: ReturnType<typeof repoActivityBoard>["ci"] }) {
	return (
		<ChartShell
			ariaLabel="近 30 天工作流结果"
			className="h-44 w-full"
			legend={<ChartLegend items={OUTCOME} shape="bar" />}
			summary={<span className="sr-only">每日工作流运行按结果堆叠，最新 100 次运行。</span>}
		>
			<ComposedChart
				data={ci.daily.points}
				margin={{ top: 6, right: 4, bottom: 0, left: 0 }}
				barCategoryGap={2}
			>
				<CartesianGrid {...GRID_PROPS} />
				<XAxis
					dataKey="x"
					{...cartesianAxisProps()}
					tickFormatter={(v) => String(v).slice(5)}
					minTickGap={20}
				/>
				<YAxis {...cartesianAxisProps()} allowDecimals={false} width={28} />
				<Tooltip {...chartTooltipProps({ cursor: "bar", formatter: formatCount })} />
				{OUTCOME.map((o, i) => (
					<Bar
						key={o.key}
						dataKey={o.key}
						name={o.label}
						stackId="o"
						fill={o.color}
						{...(i === OUTCOME.length - 1 ? { radius: BAR_RADIUS.vertical } : {})}
						{...ANIMATION_PROPS}
					/>
				))}
			</ComposedChart>
		</ChartShell>
	);
}

/** Releases on a time axis: dots per release, spacing shows cadence. */
export function ReleaseTimeline({
	releases,
}: {
	releases: ReturnType<typeof repoActivityBoard>["releases"];
}) {
	const items = releases.timeline;
	if (items.length < 1) return null;
	const first = Date.parse(items[0]?.at ?? "");
	const last = Date.parse(items.at(-1)?.at ?? "");
	const span = Math.max(1, last - first);
	return (
		<div
			className="giraffe-release-line"
			role="img"
			aria-label={`${items.length} 个版本，从 ${items[0]?.at.slice(0, 10)} 到 ${items.at(-1)?.at.slice(0, 10)}`}
		>
			<span className="giraffe-release-axis" aria-hidden="true" />
			{items.map((r, i) => (
				<span
					key={r.tag}
					className="giraffe-release-dot"
					data-prerelease={r.prerelease || undefined}
					style={{
						left: `${items.length === 1 ? 50 : ((Date.parse(r.at) - first) / span) * 100}%`,
					}}
					title={`${r.tag} · ${r.at.slice(0, 10)}${r.prerelease ? " · 预发布" : ""}`}
				>
					{i === 0 || i === items.length - 1 || items.length <= 8 ? (
						<small aria-hidden="true">{r.at.slice(5, 10)}</small>
					) : null}
				</span>
			))}
			<div className="giraffe-release-ends" aria-hidden="true">
				<span>最早 {items[0]?.tag}</span>
				<span>最新 {items.at(-1)?.tag}</span>
			</div>
		</div>
	);
}
