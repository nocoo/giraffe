import { Badge, toast } from "@nocoo/basalt";
import { BarChart } from "@nocoo/basalt/charts/bar";
import { DonutChart } from "@nocoo/basalt/charts/donut";
import { LineChart } from "@nocoo/basalt/charts/line";
import { chart } from "@nocoo/basalt/charts/palette";
import { StackedBarChart } from "@nocoo/basalt/charts/stacked-bar";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
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

function Kpi({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
	return (
		<LayerCard padding="md">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-xs text-basalt-muted-foreground">{label}</p>
					<p className="mt-1 tabular-nums text-xl font-medium tracking-tight">{value}</p>
				</div>
				<Icon className="size-4 shrink-0 text-basalt-primary" strokeWidth={1.5} />
			</div>
		</LayerCard>
	);
}

function ChartBrick({ title, children }: { title: string; children: ReactNode }) {
	return (
		<LayerCard padding="md">
			<p className="mb-3 text-sm font-medium">{title}</p>
			<div className="h-52 min-w-0">{children}</div>
		</LayerCard>
	);
}

function ChartEmpty({ label }: { label: string }) {
	return (
		<div className="flex h-full items-center justify-center">
			<p className="text-sm text-basalt-muted-foreground" role="status">
				{label}
			</p>
		</div>
	);
}

function KpiRow({ children }: { children: ReactNode }) {
	return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

function ChartRow({ children }: { children: ReactNode }) {
	return <div className="grid gap-3 lg:grid-cols-2">{children}</div>;
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
			<div className="space-y-8">
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
			<div className="space-y-8">
				<PageHeader title="Insights" description={PAGE_DESCRIPTIONS["/insights"]} />
				<InsightsSkeleton label="加载 Insights" />
			</div>
		);
	}

	return (
		<div className="space-y-8">
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
			<SectionRule title="工作量">
				<div className="space-y-3" data-testid="insight-metrics">
					<KpiRow>
						<Kpi icon={CircleDot} label="打开 Issues" value={formatCount(charts.issueCount)} />
						<Kpi icon={GitPullRequest} label="打开 PRs" value={formatCount(charts.prCount)} />
						<Kpi
							icon={Activity}
							label="有 Issue 的仓"
							value={formatCount(charts.reposWithIssues + charts.reposWithBoth)}
						/>
						<Kpi
							icon={GitPullRequest}
							label="有 PR 的仓"
							value={formatCount(charts.reposWithPrs + charts.reposWithBoth)}
						/>
					</KpiRow>
					<ChartRow>
						<ChartBrick title="仓内 Issue / PR">
							{charts.workloadByRepo.length > 0 ? (
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
							)}
						</ChartBrick>
						<ChartBrick title="仓库覆盖">
							{charts.coverage.length > 0 ? (
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
							)}
						</ChartBrick>
					</ChartRow>
				</div>
			</SectionRule>
			<SectionRule title="审查与节奏">
				<div className="space-y-3">
					<KpiRow>
						<Kpi icon={GitPullRequest} label="草稿" value={formatCount(charts.draftCount)} />
						<Kpi icon={Eye} label="待审查" value={formatCount(charts.reviewRequiredCount)} />
						<Kpi
							icon={ShieldAlert}
							label="需修改"
							value={formatCount(charts.changesRequestedCount)}
						/>
						<Kpi icon={HeartPulse} label="已批准" value={formatCount(charts.approvedCount)} />
					</KpiRow>
					<ChartRow>
						<ChartBrick title="近 8 周新建">
							<LineChart
								data={charts.activity}
								series={ISSUE_PR_SERIES}
								ariaLabel="issues and pull requests opened by week"
								className="h-full w-full"
								showAxes
								showLegend
								valueFormatter={formatCount}
							/>
						</ChartBrick>
						<ChartBrick title="PR 状态">
							{charts.prStatus.length > 0 ? (
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
							)}
						</ChartBrick>
					</ChartRow>
				</div>
			</SectionRule>
			<SectionRule title="健康与活跃">
				<div className="space-y-3">
					<KpiRow>
						<Kpi icon={HeartPulse} label="健康" value={formatCount(charts.strongCount)} />
						<Kpi icon={Eye} label="观察" value={formatCount(charts.watchCount)} />
						<Kpi icon={ShieldAlert} label="风险" value={formatCount(charts.riskyCount)} />
						<Kpi icon={Clock} label="久未推送" value={formatCount(charts.staleCount)} />
					</KpiRow>
					<ChartRow>
						<ChartBrick title="距上次推送">
							<BarChart
								data={charts.freshness}
								series={[{ key: "y", label: "仓库数", color: chart.teal }]}
								ariaLabel="days since last push"
								className="h-full w-full"
								showAxes
								showLegend
								valueFormatter={formatCount}
							/>
						</ChartBrick>
						<ChartBrick title="健康分布">
							{charts.health.length > 0 ? (
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
							)}
						</ChartBrick>
					</ChartRow>
				</div>
			</SectionRule>
		</div>
	);
}
