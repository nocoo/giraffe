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

function MetricCard({
	icon: Icon,
	label,
	value,
}: {
	icon: LucideIcon;
	label: string;
	value: string;
}) {
	return (
		<LayerCard padding="md">
			<div className="flex items-center gap-3">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-basalt-md text-basalt-primary">
					<Icon className="size-4" strokeWidth={1.75} />
				</span>
				<div className="min-w-0">
					<p className="truncate text-xs text-basalt-muted-foreground">{label}</p>
					<p className="tabular-nums text-lg font-medium">{value}</p>
				</div>
			</div>
		</LayerCard>
	);
}

function ChartCard({
	icon: Icon,
	title,
	plot,
	ring,
}: {
	icon: LucideIcon;
	title: string;
	plot: ReactNode;
	ring: ReactNode;
}) {
	return (
		<LayerCard>
			<LayerCard.Header>
				<span className="inline-flex items-center gap-2">
					<Icon className="size-4 text-basalt-primary" strokeWidth={1.75} />
					{title}
				</span>
			</LayerCard.Header>
			<LayerCard.Body className="flex flex-col gap-4">
				<div className="h-44 min-w-0">{plot}</div>
				<div className="flex h-36 min-w-0 items-center justify-center">{ring}</div>
			</LayerCard.Body>
		</LayerCard>
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
				className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8"
				data-testid="insight-metrics"
			>
				<MetricCard icon={CircleDot} label="Issues" value={formatCount(charts.issueCount)} />
				<MetricCard icon={GitPullRequest} label="PRs" value={formatCount(charts.prCount)} />
				<MetricCard
					icon={Activity}
					label="Issue 仓"
					value={formatCount(charts.reposWithIssues + charts.reposWithBoth)}
				/>
				<MetricCard
					icon={GitPullRequest}
					label="PR 仓"
					value={formatCount(charts.reposWithPrs + charts.reposWithBoth)}
				/>
				<MetricCard icon={HeartPulse} label="健康" value={formatCount(charts.strongCount)} />
				<MetricCard icon={Eye} label="观察" value={formatCount(charts.watchCount)} />
				<MetricCard icon={ShieldAlert} label="风险" value={formatCount(charts.riskyCount)} />
				<MetricCard icon={Clock} label="久未推送" value={formatCount(charts.staleCount)} />
			</div>
			<div className="grid gap-4 lg:grid-cols-3">
				<ChartCard
					icon={CircleDot}
					title="跨仓工作量"
					plot={
						charts.workloadByRepo.length > 0 ? (
							<StackedBarChart
								data={charts.workloadByRepo}
								series={ISSUE_PR_SERIES}
								ariaLabel="issues and pull requests by repository"
								className="h-full w-full"
								showAxes
								showLegend
								valueFormatter={formatCount}
							/>
						) : (
							<ChartEmpty label="没有打开的 Issue 或 Pull Request" />
						)
					}
					ring={
						charts.coverage.length > 0 ? (
							<DonutChart
								data={charts.coverage}
								series={COVERAGE_SERIES}
								ariaLabel="repositories with issues or pull requests"
								className="h-full w-full"
								showLegend
								valueFormatter={formatCount}
							/>
						) : (
							<ChartEmpty label="没有仓库覆盖数据" />
						)
					}
				/>
				<ChartCard
					icon={GitPullRequest}
					title="审查与节奏"
					plot={
						<LineChart
							data={charts.activity}
							series={ISSUE_PR_SERIES}
							ariaLabel="issues and pull requests opened by week"
							className="h-full w-full"
							showAxes
							showLegend
							valueFormatter={formatCount}
						/>
					}
					ring={
						charts.prStatus.length > 0 ? (
							<DonutChart
								data={charts.prStatus}
								series={PR_STATUS_SERIES}
								ariaLabel="pull request review status"
								className="h-full w-full"
								showLegend
								valueFormatter={formatCount}
							/>
						) : (
							<ChartEmpty label="没有打开的 Pull Request" />
						)
					}
				/>
				<ChartCard
					icon={HeartPulse}
					title="健康与活跃"
					plot={
						<BarChart
							data={charts.freshness}
							series={[{ key: "y", label: "仓库数", color: chart.teal }]}
							ariaLabel="days since last push"
							className="h-full w-full"
							showAxes
							showLegend
							valueFormatter={formatCount}
						/>
					}
					ring={
						charts.health.length > 0 ? (
							<DonutChart
								data={charts.health}
								series={HEALTH_SERIES}
								ariaLabel="repository health"
								className="h-full w-full"
								showLegend
								valueFormatter={formatCount}
							/>
						) : (
							<ChartEmpty label="没有健康数据" />
						)
					}
				/>
			</div>
		</div>
	);
}
