import { SegmentControl } from "@nocoo/basalt";
import {
	ANIMATION_PROPS,
	BAR_RADIUS,
	cartesianAxisProps,
	chartTooltipProps,
	GRID_PROPS,
} from "@nocoo/basalt/charts/config";
import { ChartFrame, ChartShell } from "@nocoo/basalt/charts/frame";
import { ChartLegend } from "@nocoo/basalt/charts/legend";
import { ChartTooltipRow } from "@nocoo/basalt/charts/tooltip";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import {
	Bar,
	CartesianGrid,
	Cell,
	ComposedChart,
	Line,
	ReferenceArea,
	ReferenceLine,
	Scatter,
	ScatterChart,
	Tooltip,
	XAxis,
	YAxis,
	ZAxis,
} from "recharts";
import { LanguageLabel } from "../components/layout/labels";
import { categoryColor, FLOW_COLORS } from "../lib/chart-theme";
import {
	activityAge,
	activityQuadrant,
	backlogRows,
	type factoryBoard,
	formatRate,
	formatFactoryCount as n,
	type Period,
	type PeriodSummary,
	periodChange,
	type RepoActivity,
} from "../viewmodels/factory";
import { FactoryPanel } from "./factory-charts";

type Board = ReturnType<typeof factoryBoard>;
type Day = Board["days"][number];
export const PERIOD_OPTIONS = [
	{ value: "1", label: "1 天" },
	{ value: "7", label: "7 天" },
	{ value: "30", label: "30 天" },
];

function Change({
	current,
	previous,
	known,
	kind = "count",
	invert = false,
}: {
	current: number | null;
	previous: number | null;
	known: boolean;
	kind?: "count" | "rate" | "delta";
	invert?: boolean;
}) {
	if (!known) return <span className="factory-change">基线不完整</span>;
	const change = periodChange(current, previous, kind);
	const Icon =
		change.direction === "up"
			? ArrowUpRight
			: change.direction === "down"
				? ArrowDownRight
				: ArrowRight;
	const good = change.direction === "flat" ? undefined : (change.direction === "up") !== invert;
	return (
		<span
			className="factory-change"
			data-tone={good === undefined ? "flat" : good ? "good" : "bad"}
		>
			<Icon className="size-3" aria-hidden="true" />
			{change.label}
		</span>
	);
}

function stockMove(label: string, stock: { from: number | null; to: number | null }, now: number) {
	if (stock.from === null || stock.to === null) return `当前 ${label} ${n(now)}`;
	const delta = stock.to - stock.from;
	return `${label} ${n(stock.from)} → ${n(stock.to)}（${delta > 0 ? "+" : ""}${n(delta)}）`;
}

/** Flow over the chosen period against the preceding equal period, plus the current stock. */
export function PeriodStrip({
	periods,
	period,
	onPeriod,
	totals,
	activeRepos,
}: {
	periods: PeriodSummary[];
	period: Period;
	onPeriod: (value: Period) => void;
	totals: Board["totals"];
	activeRepos: number;
}) {
	const p = periods.find((x) => x.days === period) ?? periods[0];
	if (!p) return null;
	const c = p.current;
	const v = p.previous;
	const rate = (x: { ciSuccess: number; ciFailure: number }) =>
		x.ciSuccess + x.ciFailure ? x.ciSuccess / (x.ciSuccess + x.ciFailure) : null;
	const cells: {
		label: string;
		value: string;
		sub: ReactNode;
		change: ReactNode;
	}[] = [
		{
			label: "提交",
			value: n(c.commits),
			sub: `${c.active}/${totals.repos} 仓有提交`,
			change: (
				<Change
					current={c.commits}
					previous={v.commits}
					known={p.complete.commits && p.previousComplete.commits}
				/>
			),
		},
		{
			label: "PR 合并 / 新开",
			value: `${n(c.prMerged)} / ${n(c.prOpened)}`,
			sub: stockMove("open", p.stock.openPrs, totals.openPrs),
			change: (
				<Change
					current={c.prMerged}
					previous={v.prMerged}
					known={p.complete.prs && p.previousComplete.prs}
				/>
			),
		},
		{
			label: "Issue 关闭 / 新开 · 净增变化",
			value: `${n(c.issueClosed)} / ${n(c.issueOpened)}`,
			sub: stockMove("open", p.stock.openIssues, totals.openIssues),
			change: (
				<Change
					current={c.issueOpened - c.issueClosed}
					previous={v.issueOpened - v.issueClosed}
					known={p.complete.issues && p.previousComplete.issues}
					kind="delta"
					invert
				/>
			),
		},
		{
			label: "CI 成功率",
			value: formatRate(rate(c)),
			sub: `${n(c.ciSuccess + c.ciFailure)} 次判定运行`,
			change: (
				<Change
					current={rate(c)}
					previous={rate(v)}
					known={p.complete.actions && p.previousComplete.actions}
					kind="rate"
				/>
			),
		},
		{
			label: "发布",
			value: n(c.releases),
			sub: `前 ${period} 天 ${n(v.releases)}`,
			change: (
				<Change
					current={c.releases}
					previous={v.releases}
					known={p.complete.releases && p.previousComplete.releases}
				/>
			),
		},
	];
	return (
		<section className="factory-period" aria-label="区间变化">
			<header>
				<SegmentControl
					legend="统计区间"
					value={String(period)}
					options={PERIOD_OPTIONS}
					onValueChange={(value) => onPeriod(Number(value) as Period)}
				/>
				<span>
					{p.since === p.until ? p.since : `${p.since} → ${p.until}`} UTC · 对比前 {period} 天 ·{" "}
					{activeRepos} 仓 7 日内活跃
				</span>
			</header>
			<dl>
				{cells.map((cell) => (
					<div key={cell.label}>
						<dt>{cell.label}</dt>
						<dd>
							<strong>{cell.value}</strong>
							{cell.change}
						</dd>
						<dd className="factory-period-sub">{cell.sub}</dd>
					</div>
				))}
			</dl>
		</section>
	);
}

function DayTooltip({
	active,
	payload,
	rows,
}: {
	active?: boolean;
	payload?: readonly { payload?: Day }[];
	rows: { label: string; color: string; value: (d: Day) => string }[];
}) {
	const d = payload?.[0]?.payload;
	if (!active || !d) return null;
	return (
		<div className="factory-chart-tip">
			<strong>{d.date} UTC</strong>
			{rows.map((r) => (
				<ChartTooltipRow key={r.label} label={r.label} color={r.color} value={r.value(d)} />
			))}
		</div>
	);
}

function known(d: Day, key: keyof Day, stream: keyof Day["complete"]): number | null {
	const value = d[key] as number;
	return d.complete[stream] || value ? value : null;
}

const axisLabel = (value: string, side: "left" | "right") => ({
	value,
	angle: -90,
	position: side === "left" ? ("left" as const) : ("right" as const),
	offset: -2,
	style: {
		fill: "var(--color-basalt-muted-foreground)",
		fontSize: 12,
		textAnchor: "middle" as const,
	},
});

/** Output (bars, left axis) against how widely the work was spread (line, right axis). */
export function CommitBreadthChart({ days }: { days: Day[] }) {
	const data = days.map((d) => ({ ...d, commitsKnown: known(d, "commits", "commits") }));
	const series = [
		{ key: "commitsKnown", label: "每日提交", color: FLOW_COLORS.commits },
		{ key: "activeRepos7", label: "7 日活跃仓库数 · 右轴", color: FLOW_COLORS.release },
	];
	return (
		<ChartShell
			legend={<ChartLegend items={series} shape="line" />}
			ariaLabel="提交产出与覆盖面"
			size="factory-plot factory-plot-tall w-full"
			summary={
				<span className="sr-only">
					柱为每日提交数（左轴），折线为截至当日 7
					天内有提交的仓库数（右轴）；完整逐日数值见每日账本。
				</span>
			}
		>
			<ComposedChart
				data={data}
				margin={{ top: 8, right: 16, bottom: 0, left: 16 }}
				barCategoryGap={1}
			>
				<CartesianGrid {...GRID_PROPS} />
				<XAxis
					dataKey="date"
					{...cartesianAxisProps()}
					tickFormatter={(v) => String(v).slice(5)}
					minTickGap={24}
				/>
				<YAxis
					yAxisId="flow"
					{...cartesianAxisProps()}
					allowDecimals={false}
					width={44}
					label={axisLabel("提交", "left")}
				/>
				<YAxis
					yAxisId="breadth"
					orientation="right"
					{...cartesianAxisProps()}
					allowDecimals={false}
					width={36}
					label={axisLabel("活跃仓库", "right")}
				/>
				<Tooltip
					{...chartTooltipProps({ cursor: "bar" })}
					content={
						<DayTooltip
							rows={[
								{
									label: "提交",
									color: FLOW_COLORS.commits,
									value: (d) =>
										d.complete.commits ? n(d.commits) : d.commits ? `≥ ${n(d.commits)}` : "未知",
								},
								{
									label: "7 日活跃仓库",
									color: FLOW_COLORS.release,
									value: (d) => (d.activeRepos7 === null ? "—" : n(d.activeRepos7)),
								},
							]}
						/>
					}
				/>
				<Bar
					yAxisId="flow"
					dataKey="commitsKnown"
					name="提交"
					fill={FLOW_COLORS.commits}
					fillOpacity={0.85}
					radius={BAR_RADIUS.vertical}
					{...ANIMATION_PROPS}
				/>
				<Line
					yAxisId="breadth"
					dataKey="activeRepos7"
					name="7 日活跃仓库"
					type="monotone"
					stroke={FLOW_COLORS.release}
					strokeWidth={2}
					dot={false}
					connectNulls={false}
					{...ANIMATION_PROPS}
				/>
			</ComposedChart>
		</ChartShell>
	);
}

/**
 * Daily inflow/outflow as diverging bars on the left axis, the resulting open stock as a line on the right.
 * The line is omitted where incomplete events would make the backwards reconstruction wrong.
 */
export function FlowStockChart({ days, kind }: { days: Day[]; kind: "prs" | "issues" }) {
	const prs = kind === "prs";
	const data = days.map((d) => {
		const opened = known(d, prs ? "prOpened" : "issueOpened", kind);
		const closed = prs ? known(d, "prMerged", "prs") : known(d, "issueClosed", "issues");
		return {
			...d,
			opened,
			closed: closed === null ? null : -closed,
			rejected: prs ? (known(d, "prClosed", "prs") === null ? null : -d.prClosed) : null,
			stock: prs ? d.openPrs : d.openIssues,
		};
	});
	const title = prs ? "PR" : "Issue";
	const series = [
		{ key: "opened", label: `新开 ${title} ↑`, color: FLOW_COLORS.opened },
		{
			key: "closed",
			label: prs ? "合并 ↓" : "关闭 ↓",
			color: FLOW_COLORS.closed,
		},
		...(prs
			? [{ key: "rejected", label: "未合并关闭 ↓", color: "var(--color-basalt-muted-foreground)" }]
			: []),
		{ key: "stock", label: "Open 存量 · 右轴", color: "var(--color-basalt-foreground)" },
	];
	const hasStock = data.some((d) => d.stock !== null);
	return (
		<ChartShell
			legend={<ChartLegend items={series} shape="bar" />}
			ariaLabel={`${title} 流量与存量`}
			size="factory-plot w-full"
			summary={
				<span className="sr-only">
					每日新开向上、完成向下（左轴）；折线为当日结束时 open 的 {title}{" "}
					数（右轴），由当前数量按事件倒推。
				</span>
			}
		>
			<ComposedChart
				data={data}
				margin={{ top: 8, right: 16, bottom: 0, left: 16 }}
				stackOffset="sign"
				barCategoryGap={1}
			>
				<CartesianGrid {...GRID_PROPS} />
				<XAxis
					dataKey="date"
					{...cartesianAxisProps()}
					tickFormatter={(v) => String(v).slice(5)}
					minTickGap={24}
				/>
				<YAxis
					yAxisId="flow"
					{...cartesianAxisProps()}
					allowDecimals={false}
					width={44}
					tickFormatter={(v: number) => n(Math.abs(v))}
					label={axisLabel("每日流量", "left")}
				/>
				<YAxis
					yAxisId="stock"
					orientation="right"
					{...cartesianAxisProps(!hasStock)}
					allowDecimals={false}
					width={36}
					label={axisLabel(hasStock ? "Open" : "", "right")}
				/>
				<ReferenceLine yAxisId="flow" y={0} stroke="var(--color-basalt-border)" />
				<Tooltip
					{...chartTooltipProps({ cursor: "bar" })}
					content={
						<DayTooltip
							rows={[
								{
									label: "新开",
									color: FLOW_COLORS.opened,
									value: (d) => n(prs ? d.prOpened : d.issueOpened),
								},
								{
									label: prs ? "合并" : "关闭",
									color: FLOW_COLORS.closed,
									value: (d) => n(prs ? d.prMerged : d.issueClosed),
								},
								...(prs
									? [
											{
												label: "未合并关闭 ↓",
												color: "var(--color-basalt-muted-foreground)",
												value: (d: Day) => n(d.prClosed),
											},
										]
									: []),
								{
									label: "日终 open",
									color: "var(--color-basalt-foreground)",
									value: (d) => {
										const v = prs ? d.openPrs : d.openIssues;
										return v === null ? "无法倒推" : n(v);
									},
								},
							]}
						/>
					}
				/>
				<Bar
					yAxisId="flow"
					dataKey="opened"
					stackId="f"
					fill={FLOW_COLORS.opened}
					radius={BAR_RADIUS.vertical}
					{...ANIMATION_PROPS}
				/>
				<Bar
					yAxisId="flow"
					dataKey="closed"
					stackId="f"
					fill={FLOW_COLORS.closed}
					{...ANIMATION_PROPS}
				/>
				{prs ? (
					<Bar
						yAxisId="flow"
						dataKey="rejected"
						stackId="f"
						fill="var(--color-basalt-muted-foreground)"
						fillOpacity={0.6}
						{...ANIMATION_PROPS}
					/>
				) : null}
				<Line
					yAxisId="stock"
					dataKey="stock"
					type="stepAfter"
					stroke="var(--color-basalt-foreground)"
					strokeWidth={2}
					dot={false}
					connectNulls={false}
					{...ANIMATION_PROPS}
				/>
			</ComposedChart>
		</ChartShell>
	);
}

/** Merged throughput (bars, left) with the rolling CI success rate (line, right). */
export function DeliveryChart({ days }: { days: Day[] }) {
	const data = days.map((d) => ({
		...d,
		merged: known(d, "prMerged", "prs"),
		rel: known(d, "releases", "releases"),
	}));
	const series = [
		{ key: "merged", label: "合并 PR", color: FLOW_COLORS.merged },
		{ key: "rel", label: "Release", color: FLOW_COLORS.opened },
		{ key: "ciRate7", label: "CI 7 日成功率 · 右轴", color: FLOW_COLORS.release },
	];
	return (
		<ChartShell
			legend={<ChartLegend items={series} shape="line" />}
			ariaLabel="交付吞吐"
			size="factory-plot w-full"
			summary={
				<span className="sr-only">
					柱为每日合并 PR 与 Release（左轴），折线为截至当日 7 天 CI
					成功率（右轴）；逐日数值见每日账本。
				</span>
			}
		>
			<ComposedChart
				data={data}
				margin={{ top: 8, right: 16, bottom: 0, left: 16 }}
				barCategoryGap={1}
			>
				<CartesianGrid {...GRID_PROPS} />
				<XAxis
					dataKey="date"
					{...cartesianAxisProps()}
					tickFormatter={(v) => String(v).slice(5)}
					minTickGap={24}
				/>
				<YAxis
					yAxisId="flow"
					{...cartesianAxisProps()}
					allowDecimals={false}
					width={44}
					label={axisLabel("交付数", "left")}
				/>
				<YAxis
					yAxisId="rate"
					orientation="right"
					{...cartesianAxisProps()}
					domain={[0, 1]}
					width={40}
					tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
					label={axisLabel("CI 成功率", "right")}
				/>
				<Tooltip
					{...chartTooltipProps({ cursor: "bar" })}
					content={
						<DayTooltip
							rows={[
								{ label: "合并 PR", color: FLOW_COLORS.merged, value: (d) => n(d.prMerged) },
								{ label: "Release", color: FLOW_COLORS.opened, value: (d) => n(d.releases) },
								{
									label: "CI 7 日成功率",
									color: FLOW_COLORS.release,
									value: (d) => formatRate(d.ciRate7),
								},
							]}
						/>
					}
				/>
				<Bar
					yAxisId="flow"
					dataKey="merged"
					stackId="d"
					fill={FLOW_COLORS.merged}
					{...ANIMATION_PROPS}
				/>
				<Bar
					yAxisId="flow"
					dataKey="rel"
					stackId="d"
					fill={FLOW_COLORS.opened}
					radius={BAR_RADIUS.vertical}
					{...ANIMATION_PROPS}
				/>
				<Line
					yAxisId="rate"
					dataKey="ciRate7"
					type="monotone"
					stroke={FLOW_COLORS.release}
					strokeWidth={2}
					dot={false}
					connectNulls={false}
					{...ANIMATION_PROPS}
				/>
			</ComposedChart>
		</ChartShell>
	);
}

/** Per-repository 1/7/30-day change matrix: heat cells for flow, bars for stock. */
export function RepoPeriodMatrix({
	activity,
	until,
	period,
	onSelect,
}: {
	activity: RepoActivity[];
	until: (repo: string) => string;
	period: Period;
	onSelect: (repo: string) => void;
}) {
	const rows = [...activity].sort(
		(a, b) =>
			b.periods[period].commits - a.periods[period].commits ||
			b.periods[30].commits - a.periods[30].commits ||
			a.name.localeCompare(b.name),
	);
	const max = Object.fromEntries(
		([1, 7, 30] as const).map((p) => [
			p,
			Math.max(1, ...activity.map((r) => r.periods[p].commits)),
		]),
	) as Record<Period, number>;
	const maxStock = Math.max(1, ...activity.map((r) => r.openIssues + r.openPrs));
	const heat = (value: number, p: Period) =>
		value ? Math.min(4, Math.ceil((value / max[p]) * 4)) : 0;
	return (
		<div className="factory-matrix-scroll">
			<table className="factory-matrix">
				<caption className="sr-only">
					各仓库最近 1、7、30 个完整 UTC 日的提交、PR 与 Issue 变化，以及当前积压
				</caption>
				<thead>
					<tr>
						<th scope="col">仓库</th>
						<th scope="colgroup" colSpan={3}>
							提交 · 1 / 7 / 30 天
						</th>
						<th scope="col">周环比</th>
						<th scope="col">PR 合并 / 新开</th>
						<th scope="col">Issue 关 / 开</th>
						<th scope="col">积压 Issue · PR</th>
						<th scope="col">最后提交</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => {
						const flow = r.periods[period];
						const stock = r.openIssues + r.openPrs;
						const aged = (r.agedIssues ?? 0) + (r.agedPrs ?? 0);
						return (
							<tr key={r.name}>
								<th scope="row">
									<button
										type="button"
										className="factory-matrix-repo"
										onClick={() => onSelect(r.name)}
									>
										<strong>{r.name.split("/")[1]}</strong>
										<LanguageLabel name={r.language} />
									</button>
								</th>
								{([1, 7, 30] as const).map((p) => (
									<td
										key={p}
										className="factory-heat"
										data-level={r.known.commits ? heat(r.periods[p].commits, p) : "unknown"}
										data-focus={p === period || undefined}
										title={`${p} 天 ${r.known.commits ? n(r.periods[p].commits) : "未采集"} 次提交`}
									>
										{r.known.commits ? n(r.periods[p].commits) : "—"}
									</td>
								))}
								<td>
									{r.known.commits ? (
										<Change current={r.periods[7].commits} previous={r.previous7} known />
									) : (
										"—"
									)}
								</td>
								<td className="factory-matrix-num">
									{r.known.prs ? `${n(flow.prMerged)} / ${n(flow.prOpened)}` : "—"}
								</td>
								<td className="factory-matrix-num">
									{r.known.issues ? (
										<span data-net={flow.issueOpened > flow.issueClosed ? "up" : undefined}>
											{n(flow.issueClosed)} / {n(flow.issueOpened)}
										</span>
									) : (
										"—"
									)}
								</td>
								<td>
									<div
										className="factory-stock"
										title={`Open issue ${r.openIssues} · Open PR ${r.openPrs} · 长龄 ${aged}`}
									>
										<span className="factory-stock-track" aria-hidden="true">
											<span
												data-kind="issue"
												style={{ width: `${(r.openIssues / maxStock) * 100}%` }}
											/>
											<span data-kind="pr" style={{ width: `${(r.openPrs / maxStock) * 100}%` }} />
										</span>
										<span className="factory-matrix-num">
											{stock ? `${n(r.openIssues)} · ${n(r.openPrs)}` : "0"}
											{aged ? <em>{aged} 长龄</em> : null}
										</span>
									</div>
								</td>
								<td
									className="factory-matrix-age"
									data-stale={
										!r.last || r.last < until(r.name).slice(0, 10).replace(/\d\d$/, "") || undefined
									}
								>
									{r.known.commits ? activityAge(r.last, until(r.name)) : "未采集"}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

/** Backlog stock per repository, with aged share and 30-day completions for context. */
export function BacklogPanel({
	activity,
	onSelect,
}: {
	activity: RepoActivity[];
	onSelect: (repo: string, stream: "issues" | "prs") => void;
}) {
	const backlog = backlogRows(activity);
	return (
		<FactoryPanel
			title="积压任务"
			hint="按仓库当前 open Issue 与 PR 排序。深色段为长龄（Issue ≥14 天、PR ≥7 天），右侧为最近 30 天完成数，用来判断积压是在消化还是在堆积。"
		>
			<div className="factory-backlog-head">
				<div>
					<strong>{n(backlog.openIssues + backlog.openPrs)}</strong>
					<span>
						项 open · {n(backlog.openIssues)} Issue · {n(backlog.openPrs)} PR
					</span>
				</div>
				<div>
					<strong>{n(backlog.aged)}</strong>
					<span>长龄</span>
				</div>
				<div>
					<strong>{n(backlog.clear)}</strong>
					<span>仓库已清空</span>
				</div>
			</div>
			{backlog.rows.length ? (
				<ol className="factory-backlog">
					{backlog.rows.slice(0, 12).map((r) => (
						<li key={r.name}>
							<button
								type="button"
								onClick={() => onSelect(r.name, r.openIssues >= r.openPrs ? "issues" : "prs")}
							>
								<span className="factory-backlog-name">{r.name.split("/")[1]}</span>
								<span className="factory-backlog-bar" aria-hidden="true">
									<span
										data-kind="issue"
										style={{ flexBasis: `${(r.openIssues / backlog.max) * 100}%` }}
									>
										{r.agedIssues ? (
											<i
												style={{ width: `${(r.agedIssues / Math.max(1, r.openIssues)) * 100}%` }}
											/>
										) : null}
									</span>
									<span data-kind="pr" style={{ flexBasis: `${(r.openPrs / backlog.max) * 100}%` }}>
										{r.agedPrs ? (
											<i style={{ width: `${(r.agedPrs / Math.max(1, r.openPrs)) * 100}%` }} />
										) : null}
									</span>
								</span>
								<span className="factory-backlog-total">{n(r.total)}</span>
								<span className="factory-backlog-done" title="最近 30 天关闭 Issue + 合并 PR">
									30 天完成 {n(r.done30)}
								</span>
							</button>
						</li>
					))}
				</ol>
			) : (
				<p className="factory-chart-empty min-h-24">当前没有 open 的 Issue 或 PR。</p>
			)}
			<p className="factory-backlog-legend">
				<span data-kind="issue">Issue</span>
				<span data-kind="pr">PR</span>
				<span data-kind="aged">长龄</span>
				{backlog.rows.length > 12 ? <span>另有 {backlog.rows.length - 12} 个仓库</span> : null}
			</p>
		</FactoryPanel>
	);
}

const LOG_TICKS = [1, 2, 6, 11, 51, 101, 501, 1001, 5001];
/** Activity versus backlog; the upper-left quadrant is where work accumulates without progress. */
export function ActivityQuadrant({
	activity,
	onSelect,
}: {
	activity: RepoActivity[];
	onSelect: (repo: string) => void;
}) {
	const q = activityQuadrant(activity);
	if (!q.points.length)
		return <p className="factory-chart-empty">当前范围还没有可用的提交观测，未画成零。</p>;
	// Commits are heavily skewed across repositories; a log axis (offset by one for zero) keeps the tail readable.
	const points = q.points.map((p, i) => ({
		...p,
		x: p.commits + 1,
		y: p.backlog + ((i % 5) - 2) * 0.06,
	}));
	const xMax = Math.max(10, ...points.map((p) => p.x)) * 1.15;
	const yMax = Math.max(1, ...q.points.map((p) => p.backlog)) + 0.5;
	return (
		<>
			<ChartFrame
				size="factory-plot w-full"
				ariaLabel="仓库提交与开放工作"
				summary={
					<span className="sr-only">
						横轴为最近 30 天提交，纵轴为当前 open Issue 与
						PR；虚线为中位数，左上象限表示积压高而推进少。
					</span>
				}
			>
				<ScatterChart margin={{ top: 12, right: 12, left: 16, bottom: 4 }}>
					<CartesianGrid {...GRID_PROPS} />
					<ReferenceArea
						x1={1}
						x2={q.medianCommits + 1}
						y1={q.medianBacklog}
						y2={yMax}
						fill="var(--color-giraffe-yellow)"
						fillOpacity={0.07}
						ifOverflow="extendDomain"
					/>
					<XAxis
						type="number"
						dataKey="x"
						name="30 天提交"
						scale="log"
						domain={[1, xMax]}
						ticks={LOG_TICKS.filter((t) => t <= xMax)}
						tickFormatter={(v: number) => n(v - 1)}
						{...cartesianAxisProps()}
						label={{
							value: "30 天提交 →",
							position: "insideBottomRight",
							offset: -2,
							style: { fontSize: 12, fill: "var(--color-basalt-muted-foreground)" },
						}}
					/>
					<YAxis
						type="number"
						dataKey="y"
						name="Open"
						domain={[-0.5, yMax]}
						allowDecimals={false}
						width={32}
						{...cartesianAxisProps()}
						label={axisLabel("积压 ↑", "left")}
						tickFormatter={(v: number) => (Number.isInteger(v) && v >= 0 ? n(v) : "")}
						allowDataOverflow
					/>
					<ZAxis range={[48, 48]} />
					<ReferenceLine
						x={q.medianCommits}
						stroke="var(--color-basalt-muted-foreground)"
						strokeDasharray="4 4"
					/>
					<ReferenceLine
						y={q.medianBacklog}
						stroke="var(--color-basalt-muted-foreground)"
						strokeDasharray="4 4"
					/>
					<Tooltip
						{...chartTooltipProps()}
						content={({ active, payload }) => {
							const p = payload?.[0]?.payload as (typeof q.points)[number] | undefined;
							if (!active || !p) return null;
							return (
								<div className="factory-chart-tip">
									<strong>{p.name}</strong>
									<ChartTooltipRow
										label="30 天提交"
										value={n(p.commits)}
										color={categoryColor(p.language)}
									/>
									<ChartTooltipRow label="Open 积压" value={n(p.backlog)} hideIndicator />
								</div>
							);
						}}
					/>
					<Scatter
						name="仓库"
						data={points}
						{...ANIMATION_PROPS}
						onClick={(point) => {
							const name = (point.payload as { name?: unknown } | undefined)?.name;
							if (typeof name === "string") onSelect(name);
						}}
					>
						{q.points.map((p) => (
							<Cell
								key={p.name}
								fill={categoryColor(p.language)}
								stroke="var(--color-basalt-card)"
								strokeWidth={2}
							/>
						))}
					</Scatter>
				</ScatterChart>
			</ChartFrame>
			<p className="factory-quadrant-note">
				{q.stalled.length ? (
					<>
						<span>积压高、推进少：</span>
						{q.stalled.slice(0, 5).map((p) => (
							<button
								key={p.name}
								type="button"
								className="factory-link"
								onClick={() => onSelect(p.name)}
							>
								{p.name.split("/")[1]}
							</button>
						))}
					</>
				) : (
					"没有仓库同时处于积压高于中位数、提交低于中位数的区域。"
				)}
			</p>
		</>
	);
}
