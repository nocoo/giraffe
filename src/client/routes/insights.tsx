import { Badge, Link, SegmentControl, StatStrip, toast } from "@nocoo/basalt";
import { BarChart } from "@nocoo/basalt/charts/bar";
import { DonutChart } from "@nocoo/basalt/charts/donut";
import { LineChart } from "@nocoo/basalt/charts/line";
import { chart } from "@nocoo/basalt/charts/palette";
import { StackedBarChart } from "@nocoo/basalt/charts/stacked-bar";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import { Activity } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { InsightsSkeleton } from "../components/layout/page-skeleton";
import { RefreshButton } from "../components/layout/refresh-button";
import { INLINE_SEGMENT } from "../components/layout/segment";
import { catchLoad, missingTitle } from "../lib/error-ui";
import {
	formatCount,
	formatDays,
	formatHealth,
	healthBadgeVariant,
	NUM_CELL,
	NUM_HEAD,
} from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import {
	alertsIncomplete,
	buildInsightsCharts,
	filterInsights,
	type Health,
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

function ChartCard({
	title,
	stats,
	children,
}: {
	title: string;
	stats: { label: string; value: string }[];
	children: ReactNode;
}) {
	return (
		<LayerCard>
			<LayerCard.Header>{title}</LayerCard.Header>
			<LayerCard.Body className="space-y-4">
				<StatStrip items={stats} />
				<div className="grid items-center gap-6 md:grid-cols-2">{children}</div>
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
	const [health, setHealth] = useState<Health | "all">("all");
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

	const rows = useMemo(() => {
		if (!board || "missing" in board) {
			return [];
		}
		return filterInsights(board.insights.insights, health);
	}, [board, health]);
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
						<SegmentControl
							legend="健康"
							className={INLINE_SEGMENT}
							value={health}
							onValueChange={(value) => setHealth(value as Health | "all")}
							options={[
								{ value: "all", label: "全部" },
								{ value: "strong", label: "健康" },
								{ value: "watch", label: "观察" },
								{ value: "risky", label: "风险" },
							]}
						/>
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
			<ChartCard
				title="跨仓工作量"
				stats={[
					{ label: "打开 Issues", value: formatCount(charts.issueCount) },
					{ label: "打开 PRs", value: formatCount(charts.prCount) },
					{
						label: "有 Issue 的仓",
						value: formatCount(charts.reposWithIssues + charts.reposWithBoth),
					},
					{ label: "有 PR 的仓", value: formatCount(charts.reposWithPrs + charts.reposWithBoth) },
				]}
			>
				{charts.workloadByRepo.length > 0 ? (
					<StackedBarChart
						data={charts.workloadByRepo}
						series={ISSUE_PR_SERIES}
						ariaLabel="issues and pull requests by repository"
						className="h-56 w-full"
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
						className="h-56 w-full"
						showLegend
						valueFormatter={formatCount}
					/>
				) : (
					<ChartEmpty label="没有仓库覆盖数据" />
				)}
			</ChartCard>
			<ChartCard
				title="审查与节奏"
				stats={[
					{ label: "草稿", value: formatCount(charts.draftCount) },
					{ label: "待审查", value: formatCount(charts.reviewRequiredCount) },
					{ label: "需修改", value: formatCount(charts.changesRequestedCount) },
					{ label: "已批准", value: formatCount(charts.approvedCount) },
				]}
			>
				{charts.prStatus.length > 0 ? (
					<DonutChart
						data={charts.prStatus}
						series={PR_STATUS_SERIES}
						ariaLabel="pull request review status"
						className="h-56 w-full"
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
					className="h-56 w-full"
					showAxes
					showLegend
					valueFormatter={formatCount}
				/>
			</ChartCard>
			<ChartCard
				title="健康与活跃"
				stats={[
					{ label: "健康", value: formatCount(charts.strongCount) },
					{ label: "观察", value: formatCount(charts.watchCount) },
					{ label: "风险", value: formatCount(charts.riskyCount) },
					{ label: "90 天未推送", value: formatCount(charts.staleCount) },
				]}
			>
				{charts.health.length > 0 ? (
					<DonutChart
						data={charts.health}
						series={HEALTH_SERIES}
						ariaLabel="repository health"
						className="h-56 w-full"
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
					className="h-56 w-full"
					showAxes
					showLegend
					valueFormatter={formatCount}
				/>
			</ChartCard>
			<LayerCard>
				<LayerCard.Well {...(rows.length === 0 ? {} : { className: "p-0" })}>
					{rows.length === 0 ? (
						<LayerCard.Empty icon={<Activity />} title="没有 Insights" />
					) : (
						<Table data-testid="insight-list">
							<TableHeader>
								<TableRow>
									<TableHead>仓库</TableHead>
									<TableHead>健康</TableHead>
									<TableHead className={NUM_HEAD}>Issues</TableHead>
									<TableHead className={NUM_HEAD}>距上次推送</TableHead>
									<TableHead>机会</TableHead>
									<TableHead>告警</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((row) => (
									<TableRow key={row.name_with_owner}>
										<TableCell>
											<Link href={`/repos/${row.name_with_owner}`}>{row.name_with_owner}</Link>
										</TableCell>
										<TableCell>
											<Badge variant={healthBadgeVariant(row.health)}>
												{formatHealth(row.health)}
											</Badge>
										</TableCell>
										<TableCell className={NUM_CELL}>{formatCount(row.open_issue_count)}</TableCell>
										<TableCell className={NUM_CELL}>{formatDays(row.days_since_push)}</TableCell>
										<TableCell>
											{row.opportunities.length === 0 ? (
												"—"
											) : (
												<div className="flex flex-wrap gap-1">
													{row.opportunities.map((item) => (
														<Badge key={item} variant="secondary">
															{item}
														</Badge>
													))}
												</div>
											)}
										</TableCell>
										<TableCell>
											{row.alerts.length === 0 ? (
												"—"
											) : (
												<div className="flex flex-col gap-1">
													{row.alerts.map((alert) => (
														<Link key={alert.url} href={alert.url} target="_blank" rel="noreferrer">
															{alert.summary}
														</Link>
													))}
												</div>
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</LayerCard.Well>
			</LayerCard>
		</div>
	);
}
