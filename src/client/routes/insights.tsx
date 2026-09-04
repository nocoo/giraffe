import { Badge, toast } from "@nocoo/basalt";
import { BarChart } from "@nocoo/basalt/charts/bar";
import { DonutChart } from "@nocoo/basalt/charts/donut";
import { LineChart } from "@nocoo/basalt/charts/line";
import { chart } from "@nocoo/basalt/charts/palette";
import { StackedBarChart } from "@nocoo/basalt/charts/stacked-bar";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import {
	Activity,
	CircleDot,
	Clock,
	Eye,
	GitPullRequest,
	HeartPulse,
	type LucideIcon,
	ShieldAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { InsightsSkeleton } from "../components/layout/page-skeleton";
import { RefreshButton } from "../components/layout/refresh-button";
import { catchLoad, missingTitle } from "../lib/error-ui";
import { formatCount } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import {
	alertsIncomplete,
	buildInsightsCharts,
	type InsightsBoard,
	loadInsightsBoard,
} from "../viewmodels/insights";
import { requestRefresh } from "../viewmodels/refresh";

const ISSUE_PR_SERIES = [
	{ key: "y" as const, label: "Issues", color: chart.sky },
	{ key: "y2" as const, label: "Pull Requests", color: chart.amber },
];

const COVERAGE_SERIES = [
	{ key: "仅 Issue", color: chart.sky },
	{ key: "仅 PR", color: chart.amber },
	{ key: "两者都有", color: chart.teal },
	{ key: "暂无", color: chart.gray },
];

const HEALTH_SERIES = [
	{ key: "健康", color: chart.green },
	{ key: "观察", color: chart.amber },
	{ key: "风险", color: chart.red },
];

const PR_STATUS_SERIES = [
	{ key: "草稿", color: chart.gray },
	{ key: "待审查", color: chart.amber },
	{ key: "需修改", color: chart.orange },
	{ key: "已批准", color: chart.green },
	{ key: "未标记", color: chart.cadet },
];

function Metric({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
	return (
		<div className="flex min-w-0 items-center gap-3">
			<span className="flex size-9 shrink-0 items-center justify-center rounded-basalt-md bg-basalt-primary/10 text-basalt-primary">
				<Icon className="size-4" strokeWidth={1.75} />
			</span>
			<div className="min-w-0">
				<p className="truncate text-xs text-basalt-muted-foreground">{label}</p>
				<p className="tabular-nums text-lg font-medium">{value}</p>
			</div>
		</div>
	);
}

function ChartPanel({
	icon: Icon,
	title,
	children,
}: {
	icon: LucideIcon;
	title: string;
	children: ReactNode;
}) {
	return (
		<section className="min-w-0 space-y-3 bg-basalt-bright">
			<h2 className="flex items-center gap-2 text-sm font-medium">
				<Icon className="size-4 text-basalt-primary" strokeWidth={1.75} />
				{title}
			</h2>
			{children}
		</section>
	);
}

function ChartEmpty({ label }: { label: string }) {
	return (
		<p className="text-sm text-basalt-muted-foreground" role="status">
			{label}
		</p>
	);
}

export function InsightsPage() {
	const [board, setBoard] = useState<InsightsBoard | { missing: true } | null>(null);

	function onLoadError(err: unknown): void {
		const missing = catchLoad(err, (message) => {
			toast.error(message);
		});
		if (missing) {
			setBoard(missing);
		}
	}

	useEffect(() => {
		void loadInsightsBoard()
			.then(setBoard)
			.catch((err: unknown) => {
				const missing = catchLoad(err, (message) => {
					toast.error(message);
				});
				if (missing) {
					setBoard(missing);
				}
			});
	}, []);

	const charts = useMemo(() => {
		if (!board || "missing" in board) {
			return null;
		}
		return buildInsightsCharts(
			board.insights.insights,
			board.issues,
			board.pulls,
			board.insights.fetched_at,
		);
	}, [board]);
	const incomplete = board && !("missing" in board) ? alertsIncomplete(board.insights) : false;

	if (board && "missing" in board) {
		return (
			<div className="space-y-6">
				<PageHeader
					title="Insights"
					description={PAGE_DESCRIPTIONS["/insights"]}
					actions={
						<RefreshButton
							run={() =>
								requestRefresh(["repos", "issues", "prs", "alerts"]).then(() =>
									loadInsightsBoard().then(setBoard),
								)
							}
							onError={onLoadError}
						/>
					}
				/>
				<LayerCard>
					<LayerCard.Well>
						<LayerCard.Empty
							icon={<Activity />}
							title={missingTitle(board)}
							description="先添加 PAT 或刷新。"
						/>
					</LayerCard.Well>
				</LayerCard>
			</div>
		);
	}

	if (!board || !charts) {
		return (
			<div className="space-y-6">
				<PageHeader title="Insights" description={PAGE_DESCRIPTIONS["/insights"]} />
				<InsightsSkeleton label="加载 Insights" />
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<PageHeader
				title="Insights"
				description={PAGE_DESCRIPTIONS["/insights"]}
				actions={
					<>
						{board.insights.truncated ? <Badge variant="warning">已截断</Badge> : null}
						{incomplete ? <Badge variant="warning">告警不完整</Badge> : null}
						<RefreshButton
							run={() =>
								requestRefresh(["repos", "issues", "prs", "alerts"]).then(() =>
									loadInsightsBoard().then(setBoard),
								)
							}
							onError={onLoadError}
						/>
					</>
				}
			/>
			<div
				className="flex flex-wrap items-center gap-x-8 gap-y-4 bg-basalt-bright py-1"
				data-testid="insight-metrics"
			>
				<Metric icon={CircleDot} label="打开 Issues" value={formatCount(charts.issueCount)} />
				<Metric icon={GitPullRequest} label="打开 PRs" value={formatCount(charts.prCount)} />
				<Metric
					icon={Activity}
					label="有 Issue 的仓"
					value={formatCount(charts.reposWithIssues + charts.reposWithBoth)}
				/>
				<Metric
					icon={GitPullRequest}
					label="有 PR 的仓"
					value={formatCount(charts.reposWithPrs + charts.reposWithBoth)}
				/>
				<Metric icon={HeartPulse} label="健康" value={formatCount(charts.strongCount)} />
				<Metric icon={Eye} label="观察" value={formatCount(charts.watchCount)} />
				<Metric icon={ShieldAlert} label="风险" value={formatCount(charts.riskyCount)} />
				<Metric icon={Clock} label="90 天未推送" value={formatCount(charts.staleCount)} />
			</div>
			<div className="grid gap-8 bg-basalt-bright lg:grid-cols-3">
				<ChartPanel icon={CircleDot} title="跨仓工作量">
					{charts.workloadByRepo.length > 0 ? (
						<StackedBarChart
							data={charts.workloadByRepo}
							series={ISSUE_PR_SERIES}
							ariaLabel="issues and pull requests by repository"
							className="h-40 w-full"
							showAxes
							showLegend
							valueFormatter={formatCount}
						/>
					) : (
						<ChartEmpty label="没有打开的 Issue 或 Pull Request" />
					)}
					{charts.coverage.length > 0 ? (
						<DonutChart
							data={charts.coverage}
							series={COVERAGE_SERIES}
							ariaLabel="repositories with issues or pull requests"
							className="h-36 w-full"
							showLegend
							valueFormatter={formatCount}
						/>
					) : (
						<ChartEmpty label="没有仓库覆盖数据" />
					)}
				</ChartPanel>
				<ChartPanel icon={GitPullRequest} title="审查与节奏">
					{charts.prStatus.length > 0 ? (
						<DonutChart
							data={charts.prStatus}
							series={PR_STATUS_SERIES}
							ariaLabel="pull request review status"
							className="h-36 w-full"
							showLegend
							valueFormatter={formatCount}
						/>
					) : (
						<ChartEmpty label="没有打开的 Pull Request" />
					)}
					<LineChart
						data={charts.activity}
						series={ISSUE_PR_SERIES}
						ariaLabel="issues and pull requests opened by week"
						className="h-40 w-full"
						showAxes
						showLegend
						valueFormatter={formatCount}
					/>
				</ChartPanel>
				<ChartPanel icon={HeartPulse} title="健康与活跃">
					{charts.health.length > 0 ? (
						<DonutChart
							data={charts.health}
							series={HEALTH_SERIES}
							ariaLabel="repository health"
							className="h-36 w-full"
							showLegend
							valueFormatter={formatCount}
						/>
					) : (
						<ChartEmpty label="没有健康数据" />
					)}
					<BarChart
						data={charts.freshness}
						series={[{ key: "y", label: "仓库数", color: chart.teal }]}
						ariaLabel="days since last push"
						className="h-40 w-full"
						showAxes
						showLegend
						valueFormatter={formatCount}
					/>
				</ChartPanel>
			</div>
		</div>
	);
}
