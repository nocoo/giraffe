import { Link, toast } from "@nocoo/basalt";
import { BarChart } from "@nocoo/basalt/charts/bar";
import { StackedBarChart } from "@nocoo/basalt/charts/stacked-bar";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import { Activity, GitPullRequest, Layers3 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CandyBadge } from "../components/layout/candy-badge";
import { ChartBrick, ChartEmpty, ChartRow } from "../components/layout/chart-brick";
import { SnapshotDescription } from "../components/layout/collection-chrome";
import { DonutChart } from "../components/layout/donut-chart";
import { IconLabel } from "../components/layout/icon-label";
import { InsightsSkeleton } from "../components/layout/page-skeleton";
import { ProjectLabel } from "../components/layout/project-identity";
import { SnapshotPending } from "../components/layout/snapshot-pending";
import { chartColor } from "../lib/chart-theme";
import { catchLoad } from "../lib/error-ui";
import { formatCount } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import {
	alertsIncomplete,
	buildInsightsCharts,
	healthTiles,
	type InsightsBoard,
	loadInsightsBoard,
} from "../viewmodels/insights";

const ISSUE_PR_SERIES = [
	{ key: "y" as const, label: "Issues", color: chartColor(0) },
	{ key: "y2" as const, label: "Pull Requests", color: chartColor(1) },
];

const COVERAGE_SERIES = [
	{ key: "仅 Issue", color: chartColor(0) },
	{ key: "仅 PR", color: chartColor(1) },
	{ key: "两者都有", color: chartColor(2) },
	{ key: "暂无", color: chartColor(3) },
];

const HEALTH_SERIES = [
	{ key: "健康", color: chartColor(2) },
	{ key: "观察", color: "var(--color-giraffe-yellow)" },
	{ key: "风险", color: "hsl(var(--basalt-accent-8))" },
];

const PR_STATUS_SERIES = [
	{ key: "草稿", color: chartColor(0) },
	{ key: "待审查", color: chartColor(3) },
	{ key: "需修改", color: chartColor(1) },
	{ key: "已批准", color: chartColor(2) },
	{ key: "未标记", color: chartColor(4) },
];

export function InsightsPage() {
	const [board, setBoard] = useState<InsightsBoard | { missing: true } | null>(null);

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
	const rest = charts?.workloadByRepo.find((p) => p.x === "其他");
	const tiles = useMemo(
		() => (board && !("missing" in board) ? healthTiles(board.insights.insights) : []),
		[board],
	);

	if (board && "missing" in board) {
		return (
			<div className="space-y-8">
				<PageHeader title="Insights" description={PAGE_DESCRIPTIONS["/insights"]} />
				<LayerCard>
					<LayerCard.Well>
						<SnapshotPending state={board} />
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
		<div className="giraffe-page-motion space-y-8">
			<PageHeader
				title="Insights"
				description={
					<SnapshotDescription
						description={PAGE_DESCRIPTIONS["/insights"]}
						fetchedAt={board.insights.fetched_at}
					/>
				}
				actions={
					<>
						{board.insights.truncated ? <CandyBadge tone="amber">已截断</CandyBadge> : null}
						{incomplete ? (
							<span role="note" className="text-xs text-basalt-muted-foreground">
								可选安全告警未完整获取
							</span>
						) : null}
					</>
				}
			/>
			<SectionRule title={<IconLabel icon={Layers3}>工作量</IconLabel>}>
				<div className="space-y-3" data-testid="insight-metrics">
					<p className="giraffe-stat-inline">
						<span>
							<strong>{formatCount(charts.issueCount)}</strong>个 open Issue ·{" "}
							<strong>{formatCount(charts.reposWithIssues + charts.reposWithBoth)}</strong>个仓库
						</span>
						<span>
							<strong>{formatCount(charts.prCount)}</strong>个 open PR ·{" "}
							<strong>{formatCount(charts.reposWithPrs + charts.reposWithBoth)}</strong>个仓库
						</span>
						<span>
							<strong>{formatCount(charts.reposQuiet)}</strong>个仓库无待办
						</span>
					</p>
					<ChartRow>
						<ChartBrick
							title="仓内 Issue / PR"
							description="当前 open Issue 与 PR 最多的 8 个仓库；其余仓库合计见下方说明。"
						>
							{charts.workloadByRepo.length > 0 ? (
								<>
									<StackedBarChart
										data={charts.workloadByRepo.filter((p) => p.x !== "其他")}
										series={ISSUE_PR_SERIES}
										ariaLabel="issues and pull requests by repository"
										className="h-56 w-full"
										showAxes
										showLegend
										valueFormatter={formatCount}
									/>
									{rest ? (
										<p className="mt-2 text-xs text-basalt-muted-foreground">
											其余仓库合计 {formatCount((rest.y ?? 0) + (rest.y2 ?? 0))} 项（Issue{" "}
											{formatCount(rest.y ?? 0)} · PR {formatCount(rest.y2 ?? 0)}）
										</p>
									) : null}
								</>
							) : (
								<ChartEmpty label="没有打开的 Issue 或 Pull Request" />
							)}
						</ChartBrick>
						<ChartBrick title="仓库覆盖" description="哪些仓库有待处理的 Issue 或 Pull Request">
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
						</ChartBrick>
					</ChartRow>
				</div>
			</SectionRule>
			<SectionRule title={<IconLabel icon={GitPullRequest}>审查与节奏</IconLabel>}>
				<div className="space-y-3">
					<p className="giraffe-stat-inline">
						<span>
							草稿 <strong>{formatCount(charts.draftCount)}</strong>
						</span>
						<span>
							待审查 <strong>{formatCount(charts.reviewRequiredCount)}</strong>
						</span>
						<span>
							需修改 <strong>{formatCount(charts.changesRequestedCount)}</strong>
						</span>
						<span>
							已批准 <strong>{formatCount(charts.approvedCount)}</strong>
						</span>
					</p>
					<ChartRow>
						<ChartBrick
							title="近 8 周新建"
							description="当前打开的 Issue 与 Pull Request 的创建时间"
						>
							<BarChart
								data={charts.activity}
								series={ISSUE_PR_SERIES}
								ariaLabel="issues and pull requests opened by week"
								className="h-56 w-full"
								showAxes
								showLegend
								valueFormatter={formatCount}
							/>
						</ChartBrick>
						<ChartBrick title="PR 状态" description="草稿、待审查、需修改、已批准与未标记">
							{charts.prStatus.length > 0 ? (
								<DonutChart
									data={charts.prStatus}
									series={PR_STATUS_SERIES}
									ariaLabel="pull request review status"
									summary={
										<span className="sr-only">
											{charts.prStatus
												.map((item) => `${item.name} ${formatCount(item.value)} 个`)
												.join("，")}
										</span>
									}
									className="h-56 w-full"
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
			<SectionRule title={<IconLabel icon={Activity}>健康与活跃</IconLabel>}>
				<div className="space-y-3">
					<p className="giraffe-stat-inline">
						<span>
							健康 <strong>{formatCount(charts.strongCount)}</strong>
						</span>
						<span>
							观察 <strong>{formatCount(charts.watchCount)}</strong>
						</span>
						<span>
							风险 <strong>{formatCount(charts.riskyCount)}</strong>
						</span>
						<span>
							90 天以上未推送 <strong>{formatCount(charts.staleCount)}</strong>
						</span>
					</p>
					<ChartBrick
						title="仓库健康地图"
						description="每个方块是一个参与统计的仓库，风险在前。颜色表示健康状态，方块内是距最近推送天数；悬停查看触发的规则，点击打开仓库。"
					>
						<HealthMap tiles={tiles} />
					</ChartBrick>
					<ChartRow>
						<ChartBrick title="距上次推送" description="以数据更新时间为基准，单位为天">
							<BarChart
								data={charts.freshness}
								series={[{ key: "y", label: "仓库数", color: chartColor(0) }]}
								ariaLabel="days since last push"
								className="h-56 w-full"
								showAxes
								showLegend
								valueFormatter={formatCount}
							/>
						</ChartBrick>
						<ChartBrick title="健康分布" description="当前可见仓库的健康状态">
							{charts.health.length > 0 ? (
								<DonutChart
									data={charts.health}
									series={HEALTH_SERIES}
									ariaLabel="repository health"
									summary={
										<span className="sr-only">
											{charts.health
												.map((item) => `${item.name} ${formatCount(item.value)} 个`)
												.join("，")}
										</span>
									}
									className="h-56 w-full"
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

const HEALTH_LABEL = { strong: "健康", watch: "观察", risky: "风险" } as const;
function HealthMap({ tiles }: { tiles: ReturnType<typeof healthTiles> }) {
	if (!tiles.length) return <ChartEmpty label="没有健康数据" />;
	return (
		<ul className="giraffe-health-map" aria-label="仓库健康地图">
			{tiles.map((t, i) => {
				const detail = `${HEALTH_LABEL[t.health]}，${t.days} 天前推送${t.reasons.length ? `，${t.reasons.join("，")}` : ""}`;
				return (
					<li
						key={t.name}
						data-health={t.health}
						title={`${t.name} · ${detail}`}
						style={{ animationDelay: `${Math.min(i, 40) * 12}ms` }}
					>
						<Link className="giraffe-health-tile" href={`/repos/${t.name}`}>
							<ProjectLabel repo={t.name} short />
							<small>
								{t.days === 0 ? "今天" : `${t.days} 天`}
								{t.reasons.length ? ` · ${t.reasons[0]}` : ""}
							</small>
							<span className="sr-only">{detail}</span>
						</Link>
					</li>
				);
			})}
		</ul>
	);
}
